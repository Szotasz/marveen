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
const { tryHandleGromzo } = await import('../web/routes/gromzo.js')
const { requiresAuth, SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { createSession } = await import('../web/auth-sessions.js')
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
    expect((await r.json()).code).toBe('owner_session_required')
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
