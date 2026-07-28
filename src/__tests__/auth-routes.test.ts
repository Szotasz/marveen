import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { requiresAuth, parseCookies, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { resolveSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import type { RouteContext } from '../web/routes/types.js'

// Break-glass password resets in this suite hit the REAL notifier: auth.ts
// fires notifySecurityEvent on a token-auth reset, and notify.ts reads the
// live channel token/chat-id from config at module load -- in a production
// checkout that delivered actual Telegram alerts to the owner (2026-07-27
// incident). Neutralize the transport here; the alert-emitting behavior
// itself is covered by test-run-marker.test.ts with a stubbed fetch.
vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
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
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(opts: { headers?: Record<string, string | undefined>; body?: unknown }): http.IncomingMessage {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string | undefined>; auth?: RouteContext['auth'] } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq({ headers: opts.headers, body: opts.body })
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  }
  const handled = await tryHandleAuth(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

function cookieHeader(res: MockRes): string {
  const c = res.headers['Set-Cookie']
  return Array.isArray(c) ? c.join('\n') : (c ?? '')
}

function cookieToken(res: MockRes): string {
  return parseCookies(cookieHeader(res).split(';').slice(0, 1).join(';'))[SESSION_COOKIE_NAME] ?? ''
}

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
// Simulates a FUTURE credential kind (e.g. per-device keys) that the AuthResult
// union does not carry yet: the allowlists must default-deny it everywhere.
const DEVICE_AUTH = { kind: 'device' } as unknown as RouteContext['auth']
const FEDERATION_AUTH: RouteContext['auth'] = { kind: 'federation', peer: 'test-peer' }
const GOOD_PW = 'super-secret-pw'

async function seedUser(username: string, password = GOOD_PW): Promise<void> {
  const r = await call('POST', '/api/auth/users', { auth: TOKEN_AUTH, body: { username, password } })
  expect(r.res.statusCode).toBe(201)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  _resetThrottleForTest()
})

describe('GET /api/auth/status', () => {
  it('reports setup_required with zero users and token-caller authenticated', async () => {
    const { json } = await call('GET', '/api/auth/status', { auth: TOKEN_AUTH })
    const body = json()
    expect(body).toMatchObject({ authenticated: true, method: 'token', user: null, login_available: false, setup_required: true })
  })

  it('reports login_available once a user exists and unauth for no principal', async () => {
    await seedUser('alice')
    const { json } = await call('GET', '/api/auth/status', { auth: undefined })
    expect(json()).toMatchObject({ authenticated: false, method: null, user: null, login_available: true, setup_required: false })
  })

  it('reports session method + user for a session principal', async () => {
    await seedUser('alice')
    const { json } = await call('GET', '/api/auth/status', { auth: { kind: 'session', user: 'alice' } })
    expect(json()).toMatchObject({ authenticated: true, method: 'session', user: 'alice' })
  })
})

describe('POST /api/auth/login', () => {
  it('sets HttpOnly; SameSite=Strict; Path=/ and NO Secure over plain http', async () => {
    await seedUser('alice')
    const { res, json } = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, user: 'alice' })
    const c = cookieHeader(res)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/')
    expect(c).not.toContain('Secure')
  })

  it('adds Secure only under x-forwarded-proto: https', async () => {
    await seedUser('alice')
    const { res } = await call('POST', '/api/auth/login', {
      headers: { 'x-forwarded-proto': 'https' },
      body: { username: 'alice', password: GOOD_PW },
    })
    expect(cookieHeader(res)).toContain('Secure')
  })

  it('mints a fresh session id on every login (fixation defence)', async () => {
    await seedUser('alice')
    const a = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const b = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(cookieToken(a.res)).not.toBe('')
    expect(cookieToken(a.res)).not.toBe(cookieToken(b.res))
  })

  it('revokes a presented (valid) session cookie on login', async () => {
    await seedUser('alice')
    const first = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const oldToken = cookieToken(first.res)
    expect(resolveSession(oldToken)).not.toBeNull()
    await call('POST', '/api/auth/login', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${oldToken}` },
      body: { username: 'alice', password: GOOD_PW },
    })
    expect(resolveSession(oldToken)).toBeNull()
  })

  it('returns IDENTICAL 401 bodies for bad user vs bad password', async () => {
    await seedUser('alice')
    const badUser = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: GOOD_PW } })
    const badPass = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } })
    expect(badUser.res.statusCode).toBe(401)
    expect(badPass.res.statusCode).toBe(401)
    expect(badUser.json()).toEqual({ error: 'Invalid credentials' })
    expect(badPass.json()).toEqual(badUser.json())
  })

  it('429s once the per-username lock trips, with retry_after_s', async () => {
    await seedUser('alice')
    for (let i = 0; i < 5; i++) {
      await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } })
    }
    const locked = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(locked.res.statusCode).toBe(429)
    expect(locked.json().retry_after_s).toBeGreaterThan(0)
    expect(locked.res.headers['Retry-After']).toBeTruthy()
  })
})

describe('POST /api/auth/logout', () => {
  it('clears the cookie and revokes the row', async () => {
    await seedUser('alice')
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const token = cookieToken(login.res)
    const out = await call('POST', '/api/auth/logout', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      auth: { kind: 'session', user: 'alice' },
    })
    expect(out.res.statusCode).toBe(200)
    expect(cookieHeader(out.res)).toContain('Max-Age=0')
    expect(resolveSession(token)).toBeNull()
  })
})

describe('POST /api/auth/password', () => {
  it('requires a correct current_password on the session path', async () => {
    await seedUser('alice')
    const wrong = await call('POST', '/api/auth/password', {
      auth: { kind: 'session', user: 'alice' },
      body: { current_password: 'nope', new_password: 'brand-new-pass' },
    })
    expect(wrong.res.statusCode).toBe(401)
    const ok = await call('POST', '/api/auth/password', {
      auth: { kind: 'session', user: 'alice' },
      body: { current_password: GOOD_PW, new_password: 'brand-new-pass' },
    })
    expect(ok.res.statusCode).toBe(200)
    // new password now works
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'brand-new-pass' } })
    expect(login.res.statusCode).toBe(200)
  })

  it('does NOT require current_password on the token break-glass path', async () => {
    await seedUser('alice')
    const ok = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', new_password: 'token-reset-pass' },
    })
    expect(ok.res.statusCode).toBe(200)
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'token-reset-pass' } })
    expect(login.res.statusCode).toBe(200)
  })

  it('revokes OTHER sessions on password change but keeps the caller', async () => {
    await seedUser('alice')
    const other = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const caller = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const otherToken = cookieToken(other.res)
    const callerToken = cookieToken(caller.res)
    await call('POST', '/api/auth/password', {
      auth: { kind: 'session', user: 'alice' },
      headers: { cookie: `${SESSION_COOKIE_NAME}=${callerToken}` },
      body: { current_password: GOOD_PW, new_password: 'rotated-password' },
    })
    expect(resolveSession(otherToken)).toBeNull()
    expect(resolveSession(callerToken)).not.toBeNull()
  })

  it('enforces the password policy on the new password', async () => {
    await seedUser('alice')
    const short = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', new_password: 'short' },
    })
    expect(short.res.statusCode).toBe(400)
  })
})

describe('users CRUD', () => {
  it('gates create + delete at the auth layer (requiresAuth)', () => {
    // The route trusts the gate: these paths must be gated so an unauthenticated
    // request is 401'd before reaching the handler.
    expect(requiresAuth('/api/auth/users', 'POST')).toBe(true)
    expect(requiresAuth('/api/auth/users/alice', 'DELETE')).toBe(true)
  })

  it('rejects a duplicate username with 409', async () => {
    await seedUser('alice')
    const dup = await call('POST', '/api/auth/users', { auth: TOKEN_AUTH, body: { username: 'alice', password: GOOD_PW } })
    expect(dup.res.statusCode).toBe(409)
  })

  it('rejects an invalid username', async () => {
    const bad = await call('POST', '/api/auth/users', { auth: TOKEN_AUTH, body: { username: 'has space', password: GOOD_PW } })
    expect(bad.res.statusCode).toBe(400)
  })

  it('lists users without password hashes', async () => {
    await seedUser('alice')
    const { json } = await call('GET', '/api/auth/users', { auth: TOKEN_AUTH })
    const users = json().users as Record<string, unknown>[]
    expect(users.length).toBe(1)
    expect(users[0]).not.toHaveProperty('password_hash')
    expect(users[0].username).toBe('alice')
  })

  it('deletes a user and revokes their sessions (back to token-only)', async () => {
    await seedUser('alice')
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    const token = cookieToken(login.res)
    const del = await call('DELETE', '/api/auth/users/alice', { auth: TOKEN_AUTH })
    expect(del.res.statusCode).toBe(200)
    expect(getDashboardUser('alice')).toBeUndefined()
    expect(resolveSession(token)).toBeNull()
  })

  it('still allows a SESSION principal to manage users (existing behavior)', async () => {
    await seedUser('alice')
    const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'alice' }
    const created = await call('POST', '/api/auth/users', { auth: SESSION_AUTH, body: { username: 'bob', password: GOOD_PW } })
    expect(created.res.statusCode).toBe(201)
    const list = await call('GET', '/api/auth/users', { auth: SESSION_AUTH })
    expect((list.json().users as unknown[]).length).toBe(2)
    const del = await call('DELETE', '/api/auth/users/bob', { auth: SESSION_AUTH })
    expect(del.res.statusCode).toBe(200)
  })
})

describe('credential-kind allowlists (default-deny for future kinds)', () => {
  // The access-granting endpoints must reject every kind that is not
  // explicitly listed. 'device' stands in for any future AuthResult kind;
  // 'federation' is path-scoped in resolveAuth and can never reach these
  // routes, but the handler must not rely on that (defence in depth).
  const deniedKinds: Array<{ name: string; auth: RouteContext['auth'] }> = [
    { name: 'future device kind', auth: DEVICE_AUTH },
    { name: 'federation kind', auth: FEDERATION_AUTH },
    { name: 'missing principal', auth: undefined },
  ]

  for (const { name, auth } of deniedKinds) {
    it(`denies ${name} on users GET/POST/DELETE and break-glass password reset`, async () => {
      await seedUser('alice')
      const list = await call('GET', '/api/auth/users', { auth })
      expect(list.res.statusCode).toBe(403)
      const create = await call('POST', '/api/auth/users', { auth, body: { username: 'mallory', password: GOOD_PW } })
      expect(create.res.statusCode).toBe(403)
      expect(getDashboardUser('mallory')).toBeUndefined()
      const del = await call('DELETE', '/api/auth/users/alice', { auth })
      expect(del.res.statusCode).toBe(403)
      expect(getDashboardUser('alice')).toBeDefined()
      const reset = await call('POST', '/api/auth/password', { auth, body: { username: 'alice', new_password: 'stolen-reset-pw' } })
      expect(reset.res.statusCode).toBe(403)
      // the old password must still work after the denied reset attempt
      const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
      expect(login.res.statusCode).toBe(200)
    })
  }

  it('keeps the token break-glass reset working (allowlist did not over-tighten)', async () => {
    await seedUser('alice')
    const reset = await call('POST', '/api/auth/password', { auth: TOKEN_AUTH, body: { username: 'alice', new_password: 'legit-reset-pw' } })
    expect(reset.res.statusCode).toBe(200)
  })
})
