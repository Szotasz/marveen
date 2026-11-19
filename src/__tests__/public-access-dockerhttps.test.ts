// DOCKERHTTPS1119 (Dani 81091, Samu 81093): the public (domain) path of a Docker install.
// - On the public listener only browser cookies authenticate: the shared token, a sub-agent token, a device key, the
//   SSE ?token= and a forged X-Forwarded-For refuse there, and the same token keeps working on the internal listener.
// - The one-time setup code: 128 bits, constant-time, used up on its first redemption, expires, and gives a setup
//   session that creates the FIRST login only; every other first-run path refuses it, and the first login ends it.
// - POST /api/auth/setup-code: public listener only, refused once a login exists, throttled, Secure cookie.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, createDashboardUser } from '../db.js'
import { resolveAuth, requiresAuth, gateRequest, PUBLIC_LISTENER_OPEN_PATHS, SETUP_SESSION_PATHS, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { scanRoutes } from './helpers/route-owner-scan.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { tryHandleAuth, mayActAsOwnerOrFirstRun, FIRST_RUN_PATHS, isHttps } from '../web/routes/auth.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { _resetThrottleForTest } from '../web/login-throttle.js'
import {
  SETUP_COOKIE_NAME, SETUP_CODE_TTL_MS, SETUP_SESSION_TTL_S, issueSetupCode, redeemSetupCode, setupCodeAvailable,
  isSetupSession, markPublicRequest, publicListenerPort, _resetPublicAccessForTest,
} from '../web/public-access.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = 'c'.repeat(64)
const GOOD_PW = 'super-secret-pw'

function mkReq(headers: Record<string, string> = {}, publicListener = false, body?: unknown): http.IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  if (publicListener) markPublicRequest(req)
  return req
}

async function call(method: string, path: string, auth: RouteContext['auth'], opts: { publicListener?: boolean; body?: unknown; headers?: Record<string, string> } = {}) {
  const req = mkReq(opts.headers ?? {}, opts.publicListener === true, opts.body)
  const out = { status: 0, body: '', headers: {} as Record<string, string> }
  const res = {
    writeHead(s: number, h?: Record<string, string>) { out.status = s; if (h) Object.assign(out.headers, h); return res },
    setHeader(k: string, v: string) { out.headers[k] = v },
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL(`http://127.0.0.1:3421${path}`)
  expect(await tryHandleAuth({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth })).toBe(true)
  return { status: out.status, headers: out.headers, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  _resetThrottleForTest()
  _resetPublicAccessForTest()
})

describe('the public listener accepts browser cookies only', () => {
  const url = (p: string, q = '') => new URL(`http://127.0.0.1:3421${p}${q}`)

  it('refuses the shared token there, which still works on the internal listener', () => {
    const headers = { authorization: `Bearer ${TOKEN}` }
    expect(resolveAuth(mkReq(headers), url('/api/memories'), '/api/memories', 'GET', TOKEN).kind).toBe('token')
    expect(resolveAuth(mkReq(headers, true), url('/api/memories'), '/api/memories', 'GET', TOKEN, undefined, true).kind).toBe('none')
  })

  it('refuses a sub-agent token there', () => {
    const resolver = (t: string) => (t === 'sub-token' ? 'zara' : null)
    const req = mkReq({ authorization: 'Bearer sub-token' }, true)
    expect(resolveAuth(req, url('/api/memories'), '/api/memories', 'GET', TOKEN, resolver, true).kind).toBe('none')
    expect(resolveAuth(mkReq({ authorization: 'Bearer sub-token' }), url('/api/memories'), '/api/memories', 'GET', TOKEN, resolver).kind).toBe('token')
  })

  it('refuses the SSE ?token= there', () => {
    const p = '/api/agents/zara/pane/stream'
    expect(resolveAuth(mkReq({}), url(p, `?token=${TOKEN}`), p, 'GET', TOKEN).kind).toBe('token')
    expect(resolveAuth(mkReq({}, true), url(p, `?token=${TOKEN}`), p, 'GET', TOKEN, undefined, true).kind).toBe('none')
  })

  it('a forged X-Forwarded-For: 127.0.0.1 changes nothing (negative control)', () => {
    const req = mkReq({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }, true)
    expect(resolveAuth(req, url('/api/memories'), '/api/memories', 'GET', TOKEN, undefined, true).kind).toBe('none')
  })

  it('accepts the owner session cookie there, and marks cookies Secure there', () => {
    const u = createDashboardUser('owner', 'x')
    const sid = createSession({ userId: u.id, username: u.username })
    const req = mkReq({ cookie: `${SESSION_COOKIE_NAME}=${sid}` }, true)
    expect(resolveAuth(req, url('/api/memories'), '/api/memories', 'GET', TOKEN, undefined, true)).toEqual({ kind: 'session', user: 'owner' })
    expect(isHttps(mkReq({}, true))).toBe(true)
    expect(isHttps(mkReq({}))).toBe(false)
  })

  it('the setup cookie counts on the public listener only, and only while no login exists', () => {
    issueSetupCode()
    const code = issueSetupCode()
    const value = redeemSetupCode(code)!
    const cookie = { cookie: `${SETUP_COOKIE_NAME}=${value}` }
    expect(resolveAuth(mkReq(cookie, true), url('/api/auth/users'), '/api/auth/users', 'POST', TOKEN, undefined, true).kind).toBe('setup')
    expect(resolveAuth(mkReq(cookie), url('/api/auth/users'), '/api/auth/users', 'POST', TOKEN).kind).toBe('none')
    createDashboardUser('owner', 'x')
    expect(resolveAuth(mkReq(cookie, true), url('/api/auth/users'), '/api/auth/users', 'POST', TOKEN, undefined, true).kind).toBe('none')
  })

  it('the setup-code route is public; everything else stays gated', () => {
    expect(requiresAuth('/api/auth/setup-code', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/setup-code', 'GET')).toBe(true)
  })

  it('the listener port comes from WEB_PUBLIC_PORT only, and a bad value means no listener', () => {
    expect(publicListenerPort({ WEB_PUBLIC_PORT: '3421' })).toBe(3421)
    expect(publicListenerPort({})).toBeNull()
    for (const bad of ['', 'abc', '0', '70000', '3421x']) expect(publicListenerPort({ WEB_PUBLIC_PORT: bad }), bad).toBeNull()
  })
})

// Dani 81108 N1: with no principal, the public listener reaches only a closed list of unauthenticated /api/ paths.
describe('the public listener with no cookie reaches only the closed list', () => {
  async function gate(path: string, method: string, publicListener: boolean, headers: Record<string, string> = {}) {
    const out = { status: 0 }
    const res = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end() {} }
    const url = new URL(`http://127.0.0.1:3421${path}`)
    const auth = await gateRequest(mkReq(headers, publicListener), res as unknown as http.ServerResponse, url, path, method, { dashboardToken: TOKEN, mainAgentId: 'marveen', publicListener })
    return { auth, status: out.status }
  }

  it('the Teams card callback, the operator key login, an avatar and the video file: 404 there, unchanged on 3420', async () => {
    for (const [method, path] of [['POST', '/api/approvals/teams-card-action'], ['POST', '/api/operator/login'], ['GET', '/api/agents/zara/avatar'], ['GET', '/api/video-review/file']] as const) {
      expect(requiresAuth(path, method), path).toBe(false)
      const pub = await gate(path, method, true)
      expect([pub.auth, pub.status], path).toEqual([null, 404])
      const internal = await gate(path, method, false)
      expect(internal.auth?.kind, path).toBe('none')
      expect(internal.status, path).toBe(0)
    }
  })

  it('the sign-in probes and steps stay open there', async () => {
    for (const [method, path] of PUBLIC_LISTENER_OPEN_PATHS) {
      // /api/auth/login/totp joins requiresAuth's open list with Geri's TOTP PR; until then the gate still asks for auth
      if (requiresAuth(path, method)) continue
      const r = await gate(path, method, true)
      expect([r.auth?.kind, r.status], path).toEqual(['none', 0])
    }
  })

  it('with the owner session cookie an avatar loads there', async () => {
    const u = createDashboardUser('owner', 'x')
    const sid = createSession({ userId: u.id, username: u.username })
    const r = await gate('/api/agents/zara/avatar', 'GET', true, { cookie: `${SESSION_COOKIE_NAME}=${sid}` })
    expect(r.auth?.kind).toBe('session')
  })
})

// Geri's live run (81231) 4: a setup session read GET /api/memories. It reaches only SETUP_SESSION_PATHS among the
// gated paths now; everything else is 403 setup_session_scope.
describe('the setup session reaches only the closed list among gated paths', () => {
  async function gateSetup(path: string, method: string) {
    issueSetupCode()
    const value = redeemSetupCode(issueSetupCode())!
    const out = { status: 0, body: '' }
    const res = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(d?: string) { if (d) out.body += d } }
    const url = new URL(`http://127.0.0.1:3421${path}`)
    const auth = await gateRequest(mkReq({ cookie: `${SETUP_COOKIE_NAME}=${value}` }, true), res as unknown as http.ServerResponse, url, path, method, { dashboardToken: TOKEN, mainAgentId: 'marveen', publicListener: true })
    return { auth, status: out.status, body: out.body }
  }

  // Samu 81244: EVERY gated route, so a new one cannot open to a setup session quietly. The literal routes of the
  // router (`path === '/api/...' && method === '...'` in src/web.ts and src/web/routes/*.ts, GETs included), plus the
  // state-changing routes the owner-pin scanner finds; a matcher route (a regex) is covered by the same path-blind rule.
  it('every gated literal route of the router: 403 for a setup session, except the two allowed', async () => {
    const files = [join(__dirname, '..', 'web.ts'), ...readdirSync(join(__dirname, '..', 'web', 'routes')).filter((f) => f.endsWith('.ts')).map((f) => join(__dirname, '..', 'web', 'routes', f))]
    const routes = new Set<string>()
    for (const f of files) {
      for (const m of readFileSync(f, 'utf-8').matchAll(/path === '(\/api\/[^']+)' && method === '(GET|POST|PUT|PATCH|DELETE)'/g)) routes.add(`${m[2]} ${m[1]}`)
    }
    for (const r of scanRoutes(join(__dirname, '..', '..')).routes) {
      if (r.pathKey.startsWith('/api/')) for (const m of r.methods) routes.add(`${m} ${r.pathKey}`)
    }
    expect(routes.size).toBeGreaterThan(200)
    const allowed = new Set(SETUP_SESSION_PATHS.map(([m, p]) => `${m} ${p}`))
    const wrong: string[] = []
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string]
      if (!requiresAuth(path, method)) continue
      const r = await gateSetup(path, method)
      const ok = allowed.has(route) ? r.auth?.kind === 'setup' && r.status === 0 : r.auth === null && r.status === 403 && JSON.parse(r.body).code === 'setup_session_scope'
      if (!ok) wrong.push(`${route} -> ${r.status}`)
    }
    expect(wrong).toEqual([])
  })

  it('a read and a write outside the list: 403 setup_session_scope', async () => {
    for (const [method, path] of [['GET', '/api/memories'], ['GET', '/api/agents'], ['POST', '/api/onboarding/identity'], ['GET', '/api/auth/users']] as const) {
      const r = await gateSetup(path, method)
      expect([r.auth, r.status], path).toEqual([null, 403])
      expect(JSON.parse(r.body).code, path).toBe('setup_session_scope')
    }
  })

  // Dani n1 (81264): the setup session counts as no principal for the closed public list too.
  it('the self-authenticating public routes: 404 for a setup session, as for no cookie', async () => {
    for (const [method, path] of [['POST', '/api/approvals/teams-card-action'], ['POST', '/api/operator/login'], ['GET', '/api/agents/zara/avatar'], ['GET', '/api/video-review/file']] as const) {
      expect(requiresAuth(path, method), path).toBe(false)
      const r = await gateSetup(path, method)
      expect([r.auth, r.status], path).toEqual([null, 404])
    }
  })

  it('the wizard state and creating the first login pass the gate', async () => {
    // the list itself is pinned: widening it is a review decision, not a quiet edit
    expect(SETUP_SESSION_PATHS).toEqual([['GET', '/api/onboarding/status'], ['POST', '/api/auth/users']])
    for (const [method, path] of SETUP_SESSION_PATHS) {
      const r = await gateSetup(path, method)
      expect([r.auth?.kind, r.status], path).toEqual(['setup', 0])
    }
  })
})

// Geri's live run (81231) 1: first-boot writes WEB_PUBLIC_PORT into .env only; the listener must read it from there.
describe('WEB_PUBLIC_PORT comes from the install .env', () => {
  it('config.ts reads it from the .env file, and web.ts hands that value to publicListenerPort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webpublicport-'))
    const saved = { dir: process.env.CLAUDECLAW_ENV_DIR, port: process.env.WEB_PUBLIC_PORT }
    try {
      writeFileSync(join(dir, '.env'), 'WEB_PUBLIC_PORT=3421\n')
      process.env.CLAUDECLAW_ENV_DIR = dir
      delete process.env.WEB_PUBLIC_PORT
      vi.resetModules()
      const cfg = await import('../config.js')
      expect(cfg.WEB_PUBLIC_PORT).toBe('3421')
    } finally {
      if (saved.dir === undefined) delete process.env.CLAUDECLAW_ENV_DIR; else process.env.CLAUDECLAW_ENV_DIR = saved.dir
      if (saved.port !== undefined) process.env.WEB_PUBLIC_PORT = saved.port
      vi.resetModules()
      rmSync(dir, { recursive: true, force: true })
    }
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    expect(web).toContain('publicListenerPort({ WEB_PUBLIC_PORT })')
    expect(web).not.toMatch(/publicListenerPort\(\)/)
  })
})

describe('the one-time setup code', () => {
  it('is 128 random bits (32 hex), only its first redemption counts, and it accepts what a person types', () => {
    const code = issueSetupCode()
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(redeemSetupCode('0'.repeat(32))).toBeNull()
    const typed = ` ${code.slice(0, 8).toUpperCase()}-${code.slice(8)} `
    const value = redeemSetupCode(typed)
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(isSetupSession(value!)).toBe(true)
    expect(redeemSetupCode(code)).toBeNull()
    expect(setupCodeAvailable()).toBe(false)
  })

  it('expires, and so does the setup session', () => {
    const t0 = 1_000_000
    const code = issueSetupCode(t0)
    expect(redeemSetupCode(code, t0 + SETUP_CODE_TTL_MS)).toBeNull()
    const code2 = issueSetupCode(t0)
    const value = redeemSetupCode(code2, t0 + 1000)!
    expect(isSetupSession(value, t0 + 1000 + SETUP_SESSION_TTL_S * 1000 - 1)).toBe(true)
    expect(isSetupSession(value, t0 + 1000 + SETUP_SESSION_TTL_S * 1000)).toBe(false)
  })

  it('a new code ends the old sessions', () => {
    const value = redeemSetupCode(issueSetupCode())!
    issueSetupCode()
    expect(isSetupSession(value)).toBe(false)
  })
})

describe('the setup session on the first-run gate', () => {
  it('creates the first login only; every other first-run path refuses it', () => {
    for (const why of FIRST_RUN_PATHS) {
      expect(mayActAsOwnerOrFirstRun({ kind: 'setup' }, mkReq({}, true), why), why).toBe(why === 'first-login')
    }
  })

  it('no first-run path opens to it once a login exists (disabled counted)', () => {
    createDashboardUser('owner', 'x')
    getDb().exec('UPDATE dashboard_users SET disabled = 1')
    for (const why of FIRST_RUN_PATHS) expect(mayActAsOwnerOrFirstRun({ kind: 'setup' }, mkReq({}, true), why), why).toBe(false)
  })
})

describe('POST /api/auth/setup-code', () => {
  it('exists on the public listener only', async () => {
    issueSetupCode()
    expect((await call('POST', '/api/auth/setup-code', undefined, { body: { code: 'x' } })).status).toBe(404)
  })

  it('redeems the code once, with a Secure HttpOnly SameSite=Strict cookie; the same code again refuses', async () => {
    const code = issueSetupCode()
    const ok = await call('POST', '/api/auth/setup-code', undefined, { publicListener: true, body: { code } })
    expect(ok.status).toBe(200)
    const cookie = ok.headers['Set-Cookie']
    expect(cookie).toMatch(new RegExp(`^${SETUP_COOKIE_NAME}=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SETUP_SESSION_TTL_S}$`))
    const again = await call('POST', '/api/auth/setup-code', undefined, { publicListener: true, body: { code } })
    expect(again.status).toBe(401)
  })

  it('a wrong code refuses, and repeated wrong codes are throttled', async () => {
    issueSetupCode()
    let last = 0
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/setup-code', undefined, { publicListener: true, body: { code: `wrong-${i}` } })).status
    expect(last).toBe(429)
  })

  it('refuses once a dashboard login exists', async () => {
    const code = issueSetupCode()
    createDashboardUser('owner', 'x')
    expect((await call('POST', '/api/auth/setup-code', undefined, { publicListener: true, body: { code } })).status).toBe(409)
  })

  it('the setup session creates the first login; the status probe on the public listener says when a code is needed', async () => {
    issueSetupCode()
    const before = await call('GET', '/api/auth/status', undefined, { publicListener: true })
    expect(before.json().setup_code).toBe(true)
    expect((await call('GET', '/api/auth/status', undefined)).json().setup_code).toBeUndefined()
    const created = await call('POST', '/api/auth/users', { kind: 'setup' }, { publicListener: true, body: { username: 'owner', password: GOOD_PW } })
    expect(created.status).toBe(201)
    // the second login is the owner's business, not the setup session's
    const second = await call('POST', '/api/auth/users', { kind: 'setup' }, { publicListener: true, body: { username: 'other', password: GOOD_PW } })
    expect(second.status).toBe(403)
  })
})
