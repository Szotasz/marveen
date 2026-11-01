// BRIDGEPWLOGIN1101 PR-1 (Samu 65617, Dani 65623): an owner action that issues no credential takes a FULL device key
// (the Bridge) sent alongside a valid owner session cookie. The cookie is the owner's proof; the key must not hide it.
// Credential issuance stays on mayIssueCredentials (its own PR). Real resolveAuth, real sessions, real device keys.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { resolveAuth, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { mayActAsOwner, mayIssueCredentials, ownerCookieSession, tryHandleAuth } from '../web/routes/auth.js'
import { isOwnerSession } from '../web/routes/gromzo.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleFleetFreeze } from '../web/routes/fleet-freeze.js'
import { createDeviceKey, revokeDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
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

  it('B6: before the first login a bare full key is still refused (the first-run branch is the shared token only)', () => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    const req = reqWith({ authorization: `Bearer ${keyOf()}` })
    expect(mayActAsOwner(authOf(req), req)).toBe(false)
    expect(mayActAsOwner({ kind: 'token' }, req)).toBe(true)
  })

  it('B7: credential issuance is untouched: mayIssueCredentials still refuses a key with a cookie; isOwnerSession reads the same cookie branch', () => {
    const req = reqWith({ authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() })
    const auth = authOf(req)
    expect(mayIssueCredentials(auth, req)).toBe(false)
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

describe('which call site asks which predicate (source pin, the 9 + 8 sites)', () => {
  const src = (f: string) => readFileSync(join(ROOT, 'src', 'web', 'routes', f), 'utf-8')
  const count = (f: string, fn: string) => (src(f).match(new RegExp(`${fn}\\((?:ctx\\.auth|auth), `, 'g')) ?? []).length
  it('the non-issuing owner actions take the Bridge key beside the cookie', () => {
    for (const [f, n] of [['approvals.ts', 2], ['skills.ts', 1], ['federation.ts', 1], ['autonomy.ts', 1], ['fleet-freeze.ts', 1], ['fleet.ts', 2], ['settings.ts', 1]] as const) {
      expect([f, count(f, 'mayActAsOwner'), count(f, 'mayIssueCredentials')]).toEqual([f, n, 0])
    }
  })
  it('credential issuance stays on mayIssueCredentials', () => {
    // auth.ts: its 4 issuance sites, plus the one call inside mayActAsOwner itself
    for (const [f, n] of [['auth.ts', 5], ['security.ts', 1], ['operator-access.ts', 1], ['onboarding.ts', 1], ['claude-plans-login.ts', 1]] as const) {
      expect([f, count(f, 'mayIssueCredentials'), count(f, 'mayActAsOwner')]).toEqual([f, n, 0])
    }
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

  it('R3: minting a device key (credential issuance) stays refused for key + cookie', async () => {
    const r = await hit(tryHandleAuth, 'POST', '/api/auth/device-keys', { authorization: `Bearer ${keyOf()}`, cookie: cookieHeader() }, { name: 'another' })
    expect(r.status).toBe(403)
  })
})
