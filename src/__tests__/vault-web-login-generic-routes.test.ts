// VAULTLOGIN1112: a web login's password (web-login-<id>) is typed by the dashboard's filler only. Every generic vault
// path refuses it, for the owner lane too: the value route, resolve, the list, the generic write routes and a binding.
// The audit row of a refused read is kept, the value is never even decrypted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const STORE = mkdtempSync(join(tmpdir(), 'vault-weblogin-generic-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE }))
const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

const ID = 'web-login-shop-example-com'
const PASSWORD = 'the-site-password-7f3a'
const reads: string[] = []
const writes: string[] = []
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [{ id: ID, label: 'Web login', createdAt: '', updatedAt: '' }, { id: 'PLAIN', label: 'p', createdAt: '', updatedAt: '' }],
  setSecret: (id: string) => { writes.push(id) },
  deleteSecret: (id: string) => { writes.push(`delete:${id}`); return true },
  updateSecretLabel: (id: string) => { writes.push(`label:${id}`); return true },
  getSecret: (id: string) => { reads.push(id); return id === ID ? PASSWORD : 'plain' },
  getSecretsForEnv: () => ({}),
  normalizeVaultLabel: (_i: string, l: string) => l,
  VAULT_LABEL_MAX_LENGTH: 200,
}))

const { tryHandleConnectors } = await import('../web/routes/connectors.js')

type Auth = RouteContext['auth']
const OWNER: Auth = { kind: 'session', user: 'owner' }
const AGENT: Auth = { kind: 'token', agent: 'geri' }

async function call(method: string, path: string, auth: Auth, body?: unknown) {
  const res = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    writeHead(c: number) { res.statusCode = c },
    end(b?: string) { res.body = b ?? '' },
    setHeader(k: string, v: string) { res.headers[k] = v },
    getHeader(k: string) { return res.headers[k] },
  }
  const req = (body !== undefined ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([])) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method, url: path })
  await tryHandleConnectors({ req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth } as RouteContext)
  return res
}

beforeEach(() => { reads.length = 0; writes.length = 0; logSpy.info.mockClear() })

describe('the generic vault routes refuse a web-login password', () => {
  it.each([['the owner', OWNER], ['an agent', AGENT]])('the value route: 403 for %s, nothing decrypted, the attempt is logged', async (_l, auth) => {
    const r = await call('GET', `/api/vault/${ID}`, auth)
    expect(r.statusCode).toBe(403)
    expect(r.body).not.toContain(PASSWORD)
    expect(reads).not.toContain(ID)
    expect(logSpy.info.mock.calls.map((c) => c[0]).find((f) => f?.event === 'vault-read')).toMatchObject({ id: ID, refused: true })
  })

  it('resolve: refused with reason web-login, nothing decrypted', async () => {
    const r = await call('POST', '/api/vault/resolve', OWNER, { ids: [ID, 'PLAIN'] })
    const out = JSON.parse(r.body) as { values: Record<string, string>; refused: Array<{ id: string; reason: string }> }
    expect(out.refused).toEqual([{ id: ID, reason: 'web-login' }])
    expect(out.values).toEqual({ PLAIN: 'plain' })
    expect(r.body).not.toContain(PASSWORD)
    expect(reads).not.toContain(ID)
  })

  it('the list hides it', async () => {
    const r = await call('GET', '/api/vault', OWNER)
    expect((JSON.parse(r.body) as { secrets: Array<{ id: string }> }).secrets.map((s) => s.id)).toEqual(['PLAIN'])
  })

  it.each([
    ['POST', '/api/vault', { id: ID, value: 'overwrite', label: 'x' }],
    ['PATCH', `/api/vault/${ID}`, { label: 'x' }],
    ['DELETE', `/api/vault/${ID}`, undefined],
  ])('%s %s: 403, nothing written', async (method, path, body) => {
    const r = await call(method, path, OWNER, body)
    expect(r.statusCode).toBe(403)
    expect(writes).toEqual([])
  })

  it('a binding to an env var or a header is refused', async () => {
    for (const b of [{ vaultSecretId: ID, envVar: 'SITE_PASSWORD' }, { vaultSecretId: ID, headerName: 'Authorization' }]) {
      const r = await call('POST', '/api/vault/bindings', OWNER, b)
      expect(r.statusCode).toBe(400)
      expect(JSON.parse(r.body).error).toBe('Web login passwords cannot be bound to an env var or a header')
    }
    expect(reads).not.toContain(ID)
  })
})
