// DASHUSERGATE1123: a forgotten dashboard password, reset with a one-time code that only the owner's private chat gets.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, createDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { requiresAuth, publicListenerOpenPath, parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { LAN_LOCK_LOGIN_ROUTES } from '../web/colleague-lan-lock.js'
import { resolveSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import { _setTotpStorePathForTest, _resetTotpStateForTest } from '../web/dashboard-totp.js'
import { hotp, base32Decode, totpStepAt } from '../web/totp.js'
import { generateResetCode, normalizeResetCode, _resetPasswordResetCodesForTest, RESET_CODE_TTL_MS } from '../web/password-reset-code.js'
import { notifySecurityEvent, sendOwnerPrivate } from '../notify.js'
import type { RouteContext } from '../web/routes/types.js'

const sent: string[] = []
const delivery: { result: { sent: true; via: 'slack' | 'telegram' } | { sent: false; reason: 'no_private_channel' | 'failed' } } = {
  result: { sent: true, via: 'slack' },
}
vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
  notifyOwner: vi.fn(async () => {}),
  sendOwnerPrivate: vi.fn(async (text: string) => { sent.push(text); return delivery.result }),
}))

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this },
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

let bodies: string[] = []

async function call(method: string, path: string, opts: { body?: unknown; auth?: RouteContext['auth'] } = {}) {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage
  req.headers = {} as http.IncomingHttpHeaders
  const res = mkRes()
  const ctx: RouteContext = { req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: opts.auth }
  const handled = await tryHandleAuth(ctx)
  bodies.push(res.body + JSON.stringify(res.headers))
  return { res, handled, json: () => JSON.parse(res.body || '{}') as Record<string, unknown> }
}

const TOKEN: RouteContext['auth'] = { kind: 'token' }
const PW = 'super-secret-pw'
const NEW_PW = 'brand-new-password-1'
const T0 = 1_900_000_020_000
const CODE_RX = /\b([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2})\b/

async function seedUser(username = 'alice'): Promise<void> {
  expect((await call('POST', '/api/auth/users', { auth: TOKEN, body: { username, password: PW } })).res.statusCode).toBe(201)
}

async function requestCode(username?: string, auth: RouteContext['auth'] = TOKEN): Promise<{ status: number; body: Record<string, unknown>; code: string }> {
  const before = sent.length
  const r = await call('POST', '/api/auth/password-reset/request', { auth, body: username ? { username } : {} })
  const text = sent.length > before ? sent[sent.length - 1] : ''
  return { status: r.res.statusCode, body: r.json(), code: CODE_RX.exec(text)?.[1] ?? '' }
}

async function complete(body: Record<string, unknown>) {
  return call('POST', '/api/auth/password-reset/complete', { body: { username: 'alice', new_password: NEW_PW, ...body } })
}

async function login(password: string, username = 'alice') {
  return call('POST', '/api/auth/login', { body: { username, password } })
}

function audit(key: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM config_change_log WHERE key = ?').get(key) as { n: number }).n
}

let dir: string

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'reset-code-test-'))
  _setTotpStorePathForTest(join(dir, 'store', '.dashboard-totp.json'))
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM config_change_log')
  _clearSessionCacheForTest()
  _resetThrottleForTest()
  _resetTotpStateForTest()
  _resetPasswordResetCodesForTest()
  rmSync(join(dir, 'store'), { recursive: true, force: true })
  sent.length = 0
  bodies = []
  delivery.result = { sent: true, via: 'slack' }
  vi.mocked(notifySecurityEvent).mockClear()
  vi.mocked(sendOwnerPrivate).mockClear()
})

afterEach(() => { vi.useRealTimers() })

describe('the code itself', () => {
  it('is XXXX-XXXX-XX of the Crockford alphabet, and a typed copy is read leniently', () => {
    for (let i = 0; i < 50; i++) expect(generateResetCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/)
    expect(normalizeResetCode(' ab1o-il2z-9q ')).toBe('AB10112Z9Q')
  })
})

describe('POST /api/auth/password-reset/request', () => {
  it('sends the code to the owner\'s private chat only: the answer never carries it, and the old password still works', async () => {
    await seedUser()
    const r = await requestCode('alice')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, sent: true, via: 'slack', username: 'alice', expires_in_s: 900 })
    expect(r.code).not.toBe('')
    expect(sendOwnerPrivate).toHaveBeenCalledTimes(1)
    expect(bodies.join('\n')).not.toContain(r.code)
    expect((await login(PW)).res.statusCode).toBe(200)
    expect(audit('security.password_reset_requested')).toBe(1)
  })

  it('without a name: the only user; with two users the name is required; an unknown name is 404', async () => {
    await seedUser()
    expect((await requestCode()).status).toBe(200)
    createDashboardUser('bob', 'x-hash-not-used')
    expect((await requestCode()).body.code).toBe('username_required')
    expect((await requestCode('nobody')).status).toBe(404)
  })

  it('refuses a caller without a principal and an operator key', async () => {
    await seedUser()
    const none = await call('POST', '/api/auth/password-reset/request', { body: { username: 'alice' } })
    expect(none.res.statusCode).toBe(403)
    expect((await requestCode('alice', { kind: 'device', device: 'op', deviceId: 1, scope: 'operator' })).status).toBe(403)
    expect(sendOwnerPrivate).not.toHaveBeenCalled()
  })

  it('at most 3 an hour per user, counted from the audit log', async () => {
    await seedUser()
    for (let i = 0; i < 3; i++) expect((await requestCode('alice')).status).toBe(200)
    const fourth = await requestCode('alice')
    expect(fourth.status).toBe(429)
    expect(fourth.body.code).toBe('reset_rate_limited')
    vi.setSystemTime(T0 + 3600_000 + 1000)
    expect((await requestCode('alice')).status).toBe(200)
  })

  it('no private chat: 409 and the code is dropped; a failed send: 502, dropped too', async () => {
    await seedUser()
    delivery.result = { sent: false, reason: 'no_private_channel' }
    const a = await requestCode('alice')
    expect(a.status).toBe(409)
    expect((await complete({ code: a.code })).res.statusCode).toBe(401)
    delivery.result = { sent: false, reason: 'failed' }
    const b = await requestCode('alice')
    expect(b.status).toBe(502)
    expect((await complete({ code: b.code })).res.statusCode).toBe(401)
    expect(audit('security.password_reset_not_delivered')).toBe(2)
  })
})

describe('POST /api/auth/password-reset/complete', () => {
  it('the right code sets the new password, logs every session out, is used up, and tells the owner', async () => {
    await seedUser()
    const s = await login(PW)
    const cookie = parseCookies(String(s.res.headers['Set-Cookie']).split(';')[0])[SESSION_COOKIE_NAME] ?? ''
    expect(resolveSession(cookie)).not.toBeNull()
    const { code } = await requestCode('alice')
    const r = await complete({ code: code.toLowerCase().replace(/-/g, ' ') })
    expect(r.res.statusCode).toBe(200)
    expect(resolveSession(cookie)).toBeNull()
    expect((await login(PW)).res.statusCode).toBe(401)
    expect((await login(NEW_PW)).res.statusCode).toBe(200)
    expect(audit('security.password_reset_by_code')).toBe(1)
    expect(notifySecurityEvent).toHaveBeenCalledTimes(1)
    expect((await complete({ code, new_password: 'another-password-22' })).res.statusCode).toBe(401)
  })

  it('expires after 15 minutes', async () => {
    await seedUser()
    const { code } = await requestCode('alice')
    vi.setSystemTime(T0 + RESET_CODE_TTL_MS)
    const r = await complete({ code })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('reset_code_invalid')
    expect(audit('security.password_reset_code_expired')).toBe(1)
    expect((await login(PW)).res.statusCode).toBe(200)
  })

  it('the fifth wrong code invalidates it: the right one no longer works', async () => {
    await seedUser()
    const { code } = await requestCode('alice')
    for (let i = 0; i < 4; i++) expect((await complete({ code: 'AAAA-AAAA-AA' })).json().code).toBe('reset_code_invalid')
    expect((await complete({ code: 'AAAA-AAAA-AA' })).json().code).toBe('reset_code_locked')
    expect(audit('security.password_reset_code_locked')).toBe(1)
    // The login throttle's own lock (5 failures: 30 s) answers first; past it, the code is still gone.
    expect((await complete({ code })).res.statusCode).toBe(429)
    vi.setSystemTime(T0 + 31_000)
    expect((await complete({ code })).json().code).toBe('reset_code_invalid')
    expect((await login(PW)).res.statusCode).toBe(200)
  })

  it('a new request replaces the earlier code', async () => {
    await seedUser()
    const first = await requestCode('alice')
    const second = await requestCode('alice')
    expect((await complete({ code: first.code })).res.statusCode).toBe(401)
    expect((await complete({ code: second.code })).res.statusCode).toBe(200)
  })

  it('a weak new password is refused before the code is touched', async () => {
    await seedUser()
    const { code } = await requestCode('alice')
    const r = await complete({ code, new_password: 'x' })
    expect(r.res.statusCode).toBe(400)
    expect((await complete({ code })).res.statusCode).toBe(200)
  })

  it('with the second factor on, the code alone is not enough; a wrong factor code counts toward the five', async () => {
    await seedUser()
    const alice: RouteContext['auth'] = { kind: 'session', user: 'alice' }
    const setup = await call('POST', '/api/auth/totp/setup', { auth: alice })
    const secret = String(setup.json().secret)
    const factor = (off = 0) => hotp(base32Decode(secret), totpStepAt(Date.now()) + off)
    expect((await call('POST', '/api/auth/totp/enable', { auth: alice, body: { code: factor(), password: PW } })).res.statusCode).toBe(200)
    vi.setSystemTime(T0 + 60_000)
    const { code } = await requestCode('alice')
    expect((await complete({ code })).json().code).toBe('totp_required')
    for (let i = 0; i < 4; i++) expect((await complete({ code, totp_code: '000000' })).json().code).toBe('totp_invalid')
    expect((await complete({ code, totp_code: factor() })).res.statusCode).toBe(200)
    expect((await login(NEW_PW)).json().code).toBe('totp_required')
  })

  it('a wrong code for an unknown user answers exactly like a wrong code', async () => {
    const r = await complete({ username: 'ghost', code: 'AAAA-AAAA-AA' })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('reset_code_invalid')
  })
})

describe('where the routes are reachable', () => {
  it('complete is public like the login (and on the public listener, and LAN-locked like it); request needs a principal', () => {
    expect(requiresAuth('/api/auth/password-reset/complete', 'POST')).toBe(false)
    expect(publicListenerOpenPath('/api/auth/password-reset/complete', 'POST')).toBe(true)
    expect(LAN_LOCK_LOGIN_ROUTES.has('/api/auth/password-reset/complete')).toBe(true)
    expect(requiresAuth('/api/auth/password-reset/request', 'POST')).toBe(true)
    expect(publicListenerOpenPath('/api/auth/password-reset/request', 'POST')).toBe(false)
  })
})
