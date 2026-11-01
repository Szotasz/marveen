// GROMZOOWNERQR1030: the Gromzo panel's routes against a FAKE dash.sock.
// Never the real socket: each owner_invite / owner_login_code on it issues a live,
// rate-limited owner secret on the controller.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeMxdDash, INVITE_OK, LOGIN_OK, type FakeMxdDash } from './helpers/fake-mxd-dash.js'

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
}))

// Every argument any logger method receives, serialized, so "the secret never reaches
// the log" is asserted on everything that was handed to it.
const logged: string[] = []
vi.mock('../logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { m: v.message, s: v.stack } : v))) }
  const l: Record<string, unknown> = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec }
  l.child = () => l
  return { logger: l }
})

const env: Record<string, string> = {}
vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFile: (keys?: string[]) => (keys ? Object.fromEntries(keys.filter((k) => k in env).map((k) => [k, env[k]!])) : { ...env }),
}))

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { tryHandleGromzo, setGromzoAgentDepsForTest, pushAvatarAfterAdd, avatarAfterReload } = await import('../web/routes/gromzo.js')
const { resetPendingGromzoConsents } = await import('../web/gromzo-agents.js')
const { MxdDashError } = await import('../web/mxd-dash.js')
const AVATAR_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PIXELBYTESPIXELBYTES')])
const { MAIN_AGENT_ID: MAIN_ID } = await import('../config.js')
const { requiresAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { createSession, revokeSession } = await import('../web/auth-sessions.js')
const { isBlockedCrossOriginWrite } = await import('../web/csrf-origin.js')

let fake: FakeMxdDash
let server: http.Server
let origin = ''
// The principal the gate would have resolved for the next request.
let principal: Record<string, unknown> | undefined = { kind: 'token' }

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  fake = await startFakeMxdDash()
  env.MXD_DASH_SOCK = fake.path
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    // the same Origin gate web.ts runs before any route
    if (isBlockedCrossOriginWrite(method, req.headers.origin, req.headers.host, undefined, new Set([origin]))) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Origin not allowed"}'); return
    }
    const ctx = { req, res, path: url.pathname, method, url, auth: principal } as never
    if (!(await tryHandleGromzo(ctx))) { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.close(); await fake.close() })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  principal = { kind: 'session', user: 'owner' }
  fake.script.clear()
  fake.seen.length = 0
  logged.length = 0
})

const postQr = (headers: Record<string, string> = { 'Content-Type': 'application/json' }, body = '{}') =>
  fetch(origin + '/api/gromzo/owner-qr', { method: 'POST', headers, body })

describe('auth and same-origin', () => {
  it('both paths sit behind the dashboard auth gate', () => {
    expect(requiresAuth('/api/gromzo/status', 'GET')).toBe(true)
    expect(requiresAuth('/api/gromzo/owner-qr', 'POST')).toBe(true)
  })

  it('web.ts runs the Origin gate (403) before it dispatches to the Gromzo routes', () => {
    // The test server above re-runs the gate itself; this pins the real wiring.
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
    const gate = src.search(/if \(isBlockedCrossOriginWrite\([^)]*\)\) \{\s*logger\.warn\([^\n]*\n\s*res\.writeHead\(403/)
    const route = src.indexOf('await tryHandleGromzo(routeCtx)')
    expect(gate).toBeGreaterThan(-1)
    expect(route).toBeGreaterThan(gate)
  })

  it('a foreign Origin is refused before mxd is asked', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    const r = await postQr({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(fake.seen).toEqual([])
  })

  it('the same origin passes', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    expect((await postQr({ 'Content-Type': 'application/json', Origin: origin })).status).toBe(200)
  })

  it('a non-JSON body type is 415, mxd not asked', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    const r = await postQr({ 'Content-Type': 'text/plain' })
    expect(r.status).toBe(415)
    expect(fake.seen).toEqual([])
  })

  it('GET on the QR path is 405 (no secret through a cacheable, loggable GET)', async () => {
    const r = await fetch(origin + '/api/gromzo/owner-qr')
    expect(r.status).toBe(405)
    expect(fake.seen).toEqual([])
  })

  it('once a dashboard login exists, the shared token cannot mint the owner QR', async () => {
    createDashboardUser('owner', 'x')
    fake.script.set('owner_invite', INVITE_OK)
    principal = { kind: 'token' }
    const r = await postQr()
    expect(r.status).toBe(403)
    expect((await r.json()).code).toBe('owner_session_required')
    expect(fake.seen).toEqual([])
  })

  it('the owner session can; a sub-agent token, a device key and a federation peer cannot', async () => {
    createDashboardUser('owner', 'x')
    fake.script.set('owner_invite', INVITE_OK)
    principal = { kind: 'session', user: 'owner' }
    expect((await postQr()).status).toBe(200)
    for (const p of [{ kind: 'token', tokenAgent: 'samu', agent: 'samu' }, { kind: 'device', device: 'phone', deviceId: 1 }, { kind: 'federation', peer: 'x' }, undefined]) {
      principal = p
      expect((await postQr()).status, JSON.stringify(p)).toBe(403)
    }
  })

  it('before the first login exists, the shared token is still refused: every fleet agent holds it (Dani, #2365 review)', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    principal = { kind: 'token' }
    const r = await postQr()
    expect(r.status).toBe(403)
    const body = await r.json()
    expect(body.code).toBe('owner_session_required')
    // its own text: auth.ts's says the token works before the first login (Dani, #2365)
    expect(body.error).not.toMatch(/only before the first login/)
    expect(fake.seen).toEqual([])
  })

  it('once a login exists, the bare shared token is refused, the token with a live session cookie is the owner', async () => {
    const u = createDashboardUser('owner', 'x')
    fake.script.set('owner_invite', INVITE_OK)
    principal = { kind: 'token' }
    expect((await postQr()).status).toBe(403)
    const sid = createSession({ userId: u.id, username: u.username })
    expect((await postQr({ 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${sid}` })).status).toBe(200)
  })
})

// GROMZOAGENTPICK1101 (Samu 64370, Dani 64374): the Bridge sends its device key on every call; an owner action
// passes only with the owner's password-login session cookie on the same request. The key alone never.
describe('the Bridge: a full device key plus the owner session cookie', () => {
  const FULL = { kind: 'device', device: 'Macbookom', deviceId: 3, scope: 'full' }
  const OPERATOR = { kind: 'device', device: 'op', deviceId: 9, scope: 'operator' }
  const SUBAGENT = { kind: 'token', tokenAgent: 'samu', agent: 'samu' }
  let sid = ''
  beforeEach(() => {
    const u = createDashboardUser('owner', 'x')
    sid = createSession({ userId: u.id, username: u.username })
    fake.script.set('owner_invite', INVITE_OK)
    fake.script.set('status', { ok: true, running: true, linked: true })
  })
  const withCookie = (c: string) => ({ 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${c}` })
  const agents = (headers: Record<string, string> = {}) => fetch(origin + '/api/gromzo/agents', { headers })

  it('the key alone: 403 on both the owner QR and the agent list, mxd never asked', async () => {
    principal = FULL
    expect((await postQr()).status).toBe(403)
    expect((await agents()).status).toBe(403)
    expect(fake.seen).toEqual([])
  })

  it('the key plus a valid session cookie: the owner (QR 200, list 200)', async () => {
    principal = FULL
    expect((await postQr(withCookie(sid))).status).toBe(200)
    expect((await agents({ Cookie: `${SESSION_COOKIE_NAME}=${sid}` })).status).toBe(200)
  })

  it('the key plus a revoked (logged out), unknown or other-named cookie: 403', async () => {
    principal = FULL
    revokeSession(sid)
    expect((await postQr(withCookie(sid))).status).toBe(403)
    expect((await postQr(withCookie('not-a-session'))).status).toBe(403)
    const other = createSession({ userId: 1, username: 'owner' })
    expect((await postQr({ 'Content-Type': 'application/json', Cookie: `mv_operator=${other}` })).status).toBe(403)
    expect(fake.seen).toEqual([])
  })

  it('the key plus an EXPIRED session cookie (past the 30-day absolute life): 403', async () => {
    principal = FULL
    const real = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 31 * 24 * 3600 * 1000)
    try {
      expect((await postQr(withCookie(sid))).status).toBe(403)
    } finally { spy.mockRestore() }
    expect(fake.seen).toEqual([])
  })

  it('an operator key or a sub-agent token with a valid session cookie: 403', async () => {
    for (const p of [OPERATOR, SUBAGENT]) {
      principal = p
      expect((await postQr(withCookie(sid))).status, JSON.stringify(p)).toBe(403)
      expect((await agents({ Cookie: `${SESSION_COOKIE_NAME}=${sid}` })).status, JSON.stringify(p)).toBe(403)
    }
    expect(fake.seen).toEqual([])
  })

  it('the Origin gate still runs on the key-plus-cookie path', async () => {
    principal = FULL
    const r = await postQr({ ...withCookie(sid), Origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(fake.seen).toEqual([])
  })
})

describe('POST /api/gromzo/owner-qr', () => {
  it('free seat: the join URI, no-store, and the secret only inside uri', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    const r = await postQr()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toMatch(/\bno-store\b/)
    const text = await r.text()
    const body = JSON.parse(text)
    expect(body).toEqual({ kind: 'join', uri: 'marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=moi_INVITESECRET_x9Q', expires_in: 600 })
    expect(text.split(INVITE_OK.owner_secret).length - 1).toBe(1)
    expect(fake.seen).toEqual(['owner_invite'])
  })

  it('owner registered: falls back to the login code', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', LOGIN_OK)
    const r = await postQr()
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toMatch(/\bno-store\b/)
    expect(await r.json()).toEqual({ kind: 'login', uri: 'marveen://login?v=1&hs=https%3A%2F%2Fchat.gromzo.com&s=mol_LOGINSECRET_k2Z', expires_in: 120 })
    expect(fake.seen).toEqual(['owner_invite', 'owner_login_code'])
  })

  it('the logger never receives a secret (both kinds, success and failure paths)', async () => {
    fake.script.set('owner_invite', INVITE_OK)
    await postQr()
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', LOGIN_OK)
    await postQr()
    fake.script.set('owner_invite', { ...INVITE_OK, homeserver: 'http://x' }) // bad_reply path
    await postQr()
    expect(logged.length).toBeGreaterThan(0) // the logger was in fact called
    const all = logged.join('\n')
    for (const s of [INVITE_OK.owner_secret, LOGIN_OK.login_secret, 'INVITESECRET', 'LOGINSECRET']) expect(all).not.toContain(s)
    expect(all).toContain('owner QR issued')
  })

  it('rate limited: 429 with the code for a readable message', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'rate_limited' })
    const r = await postQr()
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'rate_limited' })
  })

  it('a Bridge-key install: 409 consent_required', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'consent_required' })
    const r = await postQr()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'consent_required' })
  })

  it('not linked / invite still out: 409 with the code', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'not_linked' })
    expect(await (await postQr()).json()).toEqual({ error: 'not_linked' })
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', { ok: false, error: 'no_owner' })
    const r = await postQr()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'invite_outstanding' })
  })

  it('GROMZORESETWAIT1031: the reset lock is 409 with retry_after, or 409 identity_reset_stalled with none', async () => {
    fake.script.set('owner_invite', { ok: false, error: 'owner_invite_already_issued' })
    fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_in_progress', retry_after: 420 })
    let r = await postQr()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'identity_reset_in_progress', retry_after: 420 })
    fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_stalled' })
    r = await postQr()
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'identity_reset_stalled' })
    fake.script.set('owner_login_code', { ok: false, error: 'identity_reset_in_progress' })
    expect(await (await postQr()).json()).toEqual({ error: 'identity_reset_in_progress' })
  })

  it('mxd down: 503 not_running; upstream: 502', async () => {
    env.MXD_DASH_SOCK = fake.path + '.missing'
    try {
      const r = await postQr()
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ error: 'not_running' })
    } finally { env.MXD_DASH_SOCK = fake.path }
    fake.script.set('owner_invite', { ok: false, error: 'upstream' })
    expect((await postQr()).status).toBe(502)
  })

  it('an error response never carries a secret even when mxd sent one with a bad shape', async () => {
    fake.script.set('owner_invite', { ok: true, homeserver: 'https://chat.gromzo.com', owner_secret: 'mol_SNEAKY', expires_in: 600 })
    const r = await postQr()
    expect(r.status).toBe(502)
    expect(await r.text()).not.toContain('SNEAKY')
  })
})

describe('the page that draws the secret', () => {
  // The QR library runs in the same page as the owner secret: a swapped CDN reply
  // could read the URI. Pinned by Subresource Integrity (Dani, #2365 review); the
  // hash is of the npm tarball's dist/qrcode.js, which jsDelivr serves unchanged.
  it('loads qrcode-generator only at the exact version, with integrity and crossorigin', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf-8')
    const tags = html.match(/<script[^>]*qrcode-generator[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    expect(tags[0]).toContain('qrcode-generator@2.0.4/')
    expect(tags[0]).toMatch(/\sintegrity="sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV\/hPB0E0go\+H3I64h7oHtA"/)
    expect(tags[0]).toMatch(/\scrossorigin="anonymous"/)
  })
})

describe('GET /api/gromzo/status', () => {
  it('linked and running', async () => {
    fake.script.set('status', { ok: true, running: true, linked: true, pending: { op: 'link', expires_in: 5 } })
    const r = await fetch(origin + '/api/gromzo/status')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ available: true, running: true, linked: true })
  })

  it('mxd not installed / not running is a state, not an error', async () => {
    env.MXD_DASH_SOCK = fake.path + '.missing'
    try {
      expect(await (await fetch(origin + '/api/gromzo/status')).json()).toEqual({ available: false, code: 'not_running' })
    } finally { env.MXD_DASH_SOCK = fake.path }
  })

  it('a wrong dashboard uid (mxd forbidden) is reported', async () => {
    fake.script.set('status', { ok: false, error: 'forbidden' })
    expect(await (await fetch(origin + '/api/gromzo/status')).json()).toEqual({ available: false, code: 'forbidden' })
  })

  it('POST on status is 405', async () => {
    expect((await fetch(origin + '/api/gromzo/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405)
  })
})

// GROMZOAGENTPICK1101: the agent switch's routes, with injected collaborators (the rules themselves are in
// gromzo-agents.test.ts). Never the real dash.sock, never a real agent restart.
describe('the agent switch routes', () => {
  const calls: Array<Record<string, unknown>> = []
  const restarted: string[] = []
  const flags = new Map<string, boolean>()
  let replies: Record<string, Array<Record<string, unknown>>> = {}
  beforeEach(() => {
    calls.length = 0; restarted.length = 0; flags.clear(); replies = {}
    resetPendingGromzoConsents()
    setGromzoAgentDepsForTest({
      call: async (req) => {
        calls.push(req)
        const r = replies[req.verb]?.shift()
        if (!r) throw new Error('unscripted ' + req.verb)
        return r
      },
      agents: () => ['samu', 'zara'],
      readFlag: (s) => flags.get(s) ?? false,
      writeFlag: (s, on) => { flags.set(s, on) },
      displayName: (s) => s,
      isRunning: () => true,
      held: async () => new Set(),
      readAvatar: (s) => (s === 'zara' ? { ok: true, bytes: AVATAR_PNG } : s === 'samu' ? { ok: false, code: 'avatar_too_large' } : { ok: false, code: 'no_avatar' }),
      avatarProblem: (s) => (s === 'zara' ? null : s === 'samu' ? 'avatar_too_large' : 'no_avatar'),
      restartOne: (s) => { restarted.push(s) },
      now: () => Date.now(),
    })
  })
  afterAll(() => setGromzoAgentDepsForTest(null))

  const post = (p: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }, body = '{}') =>
    fetch(origin + '/api/gromzo/agents/' + p, { method: 'POST', headers, body })

  it('all four sit behind the auth gate', () => {
    expect(requiresAuth('/api/gromzo/agents', 'GET')).toBe(true)
    expect(requiresAuth('/api/gromzo/agents/zara/enable', 'POST')).toBe(true)
    expect(requiresAuth('/api/gromzo/agents/zara/consent', 'POST')).toBe(true)
    expect(requiresAuth('/api/gromzo/agents/zara/disable', 'POST')).toBe(true)
  })

  it('only the owner session: a token, a sub-agent, a device, a peer get 403 and mxd is not asked', async () => {
    replies.agent_add = [{ ok: true, consent_id: 'consent-aaaaaaaaaaaa', expires_in: 600 }]
    for (const p of [{ kind: 'token' }, { kind: 'token', tokenAgent: 'samu', agent: 'samu' }, { kind: 'device', device: 'phone', deviceId: 1 }, { kind: 'federation', peer: 'x' }, undefined]) {
      principal = p
      for (const r of [await fetch(origin + '/api/gromzo/agents'), await post('zara/enable'), await post('zara/consent'), await post('zara/disable')]) {
        expect(r.status, JSON.stringify(p)).toBe(403)
      }
    }
    expect(calls).toEqual([])
    expect(flags.size).toBe(0)
  })

  it('POST needs JSON (415), a foreign Origin is 403, wrong methods are 405; mxd not asked', async () => {
    expect((await post('zara/enable', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post('zara/disable', { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403)
    expect((await fetch(origin + '/api/gromzo/agents/zara/enable')).status).toBe(405)
    // the consent check changes state (it may add the agent, write its flag, restart it): POST only, behind the gates
    expect((await fetch(origin + '/api/gromzo/agents/zara/consent')).status).toBe(405)
    expect((await post('zara/consent', { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post('zara/consent', { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403)
    expect((await fetch(origin + '/api/gromzo/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405)
    expect(calls).toEqual([])
  })

  it('the list: the main agent and the fleet with their flags', async () => {
    flags.set('zara', true)
    const r = await fetch(origin + '/api/gromzo/agents')
    expect(r.status).toBe(200)
    const rows = (await r.json()).agents as Array<{ slug: string, gromzo: boolean, main: boolean }>
    expect(rows.filter((x) => !x.main).map((x) => [x.slug, x.gromzo])).toEqual([['samu', false], ['zara', true]])
  })

  it('the consent id never reaches a response or the log (pending, added, mismatch, failure; Dani 64094 (6))', async () => {
    const ID = 'consent-SECRETIDSECRET'
    const bodies: string[] = []
    const keep = async (r: Response) => { bodies.push(await r.text()); return r }
    replies.agent_add = [{ ok: true, consent_id: ID, expires_in: 600 }]
    await keep(await post('zara/enable'))
    replies.agent_add_check = [{ ok: true, state: 'added', slug: 'samu', restart: true }]
    await keep(await post('zara/consent'))
    await keep(await fetch(origin + '/api/gromzo/agents'))
    replies.agent_add = [{ ok: true, consent_id: ID, expires_in: 600 }]
    await keep(await post('samu/enable'))
    replies.agent_add_check = [{ ok: false, error: 'upstream' }]
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c.verb === 'agent_add_check').map((c) => c.id)).toEqual([ID])
    expect(logged.length).toBeGreaterThan(0)
    for (const text of [...bodies, logged.join('\n')]) expect(text).not.toContain('SECRETIDSECRET')
    expect(bodies.join('\n')).toContain('consent_mismatch')
  })

  it('enable -> pending; the consent check uses the server\'s id even when the client sends one', async () => {
    replies.agent_add = [{ ok: true, consent_id: 'consent-aaaaaaaaaaaa', expires_in: 600 }]
    const e = await post('zara/enable', { 'Content-Type': 'application/json' }, JSON.stringify({ id: 'consent-evilevilevil' }))
    expect(e.status).toBe(200)
    expect(await e.json()).toEqual({ state: 'pending', expires_in: 600 })
    replies.agent_add_check = [{ ok: true, state: 'added', slug: 'zara', restart: true }]
    const c = await post('zara/consent?id=consent-evilevilevil', { 'Content-Type': 'application/json' }, JSON.stringify({ id: 'consent-evilevilevil' }))
    expect(await c.json()).toEqual({ state: 'added' })
    expect(calls.map((x) => x.verb === 'agent_add_check' ? x.id : x.verb)).toEqual(['agent_add', 'consent-aaaaaaaaaaaa'])
    expect(flags.get('zara')).toBe(true)
    expect(restarted).toEqual(['zara'])
  })

  it('consent_mismatch: 409 names the slug mxd actually added; neither flag is written, nothing restarted (Dani 64260)', async () => {
    replies.agent_add = [{ ok: true, consent_id: 'consent-aaaaaaaaaaaa', expires_in: 600 }]
    await post('zara/enable')
    replies.agent_add_check = [{ ok: true, state: 'added', slug: 'samu', restart: true }]
    const r = await post('zara/consent')
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'consent_mismatch', added_slug: 'samu' })
    expect(flags.size).toBe(0)
    expect(restarted).toEqual([])
    expect(logged.join('\n')).toContain('"added":"samu"')
  })

  it('no manual picture route (owner, Slack 15:48): POST .../avatar is not a route', async () => {
    expect((await post('zara/avatar')).status).toBe(404)
    expect(calls).toEqual([])
  })

  it('the list load sends no picture (only an add does; Samu 64633)', async () => {
    flags.set('zara', true)
    expect((await fetch(origin + '/api/gromzo/agents')).status).toBe(200)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.filter((c) => c.verb === 'agent_avatar')).toEqual([])
  })

  it('after an add: the picture goes, with up to 3 tries while mxd settles; a refusal or no picture never throws (the add stands)', async () => {
    replies.agent_avatar = [{ ok: false, error: 'unavailable' }, { ok: false, error: 'unavailable' }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0)
    expect(calls.filter((c) => c.verb === 'agent_avatar')).toHaveLength(3)
    expect(logged.join('\n')).toContain('picture sent after the add')
    // never the picture in any form: not base64, not a Buffer, not its bytes
    for (const leak of [AVATAR_PNG.toString('base64'), '"Buffer"', 'PIXELBYTES', 'avatar.png']) expect(logged.join('\n')).not.toContain(leak)
    calls.length = 0
    replies.agent_avatar = [{ ok: false, error: 'rate_limited' }]
    await expect(pushAvatarAfterAdd('zara', 0)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1) // no retry on a real refusal
    calls.length = 0
    replies.agent_avatar = [{ ok: false, error: 'unavailable' }, { ok: false, error: 'unavailable' }, { ok: false, error: 'unavailable' }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0)
    expect(calls).toHaveLength(3) // bounded
    calls.length = 0
    await expect(pushAvatarAfterAdd('samu', 0)).resolves.toBeUndefined() // too large: no call at all
    expect(calls).toEqual([])
    expect(logged.join('\n')).toContain('picture NOT sent after the add (the add stands)')
  })

  // GAZDA-TESZT build 19 (Samu 65189): Nora's add answered applied=false (mxd stored the picture, the new agent was not
  // running there yet) and it was logged as "picture sent", with no try again: the picture never showed.
  const settle = () => new Promise((r) => setTimeout(r, 40))
  const avatarCalls = () => calls.filter((c) => c.verb === 'agent_avatar').length

  it('applied=false: a WARN (stored, not set), then sent again in the background until mxd sets it', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    const log0 = logged.join('\n')
    expect(log0).toContain('picture stored by mxd but NOT set on the agent yet')
    expect(log0).not.toContain('picture sent after the add')
    await settle()
    expect(avatarCalls()).toBe(2)
    expect(logged.join('\n')).toMatch(/picture set on the agent[\s\S]*"try":2|"try":2[\s\S]*picture set on the agent/)
  })

  // MXDAVATARAPPLY1101 (Samu 65642): mxd stored the picture while its agents were still starting and sets it itself
  // once they run, so there is no fixed 65 s try again; an older mxd (no pending field) keeps the try-again line.
  it('pending: stored while mxd starts its agents -> an INFO that mxd sets it, and NO try again', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false, pending: true }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(1)
    const log = logged.join('\n')
    expect(log).toContain('mxd sets it once they run (no try again)')
    expect(log).not.toContain('NOT set on the agent yet')
    expect(log).not.toContain('picture sent after the add')
  })

  it('pending only counts with applied=false; a pending on a retry ends the line too', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: true, pending: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    expect(logged.join('\n')).toContain('picture sent after the add')
    calls.length = 0
    logged.length = 0
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: false, pending: true }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(2)
    expect(logged.join('\n')).toMatch(/no try again\)[\s\S]*"try":2|"try":2[\s\S]*no try again\)/)
  })

  it('an older mxd: pending absent or not exactly true keeps the try-again line', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false, pending: 'yes' }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(2)
    expect(logged.join('\n')).toContain('NOT set on the agent yet; sending it again')
  })

  it('applied=false every time: bounded at 3 sends, then a WARN that the next agent start sets it; a rate limit counts as a try', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: false, error: 'rate_limited' }, { ok: true, applied: false }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(3)
    expect(logged.join('\n')).toContain("picture still NOT set on the agent; mxd sets the stored one at the agent's next start")
  })

  it('the retry stops when the switch went off meanwhile, and on a real refusal', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    flags.set('zara', false)
    await settle()
    expect(avatarCalls()).toBe(1)
    expect(logged.join('\n')).toContain('picture retry stopped (the switch went off)')
    calls.length = 0
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: false, error: 'unknown_agent' }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(2)
    expect(logged.join('\n')).toContain('picture NOT sent on the retry (the add stands)')
  })

  it('one try-again line per agent at a time (Dani 65222/2); each send reads the current file, the log never the picture', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: false }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 20)
    await pushAvatarAfterAdd('zara', 0, 20) // a second add while the first line waits
    expect(logged.join('\n')).toContain('a try again already runs for it')
    await new Promise((r) => setTimeout(r, 120))
    expect(avatarCalls()).toBe(3) // 2 first sends + ONE retry, not two
    const sent = calls.filter((c) => c.verb === 'agent_avatar').map((c) => c.image)
    expect(new Set(sent).size).toBe(1)
    expect(sent[0]).toBe(AVATAR_PNG.toString('base64'))
    for (const leak of [AVATAR_PNG.toString('base64'), '"Buffer"', 'PIXELBYTES']) expect(logged.join('\n')).not.toContain(leak)
    // the line is free again once it ended
    calls.length = 0
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: true }]
    await pushAvatarAfterAdd('zara', 0, 1)
    await settle()
    expect(avatarCalls()).toBe(2)
  })

  it('the agent restart does not wait for the background tries', async () => {
    flags.set('zara', true)
    replies.agent_avatar = [{ ok: true, applied: false }, { ok: true, applied: true }]
    const t0 = Date.now()
    await pushAvatarAfterAdd('zara', 0, 400)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(avatarCalls()).toBe(1)
    await new Promise((r) => setTimeout(r, 500)) // let the line end, so no later test inherits it
    expect(avatarCalls()).toBe(2)
  })

  it('after the reload: an add (flag on) sends the picture, a remove (flag off) sends nothing, and says so', async () => {
    replies.agent_avatar = [{ ok: true, applied: true }]
    await avatarAfterReload('zara', 0)
    expect(calls).toEqual([])
    expect(logged.join('\n')).toContain('no picture sent (the switch is off: a remove)')
    flags.set('zara', true)
    await avatarAfterReload('zara', 0)
    expect(calls.map((c) => [c.verb, c.slug])).toEqual([['agent_avatar', 'zara']])
  })

  it('the list carries avatarProblem per row', async () => {
    flags.set('zara', true)
    const rows = (await (await fetch(origin + '/api/gromzo/agents')).json()).agents as Array<{ slug: string, avatarProblem: string | null }>
    expect(rows.filter((r) => r.slug !== MAIN_ID).map((r) => [r.slug, r.avatarProblem])).toEqual([['samu', 'avatar_too_large'], ['zara', null]])
  })

  it('codes map to statuses: a bad slug 400, unknown 404, the main agent 409, no pending 409, rate_limited 429, mxd down 503', async () => {
    expect((await post('Bad%20Slug/enable')).status).toBe(400)
    expect((await post('nobody/enable')).status).toBe(404)
    expect((await post(encodeURIComponent(MAIN_ID) + '/disable')).status).toBe(409)
    expect((await post('zara/consent')).status).toBe(409)
    expect(calls).toEqual([])
    replies.agent_remove = [{ ok: false, error: 'rate_limited' }]
    const r = await post('zara/disable')
    expect(r.status).toBe(429)
    expect((await r.json()).error).toBe('rate_limited')
    setGromzoAgentDepsForTest({
      call: async () => { throw new MxdDashError('not_running') },
      agents: () => ['zara'], readFlag: () => true, writeFlag: () => { throw new Error('no write') },
      displayName: (s) => s, isRunning: () => true, held: async () => new Set(), restartOne: () => { throw new Error('no restart') }, now: () => Date.now(),
    })
    expect((await post('zara/disable')).status).toBe(503)
  })
})

describe('the held list from the real dash status (fake dash.sock)', () => {
  beforeEach(() => {
    resetPendingGromzoConsents()
    // the real call and held reader; a fixed fleet
    setGromzoAgentDepsForTest({ agents: () => ['samu', 'zara'], readFlag: () => true, displayName: (s) => s, isRunning: () => true })
  })
  afterAll(() => setGromzoAgentDepsForTest(null))

  it('held_agents slugs are read from status; anything that is not a slug is dropped', async () => {
    fake.script.set('status', { ok: true, running: true, linked: true, held_agents: ['zara', '../samu', 7, 'Samu'] })
    const r = await fetch(origin + '/api/gromzo/agents')
    expect(r.status).toBe(200)
    const rows = (await r.json()).agents as Array<{ slug: string, held: boolean }>
    expect(rows.filter((x) => x.held).map((x) => x.slug)).toEqual(['zara'])
    expect(fake.seen).toEqual(['status'])
  })

  it('no held_agents field (the empty case) or mxd down: nobody is held, the list still answers', async () => {
    fake.script.set('status', { ok: true, running: true, linked: true })
    let rows = (await (await fetch(origin + '/api/gromzo/agents')).json()).agents as Array<{ held: boolean }>
    expect(rows.some((x) => x.held)).toBe(false)
    env.MXD_DASH_SOCK = fake.path + '.gone'
    try {
      const r = await fetch(origin + '/api/gromzo/agents')
      expect(r.status).toBe(200)
      rows = (await r.json()).agents
      expect(rows.some((x) => x.held)).toBe(false)
    } finally { env.MXD_DASH_SOCK = fake.path }
  })
})
