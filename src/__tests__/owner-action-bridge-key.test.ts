// BRIDGEPWLOGIN1101 PR-1 (Samu 65617, Dani 65623): an owner action that issues no credential takes a FULL device key
// (the Bridge) sent alongside a valid owner session cookie. The cookie is the owner's proof; the key must not hide it.
// Credential issuance followed in PR-2; OWNERGATE4-1104 removed mayIssueCredentials and made mayActAsOwner the one strict
// owner gate (first-run setup only through mayActAsOwnerOrFirstRun). Real resolveAuth, real sessions, real device keys.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
// Routes that write (operator access) write into a throwaway store, never the checkout's.
const TMP_STORE = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (orig) => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  TMP_STORE.dir = mk(j(td(), 'owner-action-store-'))
  return { ...(await orig<typeof import('../config.js')>()), STORE_DIR: TMP_STORE.dir }
})
import { initDatabase, getDb, getDashboardUser, getRecentConfigChanges } from '../db.js'
import { resolveAuth, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import * as authModule from '../web/routes/auth.js'
import { bridgeOwner, FIRST_RUN_PATHS, mayActAsOwner, mayActAsOwnerOrFirstRun, ownerCookieSession, tryHandleAuth } from '../web/routes/auth.js'
import { isOwnerSession } from '../web/routes/gromzo.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleFleetFreeze } from '../web/routes/fleet-freeze.js'
import { tryHandleSecurity } from '../web/routes/security.js'
import { tryHandleOperatorAccess } from '../web/routes/operator-access.js'
import { tryHandleOnboarding } from '../web/routes/onboarding.js'
import { tryHandleClaudePlansLogin } from '../web/routes/claude-plans-login.js'
import { createDeviceKey, getDeviceKey, revokeDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { _clearSessionCacheForTest, createSession, revokeSession } from '../web/auth-sessions.js'
import { logger } from '../logger.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = 'c'.repeat(64)
const ROOT = join(__dirname, '..', '..')

function reqWith(headers: Record<string, string>, path = '/api/skills/pending/x/approve', method = 'POST', body?: unknown): http.IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  return req
}
function authOf(req: http.IncomingMessage, path = '/api/skills/pending/x/approve', method = 'POST'): RouteContext['auth'] {
  return resolveAuth(req, new URL(`http://127.0.0.1:3420${path}`), path, method, TOKEN) as RouteContext['auth']
}
let cookie = ''
let ownerId = 0
const cookieHeader = () => `${SESSION_COOKIE_NAME}=${cookie}`
const keyOf = (scope: 'full' | 'operator' = 'full') => createDeviceKey(scope === 'full' ? 'Bridge' : 'Op', scope === 'operator' ? { scope, expiresInDays: 7 } : {}).key

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM device_keys')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  const out = { status: 0 }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end() {} }
  const url = new URL('http://127.0.0.1:3420/api/auth/users')
  await tryHandleAuth({ req: reqWith({}, '/api/auth/users', 'POST', { username: 'owner', password: 'super-secret-pw' }), res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as RouteContext)
  expect(out.status).toBe(201)
  ownerId = getDashboardUser('owner')!.id
  cookie = createSession({ userId: ownerId, username: 'owner' })
})

describe('the predicate (the five-case matrix, Samu 65617, and Dani 65623 (c))', () => {
  it('B1: a full key with a valid owner cookie is the owner; the audit line names the session user', () => {
    const spy = vi.spyOn(logger, 'info')
    const req = reqWith({ authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() })
    const auth = authOf(req)
    expect(auth?.kind).toBe('device')
    expect(mayActAsOwner(auth, req)).toBe(true)
    const line = spy.mock.calls.find((c) => String(c[1]).includes('owner action on a Bridge key'))
    expect(line?.[0]).toMatchObject({ owner: 'owner', auth: 'device', device: 'Bridge', path: '/api/skills/pending/x/approve' })
    spy.mockRestore()
  })

  it('B2: a full key without a cookie is refused', () => {
    const req = reqWith({ authorization: `Bearer ${keyOf()}` })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
  })

  it('B3: a full key with a logged-out, an expired or an unknown cookie is refused', () => {
    const key = keyOf()
    revokeSession(cookie)
    let req = reqWith({ authorization: `Bearer ${key}`, cookie: cookieHeader() })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
    cookie = createSession({ userId: ownerId, username: 'owner' })
    getDb().exec(`UPDATE auth_sessions SET created_at = created_at - ${31 * 24 * 3600}`)
    _clearSessionCacheForTest()
    req = reqWith({ authorization: `Bearer ${key}`, cookie: cookieHeader() })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
    req = reqWith({ authorization: `Bearer ${key}`, cookie: `${SESSION_COOKIE_NAME}=not-a-session` })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
  })

  it('B4: an operator key with a valid cookie is refused', () => {
    const req = reqWith({ authorization: `Bearer ${keyOf('operator')}`, cookie: cookieHeader() })
    const auth = authOf(req)
    expect(auth).toMatchObject({ kind: 'device', scope: 'operator' })
    expect(mayActAsOwner(auth, req)).toBe(false)
  })

  it('B5: a sub-agent token with a valid cookie is refused; the shared token with it stays the owner', () => {
    const req = reqWith({ cookie: cookieHeader() })
    expect(mayActAsOwner({ kind: 'token', agent: 'zara', tokenAgent: 'zara' }, req)).toBe(false)
    expect(mayActAsOwner({ kind: 'token' }, req)).toBe(true)
    expect(mayActAsOwner({ kind: 'token' }, reqWith({}))).toBe(false)
  })

  // OWNERGATE4-1104: flipped; before the first login the bare token is no longer the owner either (mayActAsOwner), and
  // the first-run setup takes a bare full key only for creating the first login (the Bridge window holds no token).
  it('B6: before the first login a bare full key and the bare token are refused by mayActAsOwner; the key passes only first-login', () => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    const req = reqWith({ authorization: `Bearer ${keyOf()}` })
    const auth = authOf(req)
    expect(mayActAsOwner(auth, req)).toBe(false)
    expect(mayActAsOwner({ kind: 'token' }, req)).toBe(false)
    for (const why of FIRST_RUN_PATHS) expect([why, mayActAsOwnerOrFirstRun(auth, req, why)]).toEqual([why, why === 'first-login'])
  })

  // OWNERGATE4-1104: mayIssueCredentials is gone (one owner gate now), so B7 pins its absence instead of its refusal.
  it('B7: mayIssueCredentials is no longer exported; isOwnerSession reads the same cookie branch', () => {
    const req = reqWith({ authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() })
    const auth = authOf(req)
    expect('mayIssueCredentials' in authModule).toBe(false)
    expect('mayActAsOwnerStrict' in authModule).toBe(false)
    expect(isOwnerSession(auth, req)).toBe(true)
    expect(ownerCookieSession(req)).toBe('owner')
    revokeSession(cookie)
    expect(isOwnerSession(auth, req)).toBe(false)
    expect(ownerCookieSession(req)).toBe(null)
  })

  // Today's behaviour, card AUTHBEARERFALLBACK1101 (Ábel 65759, Dani 65764): measured, not changed here. A key that no
  // longer resolves falls through to the cookie in the gate, so the request IS the session; the cookie alone carries
  // exactly this right. The fix of that card turns this test around on purpose.
  it('B8 (today, card AUTHBEARERFALLBACK1101): a revoked key beside a valid cookie resolves as the session itself', () => {
    const minted = createDeviceKey('Gone')
    revokeDeviceKey(minted.id)
    _clearDeviceKeyCacheForTest()
    const req = reqWith({ authorization: `Bearer ${minted.key}`, cookie: cookieHeader() })
    expect(authOf(req)).toMatchObject({ kind: 'session', user: 'owner' })
  })

  // Today's behaviour, card SESSIONDISABLED1101 (Dani 65764): latent, no code path disables a user. resolveSession does
  // not read `disabled`, so a disabled user's cookie still counts. The fix of that card (a blocker of any user-disable
  // feature) turns this test around on purpose.
  it('B9 (today, card SESSIONDISABLED1101): a disabled user\'s cookie beside a full key still counts', () => {
    getDb().exec('UPDATE dashboard_users SET disabled = 1')
    _clearSessionCacheForTest()
    const req = reqWith({ authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() })
    expect(mayActAsOwner(authOf(req), req)).toBe(true)
  })
})

// OWNERGATE2-1104 (review finding): the owner gate without the first-run branch. OWNERGATE4-1104: that is mayActAsOwner
// itself now (mayActAsOwnerStrict is gone); the zero-users row passes only mayActAsOwnerOrFirstRun.
describe('mayActAsOwner (strict since OWNERGATE4-1104)', () => {
  const zeroUsers = () => { getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users'); _clearSessionCacheForTest() }
  it('a session principal is the owner', () => {
    expect(mayActAsOwner({ kind: 'session', user: 'owner' } as RouteContext['auth'], reqWith({}))).toBe(true)
  })
  it('the shared token without a cookie is refused, also with zero dashboard users (where only mayActAsOwnerOrFirstRun lets it through)', () => {
    expect(mayActAsOwner({ kind: 'token' }, reqWith({}))).toBe(false)
    zeroUsers()
    expect(mayActAsOwner({ kind: 'token' }, reqWith({}))).toBe(false)
    expect(mayActAsOwnerOrFirstRun({ kind: 'token' }, reqWith({}), 'agent-create')).toBe(true)
  })
  it('the shared token with the owner cookie is the owner; a sub-agent token with it is not', () => {
    const req = reqWith({ cookie: cookieHeader() })
    expect(mayActAsOwner({ kind: 'token' }, req)).toBe(true)
    expect(mayActAsOwner({ kind: 'token', agent: 'zara', tokenAgent: 'zara' }, req)).toBe(false)
  })
  it('a full key with the owner cookie is the owner, with the audit line naming the owner', () => {
    const spy = vi.spyOn(logger, 'info')
    const req = reqWith({ authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() })
    expect(mayActAsOwner(authOf(req), req)).toBe(true)
    const line = spy.mock.calls.find((c) => String(c[1]).includes('owner action on a Bridge key'))
    expect(line?.[0]).toMatchObject({ owner: 'owner', auth: 'device', device: 'Bridge' })
    spy.mockRestore()
  })
  it('a bare full key is refused (with and without dashboard users); an operator key with the cookie is refused', () => {
    const key = keyOf()
    let req = reqWith({ authorization: `Bearer ${key}` })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
    req = reqWith({ authorization: `Bearer ${keyOf('operator')}`, cookie: cookieHeader() })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
    zeroUsers()
    req = reqWith({ authorization: `Bearer ${key}` })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
  })
  it('no principal is refused', () => {
    expect(mayActAsOwner(undefined as RouteContext['auth'], reqWith({ cookie: cookieHeader() }))).toBe(false)
  })
})

// OWNERGATE4-1104: one owner gate (mayActAsOwner, strict) and the closed first-run list (mayActAsOwnerOrFirstRun); the
// per-call `why` is pinned in owner-gate-first-run-pin.test.ts. These counts moved with the merge of the two predicates.
describe('which call site asks which predicate (source pin, every route file)', () => {
  const src = (f: string) => readFileSync(join(ROOT, 'src', 'web', 'routes', f), 'utf-8')
  const count = (f: string, fn: string) => (src(f).match(new RegExp(`${fn}\\((?:ctx\\.auth|auth), `, 'g')) ?? []).length
  it('the non-issuing owner actions take the Bridge key beside the cookie', () => {
    for (const [f, n] of [['approvals.ts', 2], ['skills.ts', 2], ['federation.ts', 1], ['autonomy.ts', 1], ['fleet-freeze.ts', 1], ['fleet.ts', 2], ['settings.ts', 1]] as const) {
      expect([f, count(f, 'mayActAsOwner'), count(f, 'mayActAsOwnerOrFirstRun')]).toEqual([f, n, 0])
    }
  })
  it('credential issuance: the owner gate, and the first-run setup only for the first login, the first device and the onboarding', () => {
    // auth.ts mayActAsOwner: users list, key revoke, user delete, and the one inside mayActAsOwnerOrFirstRun;
    // first-run: the first user and the first key mint.
    for (const [f, n, first] of [['auth.ts', 4, 2], ['security.ts', 0, 1], ['operator-access.ts', 1, 0], ['onboarding.ts', 1, 2], ['claude-plans-login.ts', 1, 1]] as const) {
      expect([f, count(f, 'mayActAsOwner'), count(f, 'mayActAsOwnerOrFirstRun')]).toEqual([f, n, first])
    }
  })
  it('the kind gates in front of issuance let only the Bridge owner through as a device (and a full key for the first login)', () => {
    expect((src('auth.ts').match(/kindAllowed\(auth, (?:USER|DEVICE_KEY)_ADMIN_KINDS\) && !bridgeOwner\(auth, req\)/g) ?? []).length).toBe(6)
    expect((src('auth.ts').match(/kindAllowed\(auth, (?:USER|DEVICE_KEY)_ADMIN_KINDS\)\) \{/g) ?? []).length).toBe(0)
    expect(src('auth.ts')).toContain('!bridgeOwner(auth, req) && !firstLoginKey)')
    expect(src('security.ts')).toContain('!bridgeOwner(auth, req)')
    expect(src('operator-access.ts')).toContain('!bridgeOwner(auth, req)')
  })
  it('the agent, channel, plan, provider and connector gates take the owner gate; only agent create, channel setup and a channel\'s first pairing approve take the first-run setup', () => {
    for (const [f, owner, first] of [['agents.ts', 20, 3], ['connectors.ts', 9, 0], ['claude-plans.ts', 3, 0], ['custom-providers.ts', 1, 0], ['agent-terminal.ts', 3, 0]] as const) {
      expect([f, count(f, 'mayActAsOwner'), count(f, 'mayActAsOwnerOrFirstRun')]).toEqual([f, owner, first])
    }
    expect(src('agents.ts')).toContain("firstPairing ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'first-pairing') : mayActAsOwner(ctx.auth, req)")
  })
})

describe('on the real routes', () => {
  type Handler = (ctx: RouteContext) => Promise<boolean>
  async function hit(handler: Handler, method: string, path: string, headers: Record<string, string>, body?: unknown) {
    const req = reqWith(headers, path, method, body)
    const out = { status: 0, body: '' }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(d?: string) { if (d !== undefined) out.body += d } }
    const url = new URL(`http://127.0.0.1:3420${path}`)
    expect(await handler({ req, res, path: url.pathname, method, url, auth: authOf(req, path, method) } as RouteContext)).toBe(true)
    let code: unknown
    try { code = JSON.parse(out.body || '{}').code } catch { code = undefined }
    return { status: out.status, code }
  }
  const refusedByOwnerGate = (r: { status: number, code: unknown }) => r.status === 403 && r.code === 'owner_session_required'

  it('R1: a skill decision: key + cookie passes the owner gate (then 404, no such pending skill); the key alone is 403', async () => {
    const key = keyOf()
    const withCookie = await hit(tryHandleSkills, 'POST', '/api/skills/pending/nope/approve', { authorization: `Bearer ${key}`, cookie: cookieHeader() }, { hash: 'x' })
    expect(refusedByOwnerGate(withCookie)).toBe(false)
    expect(withCookie.status).toBe(404)
    expect(refusedByOwnerGate(await hit(tryHandleSkills, 'POST', '/api/skills/pending/nope/approve', { authorization: `Bearer ${key}` }, { hash: 'x' }))).toBe(true)
  })

  it('R2: unfreezing the fleet: key + cookie passes the owner gate; the key alone is 403', async () => {
    const key = keyOf()
    expect(refusedByOwnerGate(await hit(tryHandleFleetFreeze, 'POST', '/api/fleet/unfreeze', { authorization: `Bearer ${key}`, cookie: cookieHeader(), 'content-type': 'application/json' }, {}))).toBe(false)
    expect(refusedByOwnerGate(await hit(tryHandleFleetFreeze, 'POST', '/api/fleet/unfreeze', { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, {}))).toBe(true)
  })

  // PR-2 (Dani 65623 (2)): credential issuance on the Bridge key beside the owner's cookie; never the key alone.
  it('R3: device keys: key + cookie mints (201), lists and revokes; the key alone, or an operator key with the cookie, is refused', async () => {
    const key = keyOf()
    const withCookie = { authorization: `Bearer ${key}`, cookie: cookieHeader() }
    const minted = await hit(tryHandleAuth, 'POST', '/api/auth/device-keys', withCookie, { name: 'another' })
    expect(minted.status).toBe(201)
    expect((await hit(tryHandleAuth, 'GET', '/api/auth/device-keys', withCookie)).status).toBe(200)
    const other = createDeviceKey('to-revoke')
    expect((await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${other.id}`, withCookie)).status).toBe(200)
    expect((await hit(tryHandleAuth, 'POST', '/api/auth/device-keys', { authorization: `Bearer ${key}` }, { name: 'nope' })).status).toBe(403)
    expect((await hit(tryHandleAuth, 'GET', '/api/auth/device-keys', { authorization: `Bearer ${key}` })).status).toBe(403)
    const op = keyOf('operator')
    expect((await hit(tryHandleAuth, 'POST', '/api/auth/device-keys', { authorization: `Bearer ${op}`, cookie: cookieHeader() }, { name: 'nope' })).status).toBe(403)
    // the list has only its kind gate: an operator key beside the cookie must not read the keys either
    expect((await hit(tryHandleAuth, 'GET', '/api/auth/device-keys', { authorization: `Bearer ${op}`, cookie: cookieHeader() })).status).toBe(403)
    expect(bridgeOwner(authOf(reqWith({ authorization: `Bearer ${op}`, cookie: cookieHeader() })), reqWith({ cookie: cookieHeader() }))).toBe(false)
  })

  it('R6: the fleet Claude credential and the plan login: key + cookie passes the owner gate (then validation or the status); the key alone is refused', async () => {
    const key = keyOf()
    const withCookie = { authorization: `Bearer ${key}`, cookie: cookieHeader(), 'content-type': 'application/json' }
    const bare = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    // an empty body is refused as "missing" before any probe or write
    expect(await hit(tryHandleOnboarding, 'POST', '/api/onboarding/claude-auth', withCookie, {})).toMatchObject({ status: 400 })
    expect(refusedByOwnerGate(await hit(tryHandleOnboarding, 'POST', '/api/onboarding/claude-auth', bare, {}))).toBe(true)
    // a full key that is not a paired Bridge (no install id): the cookie is what lets it in
    expect((await hit(tryHandleClaudePlansLogin, 'GET', '/api/claude-plans/login/status', withCookie)).status).toBe(200)
    expect(refusedByOwnerGate(await hit(tryHandleClaudePlansLogin, 'GET', '/api/claude-plans/login/status', bare))).toBe(true)
  })

  // Dani 65912 (1) and (2): revoking a key (for a paired Bridge also its SSH line) is the one route where bridgeOwner
  // was the only gate.
  it('R3b: revoking a key: the key alone and an operator key with the cookie revoke nothing; key + cookie revokes, and the audit names the owner', async () => {
    const prevSsh = process.env.MARVEEN_SSH_DIR
    process.env.MARVEEN_SSH_DIR = mkdtempSync(join(tmpdir(), 'owner-action-ssh-'))
    try {
      const key = keyOf()
      const target = createDeviceKey('Paired', { installId: 'install-r3b' })
      expect((await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, { authorization: `Bearer ${key}` })).status).toBe(403)
      expect((await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, { authorization: `Bearer ${keyOf('operator')}`, cookie: cookieHeader() })).status).toBe(403)
      expect(getDeviceKey(target.id)).not.toBeNull()
      const spy = vi.spyOn(logger, 'info')
      const r = await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, { authorization: `Bearer ${key}`, cookie: cookieHeader() })
      expect(r.status).toBe(200)
      expect(getDeviceKey(target.id)).toBeNull()
      expect(spy.mock.calls.some((c) => String(c[1]).includes('owner action on a Bridge key') && (c[0] as any)?.owner === 'owner')).toBe(true)
      spy.mockRestore()
      expect(getRecentConfigChanges(5).find((c) => c.key === 'security.bridge_revoke')?.actor).toBe('bridge:owner')
    } finally {
      if (prevSsh === undefined) delete process.env.MARVEEN_SSH_DIR
      else process.env.MARVEEN_SSH_DIR = prevSsh
    }
  })

  // DEVKEYREVOKETOKEN1104: the shared access token alone (every sub-agent can read it) revokes nothing once a dashboard
  // login exists, so it cannot lock the owner out of the Bridge. The paired key's SSH line is a real authorized_keys
  // line here, so "nothing revoked" is measured on both halves.
  it('R3c: revoking a paired key with the bare shared token is refused (key and SSH line stay); listing stays token-only', async () => {
    const prevSsh = process.env.MARVEEN_SSH_DIR
    const sshDir = mkdtempSync(join(tmpdir(), 'owner-action-ssh-'))
    process.env.MARVEEN_SSH_DIR = sshDir
    try {
      const target = createDeviceKey('Paired-bare', { installId: 'install-r3c-bare' })
      const authKeys = join(sshDir, 'authorized_keys')
      const before = 'ssh-ed25519 AAAAkeep other@host\nrestrict ssh-ed25519 AAAAdrop marveen-remote:install-r3c-bare\n'
      writeFileSync(authKeys, before, { mode: 0o600 })
      const bare = { authorization: `Bearer ${TOKEN}` }
      expect(refusedByOwnerGate(await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, bare))).toBe(true)
      expect(getDeviceKey(target.id)).not.toBeNull()
      expect(readFileSync(authKeys, 'utf-8')).toBe(before)
      expect(getRecentConfigChanges(50).some((c) => c.key === 'security.bridge_revoke' && String(c.new_value).includes('(install-r3c-bare)'))).toBe(false)
      // A key that does not exist is 403 too, not 404: the bare token learns nothing about which ids are live.
      expect(refusedByOwnerGate(await hit(tryHandleAuth, 'DELETE', '/api/auth/device-keys/999999', bare))).toBe(true)
      // Control: the list stays readable with the token (Samu 69185, 3.).
      expect((await hit(tryHandleAuth, 'GET', '/api/auth/device-keys', bare)).status).toBe(200)
    } finally {
      if (prevSsh === undefined) delete process.env.MARVEEN_SSH_DIR
      else process.env.MARVEEN_SSH_DIR = prevSsh
    }
  })

  // The owner's lanes: the browser login, and the token with the owner's session cookie beside it (a logged-in browser
  // that also keeps the token sends both). The audit actor is the auth kind (the security.bridge_revoke line); R3b pins
  // the device lane.
  it('R3d: revoking a paired key on the session lane or token + owner cookie: revoked, SSH line removed, actor is the auth kind', async () => {
    const prevSsh = process.env.MARVEEN_SSH_DIR
    const sshDir = mkdtempSync(join(tmpdir(), 'owner-action-ssh-'))
    process.env.MARVEEN_SSH_DIR = sshDir
    try {
      const lanes: Array<[string, Record<string, string>]> = [
        ['token', { authorization: `Bearer ${TOKEN}`, cookie: cookieHeader() }],
        ['session', { cookie: cookieHeader() }],
      ]
      for (const [kind, headers] of lanes) {
        const installId = `install-r3d-${kind}`
        const target = createDeviceKey(`Paired-${kind}`, { installId })
        const authKeys = join(sshDir, 'authorized_keys')
        writeFileSync(authKeys, `ssh-ed25519 AAAAkeep other@host\nrestrict ssh-ed25519 AAAAdrop marveen-remote:${installId}\n`, { mode: 0o600 })
        const r = await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, headers)
        expect(r.status).toBe(200)
        expect(getDeviceKey(target.id)).toBeNull()
        expect(readFileSync(authKeys, 'utf-8')).toBe('ssh-ed25519 AAAAkeep other@host\n')
        const row = getRecentConfigChanges(20).find((c) => c.key === 'security.bridge_revoke' && String(c.new_value).includes(`(${installId})`))
        expect(row?.actor).toBe(kind)
      }
    } finally {
      if (prevSsh === undefined) delete process.env.MARVEEN_SSH_DIR
      else process.env.MARVEEN_SSH_DIR = prevSsh
    }
  })

  // OWNERGATE4-1104 (tech lead): flipped. Revoking is no first-run path: an agent could cut the owner off its Bridge on
  // an install without a login. The install is not locked out: creating the first login stays open ('first-login'), and
  // the 403 says so (setup_required).
  it('R3e: before the first dashboard login the bare token cannot revoke: 403 setup_required, the key stays', async () => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    const target = createDeviceKey('Unpaired')
    const r = await hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${target.id}`, { authorization: `Bearer ${TOKEN}` })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(getDeviceKey(target.id)).not.toBeNull()
  })

  it('R4: dashboard users: key + cookie adds and removes one; a logged-out cookie does not', async () => {
    const key = keyOf()
    const withCookie = { authorization: `Bearer ${key}`, cookie: cookieHeader() }
    expect((await hit(tryHandleAuth, 'POST', '/api/auth/users', withCookie, { username: 'second', password: 'super-secret-pw' })).status).toBe(201)
    expect((await hit(tryHandleAuth, 'DELETE', '/api/auth/users/second', withCookie)).status).toBe(200)
    revokeSession(cookie)
    expect((await hit(tryHandleAuth, 'POST', '/api/auth/users', withCookie, { username: 'third', password: 'super-secret-pw' })).status).toBe(403)
  })

  it('R5: Bridge enrolment and operator access pass their kind gate and owner gate with key + cookie (then validation); the key alone is refused', async () => {
    const key = keyOf()
    const withCookie = { authorization: `Bearer ${key}`, cookie: cookieHeader(), 'content-type': 'application/json' }
    const enroll = await hit(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', withCookie, { key_line: 'x', name: '' })
    expect(enroll.status).toBe(400)
    expect((await hit(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, { key_line: 'x', name: '' })).status).toBe(403)
    const op = await hit(tryHandleOperatorAccess, 'PUT', '/api/operator-access', withCookie, {})
    expect(op.status).toBe(200)
    // the audit names the owner behind the Bridge key, not 'token'
    expect(getRecentConfigChanges(5).find((c) => c.key === 'operator-access')?.actor).toBe('bridge:owner')
    expect((await hit(tryHandleOperatorAccess, 'PUT', '/api/operator-access', { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, {})).status).toBe(403)
  })
})
