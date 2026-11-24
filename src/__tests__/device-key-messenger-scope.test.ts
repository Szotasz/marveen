// MVDKSCOPE917: a 'messenger' scoped device key (the voice-robot relay) may send a message as itself to the main
// agent, marked 'hang-robot', and read its own conversation. Everything else is 403 device-key-scope, on every
// path, the static ones and the routes added later included. Only the owner mints one, under a name the owner has
// listed in SYSTEM_SENDER_IDS first.
//
// The HTTP half drives the exact gate web.ts runs (gateRequest) in front of the real route handlers, over a real
// socket, like agent-tokens-scope.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Names: the robot (the messenger key), a sub-agent directory made for this file, both unique per run.
const ROBOT = `hangrobot${process.pid}`
const AGENT = `mvdkagent${process.pid}`

// SYSTEM_SENDER_IDS lists the robot (the mint requires it, the messages route accepts it as `from` by it), and also
// the names the mint must refuse for ANOTHER reason (the agent, the voice id, the main agent): so the refusal those
// tests see comes from the collision check, not from the missing SYSTEM_SENDER_IDS entry.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    TELEGRAM_BOT_TOKEN: '',
    SYSTEM_SENDER_IDS: [`hangrobot${process.pid}`, `mvdkagent${process.pid}`, 'hanna', real.MAIN_AGENT_ID, 'system'].join(','),
  }
})

process.env.NODE_ENV = 'test'

const { initDatabase, createAgentMessage, getDb } = await import('../db.js')
const { MAIN_AGENT_ID, PROJECT_ROOT, VOICE_CHANNEL_ID } = await import('../config.js')
const { gateRequest, messengerNameTaken, MESSENGER_ALLOWLIST, MESSENGER_POSTS_PER_HOUR, MESSENGER_MAX_CONTENT_CHARS, resetMessengerRateLimit } = await import('../web/auth-gate.js')
// Every test starts with an empty hourly quota (several tests send valid messages with the same key).
beforeEach(() => { resetMessengerRateLimit() })
const { createDeviceKey, resolveDeviceKey, getDeviceKey, _clearDeviceKeyCacheForTest, MESSENGER_ORIGIN_NOTE } = await import('../web/auth-device-keys.js')
const { operatorGateDecision } = await import('../web/operator-gate.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { tryHandleOperator } = await import('../web/routes/operator.js')
const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const MAIN_TOKEN = 'e'.repeat(64)
const agentsBase = join(PROJECT_ROOT, 'agents')

beforeAll(() => {
  initDatabase(':memory:')
  mkdirSync(join(agentsBase, AGENT), { recursive: true })
})
afterAll(() => {
  rmSync(join(agentsBase, AGENT), { recursive: true, force: true })
  // Only our own directory: other files running in parallel use agents/ too. An empty base goes (rmdir refuses a
  // non-empty one), anything else stays.
  try { rmdirSync(agentsBase) } catch { /* not empty, or gone */ }
})

function mkReq(headers: Record<string, string | undefined> = {}, body?: unknown): http.IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(r as unknown as { headers: Record<string, string | undefined> }).headers = headers
  return r
}

function fakeCtx(method: string, path: string, body: unknown, auth: RouteContext['auth'], headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json', ...headers }
  req.method = method
  req.url = path
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), auth } as RouteContext, out }
}

const deviceKeyCount = () => (getDb().prepare('SELECT COUNT(*) AS c FROM device_keys').get() as { c: number }).c

// ---- Minting --------------------------------------------------------------------------------------------------

describe('POST /api/auth/device-keys scope messenger', () => {
  const owner = { kind: 'session', user: 'owner' } as RouteContext['auth']
  const token = { kind: 'token' } as RouteContext['auth']

  // FIRST in the file: a fresh install (no dashboard user, no device key ever issued) is where the first-run path
  // is open, so this is the state where an owner check relaxed to the first-run variant would let it through.
  it('during first run the shared token is refused (the first-run path never mints a messenger key)', async () => {
    expect(deviceKeyCount()).toBe(0)
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: ROBOT, scope: 'messenger' }, token)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('owner_session_required')
    expect(deviceKeyCount()).toBe(0)
    // The first-run path itself is open in this state: a FULL first key by the same token passes. Proves the 403
    // above is the messenger rule, not a closed first-run window.
    const full = fakeCtx('POST', '/api/auth/device-keys', { name: 'first-bridge' }, token)
    await tryHandleAuth(full.ctx)
    expect(full.out.status).toBe(201)
    expect(full.out.body.scope).toBe('full')
  })

  it('the shared token without an owner session is refused', async () => {
    const before = deviceKeyCount()
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: ROBOT, scope: 'messenger', expires_in_days: 30 }, token)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(403)
    expect(deviceKeyCount()).toBe(before)
  })

  it('a bad name is refused (a messenger name is a canonical sender id)', async () => {
    for (const name of ['Hang Robot', 'Hangrobot', 'hang_robot', 'hang--robot', '-hang', 'hang.robot']) {
      const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name, scope: 'messenger' }, owner)
      await tryHandleAuth(ctx)
      expect(out.status, name).toBe(400)
    }
  })

  it("an agent's name, the main agent, the voice id ('hanna') and a reserved id are refused", async () => {
    expect(VOICE_CHANNEL_ID).toBe('hanna')
    for (const name of [AGENT, MAIN_AGENT_ID, 'hanna', 'system']) {
      const before = deviceKeyCount()
      const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name, scope: 'messenger' }, owner)
      await tryHandleAuth(ctx)
      expect(out.status, name).toBe(400)
      expect(String(out.body.error), name).toMatch(/cannot be named like/)
      expect(deviceKeyCount()).toBe(before)
    }
  })

  it('a name not in SYSTEM_SENDER_IDS is refused, and the error says to add it first', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: 'robot-not-listed', scope: 'messenger' }, owner)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(400)
    expect(String(out.body.error)).toContain('SYSTEM_SENDER_IDS')
  })

  it('no expiry, or an expiry over 365 days, is refused', async () => {
    for (const expires of [0, null, 366, -1]) {
      const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: ROBOT, scope: 'messenger', expires_in_days: expires }, owner)
      await tryHandleAuth(ctx)
      expect(out.status, String(expires)).toBe(400)
    }
    expect(() => createDeviceKey(ROBOT, { scope: 'messenger' })).toThrow(/must expire/)
    expect(() => createDeviceKey(ROBOT, { scope: 'messenger', expiresInDays: 366 })).toThrow(/at most 365 days/)
  })

  it('a valid mint returns scope messenger (90 days by default), and the stored row reads back as messenger', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/auth/device-keys', { name: ROBOT, scope: 'messenger' }, owner)
    await tryHandleAuth(ctx)
    expect(out.status).toBe(201)
    expect(out.body.scope).toBe('messenger')
    expect((out.body.expires_at - out.body.created_at) / 86400).toBe(90)
    _clearDeviceKeyCacheForTest() // force the DB path through toScope
    expect(resolveDeviceKey(out.body.key)?.scope).toBe('messenger')
    expect(getDeviceKey(out.body.id)?.scope).toBe('messenger')
    const stored = getDb().prepare('SELECT scope FROM device_keys WHERE id = ?').get(out.body.id) as { scope: string }
    expect(stored.scope).toBe('messenger')
  })
})

// ---- The gate, over HTTP, in front of the real routes ----------------------------------------------------------

describe('HTTP: a messenger key in front of the real routes', () => {
  let server: http.Server
  let origin = ''
  let key = ''
  let ownSent = 0
  let toRobot = 0
  let otherRow = 0

  beforeAll(async () => {
    key = createDeviceKey(ROBOT, { scope: 'messenger', expiresInDays: 30 }).key
    ownSent = createAgentMessage(ROBOT, MAIN_AGENT_ID, 'robot to main').id
    toRobot = createAgentMessage(MAIN_AGENT_ID, ROBOT, 'main to robot').id
    otherRow = createAgentMessage(AGENT, MAIN_AGENT_ID, 'not the robot').id
    server = http.createServer(async (req, res) => {
      // exactly as web.ts parses it
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method || 'GET'
      const auth = await gateRequest(req, res, url, path, method, { dashboardToken: MAIN_TOKEN, mainAgentId: MAIN_AGENT_ID })
      if (auth === null) return
      const ctx = {
        req, res, path, method, url, fedPeer: null,
        auth: auth.kind === 'device' ? { kind: 'device' as const, device: auth.device, deviceId: auth.deviceId, scope: auth.scope }
          : auth.kind === 'token' ? { kind: 'token' as const, agent: auth.agent } : undefined,
      }
      try {
        if (await tryHandleAuth(ctx)) return
        if (await tryHandleOperator(ctx, '/nonexistent-web-dir')) return
        if (await tryHandleMessages(ctx)) return
        if (await tryHandleAgentTerminal(ctx)) return
        if (path.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return }
        res.writeHead(200); res.end('static')
      } catch (err) {
        res.writeHead(500); res.end(String(err))
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function call(method: string, pathAndQuery: string, opts: { body?: unknown; auth?: string | null } = {}) {
    const headers: Record<string, string> = {}
    const a = opts.auth === undefined ? key : opts.auth
    if (a !== null) headers.Authorization = `Bearer ${a}`
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(origin + pathAndQuery, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
    const text = await r.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    return { status: r.status, json }
  }

  const msgCount = () => (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as { c: number }).c
  const valid = () => ({ from: ROBOT, to: MAIN_AGENT_ID, content: 'szia', origin_note: MESSENGER_ORIGIN_NOTE })

  async function expectScopeDenied(method: string, p: string, opts: { body?: unknown; auth?: string | null } = {}) {
    const r = await call(method, p, opts)
    expect(r.status, `${method} ${p} ${JSON.stringify(opts.body ?? '')}`).toBe(403)
    if (method !== 'HEAD') expect(r.json.rule, `${method} ${p}`).toBe('device-key-scope')
  }

  it('the origin note is the literal hang-robot', () => {
    expect(MESSENGER_ORIGIN_NOTE).toBe('hang-robot')
    expect(MESSENGER_ALLOWLIST.length).toBe(3)
  })

  it('allowed: a valid POST lands as the robot, to the main agent, marked hang-robot', async () => {
    const r = await call('POST', '/api/messages', { body: valid() })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json).toMatchObject({ from_agent: ROBOT, to_agent: MAIN_AGENT_ID, origin_note: 'hang-robot' })
  })

  it('allowed: GET ?agent=<self> and ?agent=<self>&status=pending', async () => {
    const a = await call('GET', `/api/messages?agent=${ROBOT}`)
    expect(a.status).toBe(200)
    const b = await call('GET', `/api/messages?agent=${ROBOT}&status=pending`)
    expect(b.status).toBe(200)
  })

  it('allowed: GET /api/messages/<id> of a row it sent and of a row addressed to it', async () => {
    const a = await call('GET', `/api/messages/${ownSent}`)
    expect(a.status).toBe(200)
    expect(a.json.from_agent).toBe(ROBOT)
    const b = await call('GET', `/api/messages/${toRobot}`)
    expect(b.status).toBe(200)
    expect(b.json.to_agent).toBe(ROBOT)
  })

  it('denied: a POST with another from, a wrong or missing origin note, another recipient, or a delivery field; nothing is written', async () => {
    const before = msgCount()
    const { from: _f, ...noFrom } = valid()
    const { origin_note: _o, ...noNote } = valid()
    const bodies: unknown[] = [
      { ...valid(), from: AGENT },
      { ...valid(), from: 'hanna' },
      { ...valid(), from: MAIN_AGENT_ID },
      { ...valid(), from: ` ${ROBOT}` },
      noFrom,
      { ...valid(), origin_note: 'hang-robot ' },
      { ...valid(), origin_note: 'other' },
      noNote,
      { ...valid(), to: AGENT },
      { ...valid(), to: ROBOT },
      { ...valid(), to: 'hanna' },
      { ...valid(), urgent: true },
      { ...valid(), urgent: false },
      { ...valid(), priority: 'high' },
      { ...valid(), priority: 'normal' },
      { ...valid(), affects_current_work: null },
      { ...valid(), stop_authorized: 1 },
      [valid()],
      'not json',
    ]
    for (const body of bodies) await expectScopeDenied('POST', '/api/messages', { body })
    await expectScopeDenied('POST', '/api/messages')
    expect(msgCount()).toBe(before)
  })

  it('denied: GET with another agent, two agent params, an empty agent, no agent, status=pending without agent', async () => {
    for (const q of [`?agent=${AGENT}`, `?agent=${ROBOT}&agent=${ROBOT}`, `?agent=${ROBOT}&agent=${AGENT}`, '?agent=', '', '?status=pending', `?agent=${ROBOT.toUpperCase()}`]) {
      await expectScopeDenied('GET', `/api/messages${q}`)
    }
  })

  it('denied: threads, backlog, PUT on a message, another agent\'s row, a missing row', async () => {
    await expectScopeDenied('GET', '/api/messages/threads')
    await expectScopeDenied('GET', `/api/messages/backlog?agent=${ROBOT}`)
    await expectScopeDenied('PUT', `/api/messages/${toRobot}`, { body: { status: 'done' } })
    await expectScopeDenied('GET', `/api/messages/${otherRow}`)
    await expectScopeDenied('GET', '/api/messages/99999999')
  })

  it('denied: HEAD, a trailing slash, an encoded or doubled-slash spelling', async () => {
    await expectScopeDenied('HEAD', `/api/messages?agent=${ROBOT}`)
    await expectScopeDenied('HEAD', `/api/messages/${ownSent}`)
    await expectScopeDenied('GET', `/api/messages/?agent=${ROBOT}`)
    await expectScopeDenied('GET', `/api/%6Dessages?agent=${ROBOT}`)
    await expectScopeDenied('GET', `//api/messages?agent=${ROBOT}`)
    await expectScopeDenied('POST', '/api/messages/', { body: valid() })
  })

  it('denied: the pane stream with ?token=<key>, /api/operator/*, a made-up route, the static page', async () => {
    await expectScopeDenied('GET', `/api/agents/${MAIN_AGENT_ID}/pane/stream?token=${key}`, { auth: null })
    await expectScopeDenied('GET', '/api/operator/status')
    await expectScopeDenied('GET', '/api/operator/me')
    await expectScopeDenied('POST', '/api/operator/login', { body: { key } })
    await expectScopeDenied('GET', '/api/zz-new-route')
    await expectScopeDenied('POST', '/api/zz-new-route', { body: valid() })
    await expectScopeDenied('GET', '/')
    await expectScopeDenied('GET', '/index.html')
    await expectScopeDenied('GET', '/api/auth/status')
  })

  it('the same calls without a credential: the static page and a public probe stay open (the 403s above are the key\'s)', async () => {
    expect((await call('GET', '/', { auth: null })).status).toBe(200)
    expect((await call('GET', '/api/auth/status', { auth: null })).status).toBe(200)
  })

  it('a key named like an existing agent (made directly, past the mint) is refused on every request', async () => {
    for (const name of [AGENT, MAIN_AGENT_ID, 'hanna']) {
      const k = createDeviceKey(name, { scope: 'messenger', expiresInDays: 30 }).key
      const row = createAgentMessage(name, MAIN_AGENT_ID, 'own row').id
      const before = msgCount()
      await expectScopeDenied('POST', '/api/messages', { auth: k, body: { ...valid(), from: name } })
      await expectScopeDenied('GET', `/api/messages?agent=${name}`, { auth: k })
      await expectScopeDenied('GET', `/api/messages/${row}`, { auth: k })
      expect(msgCount()).toBe(before)
    }
  })
})

// ---- The gate over every enumerated /api path --------------------------------------------------------------------

// The scanner of operator-scope-gate.test.ts (copied, it is local to that file): every /api path the server
// handles, enumerated from the source: literal `path === '/api/...'` checks and `/^\/api\/...$/` matchers, with
// each capture group / wildcard replaced by a concrete segment.
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!
        .replace(/\([^)]*\)/g, 'x')
        .replace(/\[[^\]]*\][+*]?/g, 'x')
        .replace(/\\\//g, '/')
        .replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

async function gateRaw(method: string, pathAndQuery: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const out: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
  const res = {
    writeHead(code: number) { out.status = code; return res },
    end(data?: unknown) { try { out.body = JSON.parse(String(data ?? '{}')) } catch { /* non-JSON */ } },
    setHeader() { return res },
  } as unknown as http.ServerResponse
  const url = new URL(pathAndQuery, 'http://127.0.0.1')
  const auth = await gateRequest(mkReq(headers, body), res, url, url.pathname, method, { dashboardToken: MAIN_TOKEN, mainAgentId: MAIN_AGENT_ID })
  if (auth !== null) out.status = 200
  return out
}

// R1 (review on #2957, Samu 81668): at most 3 messages an hour per key (the 4th is a 429) and at most 500 characters
// (longer is a 413), so a stolen key or a TV in the room cannot flood the main agent.
describe('the messenger POST limits', () => {
  const keyFor = (name: string) => createDeviceKey(name, { scope: 'messenger', expiresInDays: 30 }).key
  const post = (k: string, from: string, content = 'szia') => gateRaw('POST', '/api/messages', { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    { from, to: MAIN_AGENT_ID, content, origin_note: MESSENGER_ORIGIN_NOTE })

  it('three an hour: the 3rd still passes, the 4th is a 429, another key is unaffected, reads are not limited, and the hour frees up', async () => {
    expect(MESSENGER_POSTS_PER_HOUR).toBe(3)
    const a = `${ROBOT}-rate-a`, b = `${ROBOT}-rate-b`
    const ka = keyFor(a), kb = keyFor(b)
    const base = Date.now() // the keys expire in 30 days: the fake clock stays inside that
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(base)
      expect((await post(ka, a)).status).toBe(200)
      expect((await post(ka, a)).status).toBe(200)
      expect((await post(ka, a)).status).toBe(200) // negative control: the 3rd still passes
      const over = await post(ka, a)
      expect(over.status).toBe(429)
      expect(over.body.rule).toBe('device-key-rate')
      // a refused POST (wrong from) is a 403 and uses nothing; the other key has its own quota
      expect((await post(kb, a)).status).toBe(403)
      expect((await post(kb, b)).status).toBe(200)
      expect((await gateRaw('GET', `/api/messages?agent=${a}`, { authorization: `Bearer ${ka}` })).status).toBe(200)
      vi.setSystemTime(base + 3_599_000)
      expect((await post(ka, a)).status).toBe(429) // still inside the hour
      vi.setSystemTime(base + 3_600_001)
      expect((await post(ka, a)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('500 characters pass, 501 are a 413, counted in characters (not bytes), and an oversized message uses no quota', async () => {
    expect(MESSENGER_MAX_CONTENT_CHARS).toBe(500)
    const c = `${ROBOT}-len`
    const kc = keyFor(c)
    expect((await post(kc, c, 'é'.repeat(500))).status).toBe(200) // 1000 bytes, 500 characters
    // content must be a string: an array or a number would slip past a length cap that measures strings only
    for (const content of [['a'.repeat(600)], 600, null]) {
      const r = await gateRaw('POST', '/api/messages', { authorization: `Bearer ${kc}`, 'content-type': 'application/json' },
        { from: c, to: MAIN_AGENT_ID, content, origin_note: MESSENGER_ORIGIN_NOTE })
      expect(r.status).toBe(403)
      expect(r.body.rule).toBe('device-key-scope')
    }
    const long = await post(kc, c, 'a'.repeat(501))
    expect(long.status).toBe(413)
    expect(long.body.rule).toBe('device-key-content-length')
    for (let i = 0; i < 5; i++) expect((await post(kc, c, 'x'.repeat(600))).status).toBe(413)
    expect((await post(kc, c)).status).toBe(200) // 2nd of 3: the five 413s used nothing
    expect((await post(kc, c)).status).toBe(200)
    expect((await post(kc, c)).status).toBe(429)
  })
})

describe('the messenger gate over every enumerated /api path', () => {
  const paths = enumerateApiPaths()
  let key = ''
  beforeAll(() => { key = createDeviceKey(`${ROBOT}-scan`, { scope: 'messenger', expiresInDays: 30 }).key })

  it('the enumeration is not trivially small (the scanner works)', () => {
    expect(paths.length).toBeGreaterThan(150)
    expect(paths).toContain('/api/messages')
    expect(paths).toContain('/api/operator/status')
  })

  it('every path and method without the allowed shape is 403 device-key-scope', async () => {
    const allowed: string[] = []
    for (const p of paths) {
      for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await gateRaw(m, p, { authorization: `Bearer ${key}` }, m === 'GET' || m === 'HEAD' ? undefined : {})
        if (r.status !== 403 || r.body.rule !== 'device-key-scope') allowed.push(`${m} ${p} -> ${r.status}`)
      }
    }
    expect(allowed).toEqual([])
  })
})

// ---- The operator surface ---------------------------------------------------------------------------------------

describe('a messenger key and the operator surface', () => {
  const messenger = { kind: 'device', scope: 'messenger' }

  it('the operator gate acts on operator keys only, so it does not decide a messenger key (the messenger gate does, before it)', () => {
    expect(operatorGateDecision(messenger, '/api/operator/status', () => { throw new Error('the switches must not be read') })).toBeNull()
  })

  it('the operator routes are positive on scope operator: a messenger credential reaching them is refused', async () => {
    for (const p of ['/api/operator/me', '/api/operator/status', '/api/operator/vault']) {
      const { ctx, out } = fakeCtx('GET', p, undefined, { kind: 'device', device: ROBOT, deviceId: 1, scope: 'messenger' })
      expect(await tryHandleOperator(ctx, '/nonexistent-web-dir')).toBe(true)
      expect(out.status, p).toBe(403)
    }
  })

  it('the operator key login refuses a messenger key presented as an operator key', async () => {
    const k = createDeviceKey(`${ROBOT}-login`, { scope: 'messenger', expiresInDays: 30 }).key
    const { ctx, out } = fakeCtx('POST', '/api/operator/login', { key: k }, undefined)
    expect(await tryHandleOperator(ctx, '/nonexistent-web-dir')).toBe(true)
    expect(out.status).not.toBe(200)
  })
})

describe('messengerNameTaken', () => {
  it('names the agent, the main agent and the voice id; a free name is null', () => {
    expect(messengerNameTaken(AGENT, MAIN_AGENT_ID)).toBe('a fleet agent')
    expect(messengerNameTaken(MAIN_AGENT_ID, MAIN_AGENT_ID)).toBe('the main agent id')
    expect(messengerNameTaken('hanna', MAIN_AGENT_ID)).toBe('the voice channel id')
    expect(messengerNameTaken(ROBOT, MAIN_AGENT_ID)).toBeNull()
  })
})
