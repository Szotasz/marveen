// DEVKEYMINT1022: once a dashboard login exists, issuing a credential (a device key,
// a Bridge pairing) and adding or removing a dashboard user take the owner's
// session; the bearer token keeps them only for the first-run setup (no user yet).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleSecurity } from '../web/routes/security.js'
import { createDeviceKey, listDeviceKeys, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = 'b'.repeat(64)
const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const GOOD_PW = 'super-secret-pw'

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth })).toBe(true)
  return { status: out.status, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}
const mint = (auth: RouteContext['auth'], name = 'agent-made', headers: Record<string, string> = {}) => call(tryHandleAuth, 'POST', '/api/auth/device-keys', auth, { name }, headers)
const addUser = (auth: RouteContext['auth'], username: string) => call(tryHandleAuth, 'POST', '/api/auth/users', auth, { username, password: GOOD_PW })
const pair = (auth: RouteContext['auth']) => call(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', auth, { key_line: 'x', name: '' })

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
})

describe('first-run setup (no dashboard user yet): the token is the one credential there is', () => {
  it('the token creates the first user, mints a key, and reaches Bridge pairing', async () => {
    expect((await mint(TOKEN_AUTH)).status).toBe(201)
    // the pairing gate lets it through to input validation (400 on the empty name)
    expect((await pair(TOKEN_AUTH)).status).toBe(400)
    expect((await addUser(TOKEN_AUTH, 'owner')).status).toBe(201)
  })
})

describe('once a login exists, the token cannot issue or manage access', () => {
  beforeEach(async () => {
    expect((await addUser(TOKEN_AUTH, 'owner')).status).toBe(201)
  })

  it('a real Bearer token caller gets 403 on minting, and no key is written', async () => {
    const auth = resolveAuth({ headers: { authorization: `Bearer ${TOKEN}` } } as http.IncomingMessage,
      new URL('http://127.0.0.1:3420/api/auth/device-keys'), '/api/auth/device-keys', 'POST', TOKEN)
    expect(auth.kind).toBe('token')
    const r = await mint(auth as RouteContext['auth'])
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('the token cannot add or remove a user', async () => {
    expect((await addUser(TOKEN_AUTH, 'mallory')).status).toBe(403)
    expect(getDashboardUser('mallory')).toBeUndefined()
    expect((await call(tryHandleAuth, 'DELETE', '/api/auth/users/owner', TOKEN_AUTH)).status).toBe(403)
    expect(getDashboardUser('owner')).toBeDefined()
  })

  it('the token cannot pair a Bridge: refused before the body is even read', async () => {
    const r = await pair(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
  })

  it('a disabled account still counts as a login: the token stays refused', async () => {
    getDb().exec("UPDATE dashboard_users SET disabled = 1")
    expect((await mint(TOKEN_AUTH)).status).toBe(403)
    expect((await addUser(TOKEN_AUTH, 'mallory')).status).toBe(403)
  })

  it('the owner session still issues and manages (positive control)', async () => {
    const r = await mint(SESSION_AUTH, 'phone')
    expect(r.status).toBe(201)
    expect(r.json().scope).toBe('full')
    expect((await addUser(SESSION_AUTH, 'second')).status).toBe(201)
    expect((await call(tryHandleAuth, 'DELETE', '/api/auth/users/second', SESSION_AUTH)).status).toBe(200)
    expect((await pair(SESSION_AUTH)).status).toBe(400)
  })

  it('listing and revoking keys stay open to the token: they grant nothing', async () => {
    const k = createDeviceKey('existing')
    expect((await call(tryHandleAuth, 'GET', '/api/auth/device-keys', TOKEN_AUTH)).status).toBe(200)
    expect((await call(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${k.id}`, TOKEN_AUTH)).status).toBe(200)
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('the owner\'s browser that also keeps the token: a valid session cookie alongside it is the owner', async () => {
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    expect((await mint(TOKEN_AUTH, 'phone', { cookie })).status).toBe(201)
    // a made-up cookie value is not a session
    expect((await mint(TOKEN_AUTH, 'phone2', { cookie: `${SESSION_COOKIE_NAME}=forged` })).status).toBe(403)
    expect(listDeviceKeys().map((k) => k.name)).toEqual(['phone'])
  })

  it('a device key never issues further keys (unchanged)', async () => {
    expect((await mint({ kind: 'device', device: 'x', deviceId: 1, scope: 'full' })).status).toBe(403)
  })
})
