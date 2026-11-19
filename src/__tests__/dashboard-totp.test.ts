// DOCKERHTTPS1119: the optional TOTP second factor of the dashboard owner login.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { requiresAuth, parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { resolveSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import { _setTotpStorePathForTest, _resetTotpStateForTest, getTotpRecord, PENDING_LOGIN_TTL_S } from '../web/dashboard-totp.js'
import { hotp, base32Decode, base32Encode, matchTotp, totpStepAt, hashBackupCode, findBackupCode, otpauthUri } from '../web/totp.js'
import { logger } from '../logger.js'
import { notifySecurityEvent } from '../notify.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
  notifyOwner: vi.fn(async () => {}),
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
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

// Every response body of the suite, so the secret can be searched for in all of them at the end of a test.
let bodies: string[] = []

async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string | undefined>; auth?: RouteContext['auth'] } = {}) {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage
  req.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  const res = mkRes()
  const ctx: RouteContext = { req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: opts.auth }
  const handled = await tryHandleAuth(ctx)
  bodies.push(res.body + JSON.stringify(res.headers))
  return { res, handled, json: () => JSON.parse(res.body || '{}') as Record<string, unknown> }
}

function cookieOf(res: MockRes): string {
  const c = res.headers['Set-Cookie']
  const line = Array.isArray(c) ? c[0]! : (c ?? '')
  return parseCookies(line.split(';')[0])[SESSION_COOKIE_NAME] ?? ''
}

const TOKEN: RouteContext['auth'] = { kind: 'token' }
const PW = 'super-secret-pw'
const T0 = 1_900_000_020_000 // on a step boundary: 1_900_000_020 s / 30 = 63_333_334
const ALICE: RouteContext['auth'] = { kind: 'session', user: 'alice' }

let dir: string
let storeFile: string

function codeAt(secret: string, offsetSteps = 0, now = Date.now()): string {
  return hotp(base32Decode(secret), totpStepAt(now) + offsetSteps)
}

async function seedUser(username = 'alice'): Promise<void> {
  const r = await call('POST', '/api/auth/users', { auth: TOKEN, body: { username, password: PW } })
  expect(r.res.statusCode).toBe(201)
}

/** Setup + enable for alice at the current fake time. Returns the secret and the backup codes. */
async function enableFor(auth: RouteContext['auth'] = ALICE, headers?: Record<string, string>): Promise<{ secret: string; backup: string[] }> {
  const s = await call('POST', '/api/auth/totp/setup', { auth, headers })
  expect(s.res.statusCode).toBe(200)
  const secret = String(s.json().secret)
  const e = await call('POST', '/api/auth/totp/enable', { auth, headers, body: { code: codeAt(secret), password: PW } })
  expect(e.res.statusCode).toBe(200)
  return { secret, backup: e.json().backup_codes as string[] }
}

async function passwordStep(username = 'alice', password = PW) {
  return call('POST', '/api/auth/login', { body: { username, password } })
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'totp-test-'))
  storeFile = join(dir, 'store', '.dashboard-totp.json')
  _setTotpStorePathForTest(storeFile)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  getDb().exec('DELETE FROM config_change_log')
  _clearSessionCacheForTest()
  _resetThrottleForTest()
  _resetTotpStateForTest()
  rmSync(join(dir, 'store'), { recursive: true, force: true })
  bodies = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RFC 6238 / 4226 primitives', () => {
  // RFC 6238 Appendix B, SHA1, the 20-byte ASCII seed "12345678901234567890", 8 digits.
  const seed = Buffer.from('12345678901234567890', 'ascii')
  const vectors: Array<[number, string]> = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ]
  for (const [t, want] of vectors) {
    it(`T=${t} -> ${want} (and its 6-digit form)`, () => {
      const step = totpStepAt(t * 1000)
      expect(hotp(seed, step, 8)).toBe(want)
      expect(hotp(seed, step)).toBe(want.slice(2))
    })
  }

  it('base32 round-trips the RFC seed', () => {
    expect(base32Encode(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(seed)).toBe(true)
  })

  it('accepts +-1 step, rejects +-2', () => {
    const secret = base32Encode(seed)
    const now = 1234567890_000
    const at = (d: number) => hotp(seed, totpStepAt(now) + d)
    expect(matchTotp(secret, at(0), now, -1)).toBe(totpStepAt(now))
    expect(matchTotp(secret, at(-1), now, -1)).toBe(totpStepAt(now) - 1)
    expect(matchTotp(secret, at(1), now, -1)).toBe(totpStepAt(now) + 1)
    expect(matchTotp(secret, at(-2), now, -1)).toBeNull()
    expect(matchTotp(secret, at(2), now, -1)).toBeNull()
  })

  it('refuses a step at or before the last accepted one (replay)', () => {
    const secret = base32Encode(seed)
    const now = 1234567890_000
    const cur = totpStepAt(now)
    expect(matchTotp(secret, hotp(seed, cur), now, cur)).toBeNull()
    expect(matchTotp(secret, hotp(seed, cur - 1), now, cur - 1)).toBeNull()
    expect(matchTotp(secret, hotp(seed, cur + 1), now, cur)).toBe(cur + 1)
  })

  it('a backup code is found by its hash only, in any spacing or case', () => {
    const hashes = [hashBackupCode('abcde-fghjk'), hashBackupCode('mnpqr-stuvw')]
    expect(findBackupCode(hashes, 'MNPQR STUVW')).toBe(1)
    expect(findBackupCode(hashes, 'zzzzz-zzzzz')).toBe(-1)
  })

  it('the otpauth URI names the issuer and the account', () => {
    expect(otpauthUri('alice', 'ABC')).toBe('otpauth://totp/Marveen%3Aalice?secret=ABC&issuer=Marveen&algorithm=SHA1&digits=6&period=30')
  })
})

describe('login with the second factor OFF is unchanged', () => {
  it('byte-pinned: status, headers and body of the password login', async () => {
    await seedUser()
    const r = await passwordStep()
    expect(r.res.statusCode).toBe(200)
    expect(r.res.body).toBe('{"ok":true,"user":"alice"}')
    expect(Object.keys(r.res.headers).sort()).toEqual(['Cache-Control', 'Content-Type', 'Set-Cookie'])
    expect(r.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(r.res.headers['Cache-Control']).toBe('private, no-store')
    expect(String(r.res.headers['Set-Cookie'])).toMatch(/^mv_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/)
    expect(existsSync(storeFile)).toBe(false)
  })

  it('the code endpoint is public (the gate lets it through without a principal)', () => {
    expect(requiresAuth('/api/auth/login/totp', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/totp/setup', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/totp/enable', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/totp/disable', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/totp', 'GET')).toBe(true)
  })
})

describe('who may turn it on', () => {
  it('the bare shared token: 403 (a login exists)', async () => {
    await seedUser()
    const r = await call('POST', '/api/auth/totp/setup', { auth: TOKEN })
    expect(r.res.statusCode).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(existsSync(storeFile)).toBe(false)
  })

  it('the first-run token (no login exists yet): 403', async () => {
    const r = await call('POST', '/api/auth/totp/setup', { auth: TOKEN })
    expect(r.res.statusCode).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
  })

  it('a sub-agent token, a bare full device key, an operator key, a federation peer and an unknown kind: 403', async () => {
    await seedUser()
    for (const auth of [
      { kind: 'token', agent: 'geri', tokenAgent: 'geri' },
      { kind: 'device', device: 'mac', deviceId: 1, scope: 'full' },
      { kind: 'device', device: 'op', deviceId: 2, scope: 'operator' },
      // A credential kind this union does not carry (e.g. a first-run setup session on the public listener): denied
      // by default, mayActAsOwner has no branch for it.
      { kind: 'setup' } as unknown as RouteContext['auth'],
      { kind: 'federation', peer: 'p' },
    ] as RouteContext['auth'][]) {
      for (const p of ['/api/auth/totp/setup', '/api/auth/totp/enable', '/api/auth/totp/disable']) {
        const r = await call('POST', p, { auth, body: { code: '123456', password: PW } })
        expect(r.res.statusCode).toBe(403)
      }
      expect((await call('GET', '/api/auth/totp', { auth })).res.statusCode).toBe(403)
    }
  })

  it('the shared token WITH the owner session cookie beside it: allowed, for that owner', async () => {
    await seedUser()
    const cookie = cookieOf((await passwordStep()).res)
    const { secret } = await enableFor(TOKEN, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` })
    expect(getTotpRecord(getDashboardUser('alice')!.id)?.secret).toBe(secret)
  })

  it('enable needs a setup first, and the right code', async () => {
    await seedUser()
    expect((await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: '000000' } })).json().code).toBe('totp_setup_missing')
    const s = await call('POST', '/api/auth/totp/setup', { auth: ALICE })
    const secret = String(s.json().secret)
    const bad = await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: codeAt(secret, 2), password: PW } })
    expect(bad.res.statusCode).toBe(400)
    expect(bad.json().code).toBe('totp_invalid')
    expect(existsSync(storeFile)).toBe(false)
    const ok = await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: codeAt(secret), password: PW } })
    expect(ok.res.statusCode).toBe(200)
    expect((await call('POST', '/api/auth/totp/setup', { auth: ALICE })).res.statusCode).toBe(409)
  })

  it('B1 (Dani 81107): enable without the password or with a wrong one is refused, and nothing changes', async () => {
    await seedUser()
    const other = cookieOf((await passwordStep()).res)
    const s = await call('POST', '/api/auth/totp/setup', { auth: ALICE })
    const secret = String(s.json().secret)
    for (const body of [{ code: codeAt(secret) }, { code: codeAt(secret), password: '' }, { code: codeAt(secret), password: 'wrong-password-x' }]) {
      const r = await call('POST', '/api/auth/totp/enable', { auth: ALICE, body })
      expect(r.res.statusCode).toBe(401)
      expect(r.json()).toEqual({ error: 'Invalid credentials' })
      expect(r.json().backup_codes).toBeUndefined()
    }
    expect(existsSync(storeFile)).toBe(false)
    expect(getDashboardUser('alice')!.totp_enabled).toBe(0)
    expect(resolveSession(other)?.username).toBe('alice')
    expect((await passwordStep()).res.statusCode).toBe(200)
    // The pending setup survived the refusals: the right password and code still finish it.
    const ok = await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: codeAt(secret), password: PW } })
    expect(ok.res.statusCode).toBe(200)
  })

  it('B1: wrong passwords at enable count in the login bucket (5 lock the 6th, even with the right password)', async () => {
    await seedUser()
    const s = await call('POST', '/api/auth/totp/setup', { auth: ALICE })
    const secret = String(s.json().secret)
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: codeAt(secret), password: 'wrong-password-x' } })
    const r = await call('POST', '/api/auth/totp/enable', { auth: ALICE, body: { code: codeAt(secret), password: PW } })
    expect(r.res.statusCode).toBe(429)
    expect(getDashboardUser('alice')!.totp_enabled).toBe(0)
  })

  it('enabling ends the owner\'s OTHER sessions (signed in without the second factor), keeps the caller\'s', async () => {
    await seedUser()
    const other = cookieOf((await passwordStep()).res)
    const mine = cookieOf((await passwordStep()).res)
    await enableFor(TOKEN, { cookie: `${SESSION_COOKIE_NAME}=${mine}` })
    expect(resolveSession(other)).toBeNull()
    expect(resolveSession(mine)?.username).toBe('alice')
  })

  it('GET reports on/off and the backup codes left, never the secret', async () => {
    await seedUser()
    expect((await call('GET', '/api/auth/totp', { auth: ALICE })).json()).toEqual({ enabled: false, backup_codes_left: 0 })
    await enableFor()
    expect((await call('GET', '/api/auth/totp', { auth: ALICE })).json()).toEqual({ enabled: true, backup_codes_left: 10 })
  })
})

describe('the secret on the server', () => {
  it('file mode 0600; secret only in the setup response; backup codes only hashed on disk; never logged', async () => {
    const logged: string[] = []
    for (const lvl of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, lvl).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)) }) as never)
    }
    await seedUser()
    const before = bodies.length
    const { secret, backup } = await enableFor()
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
    const disk = readFileSync(storeFile, 'utf-8')
    for (const c of backup) {
      expect(disk).not.toContain(c)
      expect(disk).toContain(hashBackupCode(c))
    }
    // A full round: login with a code, a backup code, status, a failed disable, then the real disable.
    vi.setSystemTime(T0 + 30_000)
    let p = await passwordStep()
    await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: codeAt(secret) } })
    p = await passwordStep()
    await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: backup[0] } })
    await call('GET', '/api/auth/totp', { auth: ALICE })
    await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: '000000' } })
    vi.setSystemTime(T0 + 60_000)
    await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: codeAt(secret) } })
    const setupBody = bodies[before]!
    expect(setupBody).toContain(secret)
    for (const b of bodies.slice(before + 1)) expect(b).not.toContain(secret)
    for (const l of logged) {
      expect(l).not.toContain(secret)
      for (const c of backup) expect(l).not.toContain(c)
    }
    const audit = getDb().prepare("SELECT key, new_value FROM config_change_log WHERE key LIKE 'security.totp%'").all() as Array<{ key: string; new_value: string }>
    expect(audit.map((a) => a.key)).toEqual(['security.totp_enable', 'security.totp_disable'])
    for (const a of audit) expect(a.new_value).toBe('alice')
  })

  it('B2 (Dani 81107): enable sets the database flag, disable clears it', async () => {
    await seedUser()
    const { secret } = await enableFor()
    expect(getDashboardUser('alice')!.totp_enabled).toBe(1)
    vi.setSystemTime(T0 + 30_000)
    await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: codeAt(secret) } })
    expect(getDashboardUser('alice')!.totp_enabled).toBe(0)
  })

  it('B2: the store file DELETED while the factor is on: the right password gets 503, never a session', async () => {
    await seedUser()
    await enableFor()
    rmSync(storeFile)
    const r = await passwordStep()
    expect(r.res.statusCode).toBe(503)
    expect(r.json().code).toBe('totp_store_unavailable')
    expect(r.res.headers['Set-Cookie']).toBeUndefined()
    // And the owner routes cannot report it as off either.
    expect((await call('GET', '/api/auth/totp', { auth: ALICE })).res.statusCode).toBe(503)
    expect((await call('POST', '/api/auth/totp/setup', { auth: ALICE })).res.statusCode).toBe(503)
  })

  it('B2: the user\'s record removed from the file (the file still there): 503 at the password and at the code step', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const p = await passwordStep()
    writeFileSync(storeFile, JSON.stringify({ users: {} }))
    const r = await passwordStep()
    expect(r.res.statusCode).toBe(503)
    expect(r.res.headers['Set-Cookie']).toBeUndefined()
    const c = await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: codeAt(secret, 1) } })
    expect(c.res.statusCode).toBe(503)
    expect(c.res.headers['Set-Cookie']).toBeUndefined()
  })

  it('B2: a record in the file without the flag still reads as ON (never off)', async () => {
    await seedUser()
    await enableFor()
    // The flag lost, the record kept (the order enable writes in makes this the only partial state).
    getDb().prepare('UPDATE dashboard_users SET totp_enabled = 0').run()
    const r = await passwordStep()
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('totp_required')
  })

  it('a damaged store: a user whose flag is OFF signs in with the password; a user whose flag is on gets 503', async () => {
    // Dani (#2911 review): the flag is the source of truth, so a damaged file no longer locks out every user.
    await seedUser()
    expect((await call('POST', '/api/auth/users', { auth: ALICE, body: { username: 'bob', password: PW } })).res.statusCode).toBe(201)
    await enableFor()
    writeFileSync(storeFile, '{not json')
    const bob = await passwordStep('bob')
    expect(bob.res.statusCode).toBe(200)
    expect(cookieOf(bob.res)).not.toBe('')
    const alice = await passwordStep()
    expect(alice.res.statusCode).toBe(503)
    expect(alice.json().code).toBe('totp_store_unavailable')
    expect(alice.res.headers['Set-Cookie']).toBeUndefined()
  })

  it('a damaged store fails closed: the right password gets 503, never a session', async () => {
    await seedUser()
    await enableFor()
    writeFileSync(storeFile, '{not json')
    const r = await passwordStep()
    expect(r.res.statusCode).toBe(503)
    expect(r.json().code).toBe('totp_store_unavailable')
    expect(r.res.headers['Set-Cookie']).toBeUndefined()
  })
})

describe('login with the second factor ON', () => {
  it('the password alone gives no session, only a pending token; the code completes it', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const p = await passwordStep()
    expect(p.res.statusCode).toBe(401)
    expect(p.res.headers['Set-Cookie']).toBeUndefined()
    expect(p.json()).toMatchObject({ code: 'totp_required', expires_in_s: PENDING_LOGIN_TTL_S })
    const pending = String(p.json().pending)
    expect(pending).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const r = await call('POST', '/api/auth/login/totp', { body: { pending, code: codeAt(secret, 1) } })
    expect(r.res.statusCode).toBe(200)
    expect(r.res.body).toBe('{"ok":true,"user":"alice"}')
    expect(resolveSession(cookieOf(r.res))?.username).toBe('alice')
    // The pending token is single-use.
    const again = await call('POST', '/api/auth/login/totp', { body: { pending, code: codeAt(secret, 1) } })
    expect(again.json().code).toBe('totp_pending_expired')
  })

  it('a wrong password still answers 401 Invalid credentials, with no pending token', async () => {
    await seedUser()
    await enableFor()
    const r = await passwordStep('alice', 'wrong-password-x')
    expect(r.res.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('a code used once is refused on replay (a new pending token, the same code)', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const code = codeAt(secret, 1)
    const p1 = await passwordStep()
    expect((await call('POST', '/api/auth/login/totp', { body: { pending: p1.json().pending, code } })).res.statusCode).toBe(200)
    const p2 = await passwordStep()
    const r = await call('POST', '/api/auth/login/totp', { body: { pending: p2.json().pending, code } })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('totp_invalid')
    // The enable code (the current step) was spent too.
    const p3 = await passwordStep()
    expect((await call('POST', '/api/auth/login/totp', { body: { pending: p3.json().pending, code: codeAt(secret) } })).res.statusCode).toBe(401)
  })

  it('+-1 step accepted, +-2 refused at the login', async () => {
    await seedUser()
    const { secret } = await enableFor()
    vi.setSystemTime(T0 + 5 * 30_000)
    for (const d of [-2, 2]) {
      const p = await passwordStep()
      expect((await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: codeAt(secret, d) } })).res.statusCode).toBe(401)
    }
    const pm = await passwordStep()
    expect((await call('POST', '/api/auth/login/totp', { body: { pending: pm.json().pending, code: codeAt(secret, -1) } })).res.statusCode).toBe(200)
    const pp = await passwordStep()
    expect((await call('POST', '/api/auth/login/totp', { body: { pending: pp.json().pending, code: codeAt(secret, 1) } })).res.statusCode).toBe(200)
  })

  it('the login throttle applies to the code step: 5 wrong codes lock it, the right code then gets 429', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const p = await passwordStep()
    const pending = p.json().pending
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/api/auth/login/totp', { body: { pending, code: '000000' } })).res.statusCode).toBe(401)
    }
    const r = await call('POST', '/api/auth/login/totp', { body: { pending, code: codeAt(secret, 1) } })
    expect(r.res.statusCode).toBe(429)
    expect(r.res.headers['Retry-After']).toBeDefined()
    expect(r.res.headers['Set-Cookie']).toBeUndefined()
  })

  it('the pending sign-in expires', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const p = await passwordStep()
    vi.setSystemTime(T0 + PENDING_LOGIN_TTL_S * 1000 + 1)
    const r = await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: codeAt(secret) } })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('totp_pending_expired')
    expect(r.res.headers['Set-Cookie']).toBeUndefined()
  })

  it('an unknown pending token: 401, no session', async () => {
    await seedUser()
    const { secret } = await enableFor()
    const r = await call('POST', '/api/auth/login/totp', { body: { pending: 'x'.repeat(43), code: codeAt(secret, 1) } })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('totp_pending_expired')
  })

  it('a backup code signs in once; the same code a second time is refused', async () => {
    await seedUser()
    const { backup } = await enableFor()
    const p1 = await passwordStep()
    const r1 = await call('POST', '/api/auth/login/totp', { body: { pending: p1.json().pending, code: backup[3] } })
    expect(r1.res.statusCode).toBe(200)
    expect(r1.json()).toEqual({ ok: true, user: 'alice', backup_code_used: true, backup_codes_left: 9 })
    const p2 = await passwordStep()
    const r2 = await call('POST', '/api/auth/login/totp', { body: { pending: p2.json().pending, code: backup[3] } })
    expect(r2.res.statusCode).toBe(401)
    expect(getTotpRecord(getDashboardUser('alice')!.id)!.backup).toHaveLength(9)
  })
})

describe('turning it off', () => {
  async function setup() {
    await seedUser()
    const r = await enableFor()
    vi.setSystemTime(T0 + 30_000)
    return r
  }

  it('without a code: 400, stays on', async () => {
    await setup()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW } })
    expect(r.res.statusCode).toBe(400)
    expect(r.json().code).toBe('totp_code_required')
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeDefined()
  })

  it('with a wrong password and the right code: 401, stays on', async () => {
    const { secret } = await setup()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: 'wrong-password-x', code: codeAt(secret) } })
    expect(r.res.statusCode).toBe(401)
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeDefined()
  })

  it('with the password and a wrong code: 401, stays on', async () => {
    await setup()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: '000000' } })
    expect(r.res.statusCode).toBe(401)
    expect(r.json().code).toBe('totp_invalid')
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeDefined()
  })

  it('with the password and a valid code: off, and the password alone signs in again', async () => {
    const { secret } = await setup()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: codeAt(secret) } })
    expect(r.res.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true, enabled: false })
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeUndefined()
    expect((await passwordStep()).res.statusCode).toBe(200)
  })

  it('a successful web disable pings the owner exactly once, naming the user', async () => {
    const { secret } = await setup()
    vi.mocked(notifySecurityEvent).mockClear()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: codeAt(secret) } })
    expect(r.res.statusCode).toBe(200)
    expect(vi.mocked(notifySecurityEvent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifySecurityEvent).mock.calls[0]![0]).toContain('"alice"')
  })

  it('a refused web disable (wrong code, wrong password, no code) pings no one', async () => {
    const { secret } = await setup()
    vi.mocked(notifySecurityEvent).mockClear()
    expect((await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: '000000' } })).res.statusCode).toBe(401)
    expect((await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: 'wrong-password-x', code: codeAt(secret) } })).res.statusCode).toBe(401)
    expect((await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW } })).res.statusCode).toBe(400)
    expect(vi.mocked(notifySecurityEvent)).not.toHaveBeenCalled()
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeDefined()
  })

  it('with the password and an unused backup code (the lost-phone case): off', async () => {
    const { backup } = await setup()
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: backup[0] } })
    expect(r.res.statusCode).toBe(200)
    expect(getTotpRecord(getDashboardUser('alice')!.id)).toBeUndefined()
  })

  it('wrong codes at disable are throttled under the same code bucket as the login', async () => {
    const { secret } = await setup()
    for (let i = 0; i < 5; i++) {
      await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: '000000' } })
    }
    const r = await call('POST', '/api/auth/totp/disable', { auth: ALICE, body: { password: PW, code: codeAt(secret) } })
    expect(r.res.statusCode).toBe(429)
    const p = await passwordStep()
    expect((await call('POST', '/api/auth/login/totp', { body: { pending: p.json().pending, code: codeAt(secret) } })).res.statusCode).toBe(429)
  })

  it('removing the dashboard login removes its second-factor record', async () => {
    await setup()
    expect((await call('POST', '/api/auth/users', { auth: ALICE, body: { username: 'bob', password: PW } })).res.statusCode).toBe(201)
    const id = getDashboardUser('alice')!.id
    const r = await call('DELETE', '/api/auth/users/alice', { auth: ALICE })
    expect(r.res.statusCode).toBe(200)
    expect(getTotpRecord(id)).toBeUndefined()
  })
})
