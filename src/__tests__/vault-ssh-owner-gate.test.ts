// VAULTSSHOWNER1109: writing an SSH server entry or an SSH key in the vault is an owner action (mayActAsOwner),
// checked before the request body is read. Reading (the lists, a public key) stays on the access token.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser, createDashboardUser } from '../db.js'
import { tryHandleVaultSsh } from '../web/routes/vault-ssh.js'
import { tryHandleVaultSshKeys } from '../web/routes/vault-ssh-keys.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN: RouteContext['auth'] = { kind: 'token' }
const SUB_AGENT: RouteContext['auth'] = { kind: 'token', agent: 'helper', tokenAgent: 'helper' }
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', ...headers }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string | Buffer) { if (d !== undefined) out.body += d.toString() },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

function ownerCookie(): string {
  const u = getDashboardUser('owner') ?? createDashboardUser('owner', 'x-not-a-real-hash')
  return `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
}

const WRITES: Array<[string, Handler, string, string]> = [
  ['add a server', tryHandleVaultSsh, 'POST', '/api/vault/ssh-servers'],
  ['change a server', tryHandleVaultSsh, 'PUT', '/api/vault/ssh-servers/999999'],
  ['remove a server', tryHandleVaultSsh, 'DELETE', '/api/vault/ssh-servers/999999'],
  ['generate a server key', tryHandleVaultSsh, 'POST', '/api/vault/ssh-servers/999999/generate-key'],
  ['create a key', tryHandleVaultSshKeys, 'POST', '/api/vault/ssh-keys'],
  ['import a key', tryHandleVaultSshKeys, 'POST', '/api/vault/ssh-keys/import'],
  ['delete a key', tryHandleVaultSshKeys, 'DELETE', '/api/vault/ssh-keys/ssh-key-does-not-exist'],
]

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
})

describe('vault SSH writes are the owner\'s', () => {
  // An unparseable body: a handler that read it would answer 400 or throw, so a clean 403 shows the refusal came first.
  it.each(WRITES)('%s: the access token gets 403, before the body is read', async (_l, handler, method, path) => {
    const r = await call(handler, method, path, TOKEN, '{not json')
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
  })

  it.each(WRITES)('%s: a sub-agent token gets 403 even beside an owner cookie', async (_l, handler, method, path) => {
    expect((await call(handler, method, path, SUB_AGENT, '{}', { cookie: ownerCookie() })).status).toBe(403)
  })

  it.each(WRITES)('%s: the owner passes the gate (the handler answers on its own terms)', async (_l, handler, method, path) => {
    const asSession = await call(handler, method, path, SESSION, '{}')
    expect(asSession.json().code).not.toBe('owner_session_required')
    expect(asSession.status).not.toBe(403)
    const viaCookie = await call(handler, method, path, TOKEN, '{}', { cookie: ownerCookie() })
    expect(viaCookie.json().code).not.toBe('owner_session_required')
  })

  it('reading stays on the access token', async () => {
    expect((await call(tryHandleVaultSsh, 'GET', '/api/vault/ssh-servers', TOKEN)).status).toBe(200)
    expect((await call(tryHandleVaultSshKeys, 'GET', '/api/vault/ssh-keys', TOKEN)).status).toBe(200)
  })
})
