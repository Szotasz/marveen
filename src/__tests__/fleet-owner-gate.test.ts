// FLEETIMPORTGATE1022: once a dashboard login exists, an applied fleet import and an export
// with the vault take the owner's session. The shared token reaches /api/fleet/* from every
// agent: an applied import overwrites store/autonomy-config.json (email_send to 3 switches the
// mail approval gate off) and an export with a vault password returns the vault's master key
// and every secret under a password the caller chose. The dry run and the plain export stay
// on the token; the token keeps everything only for the first-run setup (no user yet).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const h = vi.hoisted(() => ({
  imports: [] as Array<{ raw: string; apply: boolean; vaultPassword?: string }>,
  exports: [] as Array<{ vaultPassword?: string }>,
}))
vi.mock('../web/fleet-transfer.js', async (orig) => {
  const real = await orig<typeof import('../web/fleet-transfer.js')>()
  return {
    ...real,
    importFleet: (raw: string, options: { vaultPassword?: string; apply: boolean }) => {
      h.imports.push({ raw, ...options })
      return options.apply ? { applied: true, warnings: [] } : { dryRun: true, errors: [], warnings: [] }
    },
    exportFleet: (options: { vaultPassword?: string } = {}) => {
      h.exports.push(options)
      return { data: '{}', exportedAt: '2026-10-27T00:00:00.000Z' }
    },
  }
})

import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleFleet } from '../web/routes/fleet.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const DEVICE_AUTH: RouteContext['auth'] = { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }
const VAULT_PW = 'a-long-vault-password'
const FLEET_BODY = JSON.stringify({ schemaVersion: 1, dashboardSettings: { autonomy: { categories: [{ key: 'email_send', level: 3 }] } } })

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as http.IncomingMessage
  req.headers = headers
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

const applyImport = (auth: RouteContext['auth'], headers: Record<string, string> = {}) =>
  call(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', auth, FLEET_BODY, headers)
const dryRun = (auth: RouteContext['auth']) => call(tryHandleFleet, 'POST', '/api/fleet/import', auth, FLEET_BODY)
const exportWithVault = (auth: RouteContext['auth'], headers: Record<string, string> = {}) =>
  call(tryHandleFleet, 'GET', '/api/fleet/export', auth, undefined, { 'x-vault-password': VAULT_PW, ...headers })
const plainExport = (auth: RouteContext['auth']) => call(tryHandleFleet, 'GET', '/api/fleet/export', auth)
const addUser = (auth: RouteContext['auth'], username: string) =>
  call(tryHandleAuth, 'POST', '/api/auth/users', auth, JSON.stringify({ username, password: 'super-secret-pw' }))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  h.imports = []
  h.exports = []
})

describe('first-run setup (no dashboard user yet): the token still imports and exports', () => {
  it('applies an import and exports with the vault', async () => {
    expect((await applyImport(TOKEN_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: true, vaultPassword: undefined }])
    expect((await exportWithVault(TOKEN_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: VAULT_PW }])
  })
})

describe('once a login exists, the token cannot apply an import or export the vault', () => {
  beforeEach(async () => {
    expect((await addUser(TOKEN_AUTH, 'owner')).status).toBe(201)
  })

  it('an applied import is refused before anything is imported', async () => {
    const r = await applyImport(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.imports).toEqual([])
  })

  it('an export with a vault password is refused before anything is exported', async () => {
    const r = await exportWithVault(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.exports).toEqual([])
  })

  it('a full device key is refused too (it never was the owner)', async () => {
    expect((await applyImport(DEVICE_AUTH)).status).toBe(403)
    expect((await exportWithVault(DEVICE_AUTH)).status).toBe(403)
    expect(h.imports).toEqual([])
    expect(h.exports).toEqual([])
  })

  it('the dry run and the plain export stay on the token (nothing written, no secret)', async () => {
    expect((await dryRun(TOKEN_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: false, vaultPassword: undefined }])
    expect((await plainExport(TOKEN_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: undefined }])
  })

  it('the owner session applies and exports', async () => {
    expect((await applyImport(SESSION_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: true, vaultPassword: undefined }])
    expect((await exportWithVault(SESSION_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: VAULT_PW }])
  })

  it("the owner's browser that also keeps the token: a valid session cookie alongside it is the owner", async () => {
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    expect((await applyImport(TOKEN_AUTH, { cookie })).status).toBe(200)
    expect((await exportWithVault(TOKEN_AUTH, { cookie })).status).toBe(200)
    expect(h.imports).toHaveLength(1)
    expect(h.exports).toHaveLength(1)
  })
})
