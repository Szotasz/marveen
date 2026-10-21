/**
 * Memory MCP connector -- acceptance tests (the specification).
 *
 * A remote MCP server inside the dashboard, so claude.ai / ChatGPT connectors
 * can read and write a dashboard user's OWN memories in the `memories` table.
 * The tests talk to the handler over real HTTP, behind the real auth gate
 * (resolveAuth / requiresAuth), the same way web.ts wires it.
 *
 * Acceptance criteria pinned here:
 *   E1  without MEMORY_MCP_ENABLED (or without an https public URL) every new
 *       endpoint is 404
 *   E2  a token sees only its own `mcp:<username>` rows -- never an agent row,
 *       a shared row or another user's row
 *   E3  the token's mode is enforced (r cannot write, w cannot read)
 *   E4  a revoked token is 401
 *   E5  forget keeps the forgotten row readable as a version
 *   E6  only a logged-in dashboard user can consent; PKCE S256 is mandatory;
 *       an authorization code works once
 *   E7  tokens and codes are stored only as hashes
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'main-agent', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/autonomy-level.js', () => ({
  readAutonomyLevel: () => ({ level: 3, source: 'config' }),
}))

import { initDatabase, getDb, createDashboardUser, saveAgentMemory, getMemoryVersions, clearMemoryCache } from '../db.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { resolveAuth, requiresAuth, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'
import { createMemoryMcpHandler, type MemoryMcpConfig } from '../web/memory-mcp/index.js'

const PUBLIC = 'https://dash.example.test'
const DASH_TOKEN = 'test-dashboard-token-0123456789abcdef'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const CFG: MemoryMcpConfig = { enabled: true, publicUrl: PUBLIC, redirectHosts: ['claude.ai', 'chatgpt.com'] }

const TMP = mkdtempSync(join(tmpdir(), 'memory-mcp-test-'))
let dbSeq = 0
let server: http.Server | null = null
let base = ''

async function start(cfg: MemoryMcpConfig = CFG): Promise<void> {
  const handle = createMemoryMcpHandler(cfg)
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    const method = req.method || 'GET'
    const auth = resolveAuth(req, url, path, method, DASH_TOKEN)
    if (requiresAuth(path, method) && auth.kind === 'none') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const ctxAuth =
      auth.kind === 'token' ? { kind: 'token' as const, agent: auth.agent }
      : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
      : undefined
    const ctx: RouteContext = { req, res, path, method, url, fedPeer: null, auth: ctxAuth }
    try {
      if (await handle(ctx)) return
      if (await tryHandleMemories(ctx)) return
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(err))
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
  vi.useRealTimers()
  initDatabase(join(TMP, `t${++dbSeq}.db`))
  _clearSessionCacheForTest()
  clearMemoryCache()
})

afterEach(async () => {
  vi.useRealTimers()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------- helpers

type User = { id: number; username: string; cookie: string }

function makeUser(name: string): User {
  const u = createDashboardUser(name, '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')
  const sid = createSession({ userId: u.id, username: u.username })
  return { id: u.id, username: u.username, cookie: `${SESSION_COOKIE_NAME}=${sid}` }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function register(redirect = REDIRECT, clientName = 'Claude'): Promise<Response> {
  return fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect], client_name: clientName, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }),
  })
}

async function registerOk(clientName = 'Claude'): Promise<string> {
  const r = await register(REDIRECT, clientName)
  expect(r.status).toBe(201)
  const body = await r.json() as { client_id: string }
  expect(typeof body.client_id).toBe('string')
  return body.client_id
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...extra,
  }).toString()
}

async function authorizeGet(query: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/oauth/authorize?${query}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
}

function nonceFrom(html: string): string {
  const m = /<input[^>]*name="nonce"[^>]*value="([^"]+)"/.exec(html) ?? /<input[^>]*value="([^"]+)"[^>]*name="nonce"/.exec(html)
  if (!m) throw new Error('consent page carries no nonce input')
  return m[1]!
}

async function consentPost(form: Record<string, string>, cookie?: string): Promise<Response> {
  return fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  })
}

function codeFrom(r: Response): string | null {
  const loc = r.headers.get('location')
  if (!loc) return null
  return new URL(loc).searchParams.get('code')
}

async function tokenPost(params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
}

/** Approve a consent and return the code plus what is needed to redeem it. */
async function getCode(user: User, mode = 'rw', clientName = 'Claude'): Promise<{ clientId: string; code: string; verifier: string }> {
  const clientId = await registerOk(clientName)
  const { verifier, challenge } = pkce()
  const page = await authorizeGet(authorizeQuery(clientId, challenge), user.cookie)
  expect(page.status).toBe(200)
  const nonce = nonceFrom(await page.text())
  const approved = await consentPost({ nonce, mode, label: `${user.username}-${mode}`, decision: 'approve' }, user.cookie)
  expect(approved.status).toBe(302)
  const code = codeFrom(approved)
  expect(code).toBeTruthy()
  return { clientId, code: code!, verifier }
}

type Tokens = { access: string; refresh: string; clientId: string; expiresIn: number }

async function connect(user: User, mode = 'rw', clientName = 'Claude'): Promise<Tokens> {
  const { clientId, code, verifier } = await getCode(user, mode, clientName)
  const r = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })
  expect(r.status).toBe(200)
  const body = await r.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number }
  expect(body.token_type.toLowerCase()).toBe('bearer')
  return { access: body.access_token, refresh: body.refresh_token, clientId, expiresIn: body.expires_in }
}

let rpcSeq = 0
type RpcReply = { status: number; body: any; headers: Headers }

async function rpc(access: string | null, method: string, params?: unknown, opts: { notification?: boolean; raw?: string; cookie?: string } = {}): Promise<RpcReply> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (access) headers.Authorization = `Bearer ${access}`
  if (opts.cookie) headers.cookie = opts.cookie
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method }
  if (!opts.notification) msg.id = ++rpcSeq
  if (params !== undefined) msg.params = params
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(msg) })
  const text = await r.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body, headers: r.headers }
}

async function callTool(access: string, name: string, args: Record<string, unknown> = {}): Promise<RpcReply> {
  return rpc(access, 'tools/call', { name, arguments: args })
}

/** A successful tool result: JSON in the first text content block. */
function toolJson(r: RpcReply): any {
  expect(r.status).toBe(200)
  expect(r.body?.error).toBeUndefined()
  expect(r.body?.result?.isError).not.toBe(true)
  return JSON.parse(r.body.result.content[0].text)
}

function refused(r: RpcReply): boolean {
  return r.status >= 400 || r.body?.error !== undefined || r.body?.result?.isError === true
}

function refusalText(r: RpcReply): string {
  return String(r.body?.error?.message ?? r.body?.result?.content?.[0]?.text ?? r.body?.error ?? '')
}

function rowsOf(agentId: string): Array<{ id: number; content: string; category: string; topic_key: string | null; keywords: string | null; source: string | null }> {
  return getDb().prepare('SELECT id, content, category, topic_key, keywords, source FROM memories WHERE agent_id = ? ORDER BY id').all(agentId) as any
}

function rowById(id: number): { id: number; agent_id: string; content: string } | undefined {
  return getDb().prepare('SELECT id, agent_id, content FROM memories WHERE id = ?').get(id) as any
}

async function remember(access: string, content: string, extra: Record<string, unknown> = {}): Promise<number> {
  const out = toolJson(await callTool(access, 'remember', { content, ...extra }))
  expect(out.saved).toBe(true)
  return Number(out.id)
}

// ---------------------------------------------------------------- E1

describe('E1 feature switch', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/oauth/register'],
    ['GET', '/oauth/authorize'],
    ['POST', '/oauth/authorize'],
    ['POST', '/oauth/token'],
    ['POST', '/mcp'],
    ['GET', '/api/memory-mcp/tokens'],
    ['POST', '/api/memory-mcp/tokens/1/revoke'],
  ]

  async function statuses(): Promise<number[]> {
    const out: number[] = []
    for (const [method, path] of endpoints) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${DASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
        redirect: 'manual',
      })
      out.push(r.status)
    }
    return out
  }

  it('every new endpoint is 404 when the switch is off', async () => {
    await start({ ...CFG, enabled: false })
    expect(await statuses()).toEqual(endpoints.map(() => 404))
  })

  it('is fail-closed without an https public URL', async () => {
    await start({ ...CFG, publicUrl: '' })
    expect(await statuses()).toEqual(endpoints.map(() => 404))
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    await start({ ...CFG, publicUrl: 'http://dash.example.test' })
    expect(await statuses()).toEqual(endpoints.map(() => 404))
  })

  it('positive control: switched on, discovery answers', async () => {
    await start()
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------- discovery

describe('discovery metadata', () => {
  it('protected-resource metadata points at the /mcp resource and this issuer, on both paths', async () => {
    await start()
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await fetch(`${base}${path}`)
      expect(r.status).toBe(200)
      const body = await r.json() as { resource: string; authorization_servers: string[] }
      expect(body.resource).toBe(`${PUBLIC}/mcp`)
      expect(body.authorization_servers).toContain(PUBLIC)
    }
  })

  it('authorization-server metadata advertises S256 only and public clients', async () => {
    await start()
    const body = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as Record<string, any>
    expect(body.issuer).toBe(PUBLIC)
    expect(body.authorization_endpoint).toBe(`${PUBLIC}/oauth/authorize`)
    expect(body.token_endpoint).toBe(`${PUBLIC}/oauth/token`)
    expect(body.registration_endpoint).toBe(`${PUBLIC}/oauth/register`)
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.response_types_supported).toEqual(['code'])
    expect(body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']))
    expect(body.token_endpoint_auth_methods_supported).toContain('none')
  })
})

// ---------------------------------------------------------------- registration

describe('dynamic client registration', () => {
  it('registers an https redirect on an allowed host', async () => {
    await start()
    const r = await register()
    expect(r.status).toBe(201)
    const body = await r.json() as { client_id: string; redirect_uris: string[] }
    expect(body.client_id).toBeTruthy()
    expect(body.redirect_uris).toEqual([REDIRECT])
  })

  it('refuses http, a foreign host, a look-alike host and a missing redirect', async () => {
    await start()
    expect((await register('http://claude.ai/api/mcp/auth_callback')).status).toBe(400)
    expect((await register('https://evil.example/cb')).status).toBe(400)
    expect((await register('https://claude.ai.evil.example/cb')).status).toBe(400)
    const none = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'x' }) })
    expect(none.status).toBe(400)
  })

  it('caps registrations at 20 per rolling hour', async () => {
    await start()
    for (let i = 0; i < 20; i++) expect((await register()).status).toBe(201)
    expect((await register()).status).toBe(429)
  })
})

// ---------------------------------------------------------------- E6 authorize

describe('E6 authorize and consent', () => {
  it('without a dashboard session no code is issued', async () => {
    await start()
    const clientId = await registerOk()
    const query = authorizeQuery(clientId, pkce().challenge)
    const r = await authorizeGet(query)
    expect([302, 401]).toContain(r.status)
    expect(r.headers.get('location') ?? '').not.toMatch(/[?&]code=/)
    // The login cookie is SameSite=Strict, so it is NOT sent on the connector's
    // cross-site navigation here. A link on this page back to the same URL is a
    // same-site navigation that carries it.
    if (r.status === 401) expect(await r.text()).toContain(`href="/oauth/authorize?${query.replace(/&/g, '&amp;')}"`)
  })

  it('the dashboard bearer token is not a consenting user', async () => {
    await start()
    makeUser('alice') // a user exists, so mapping the token onto any user would show here
    const clientId = await registerOk()
    const r = await fetch(`${base}/oauth/authorize?${authorizeQuery(clientId, pkce().challenge)}`, {
      headers: { Authorization: `Bearer ${DASH_TOKEN}` }, redirect: 'manual',
    })
    expect(r.status).not.toBe(200)
    expect(r.headers.get('location') ?? '').not.toMatch(/[?&]code=/)
  })

  it('a logged-in user sees a consent page whose client name is escaped', async () => {
    await start()
    const alice = makeUser('alice')
    const clientId = await registerOk('<script>alert(1)</script>')
    const r = await authorizeGet(authorizeQuery(clientId, pkce().challenge), alice.cookie)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(nonceFrom(html)).toBeTruthy()
    // The approval answers with a redirect to the connector, which form-action
    // must allow, or the browser blocks the redirect after the submit.
    expect(r.headers.get('content-security-policy') ?? '').toMatch(/form-action 'self' https:\/\/claude\.ai(;|$)/)
  })

  it('PKCE S256 is mandatory', async () => {
    await start()
    const alice = makeUser('alice')
    const clientId = await registerOk()
    const missing = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' }).toString()
    const plain = authorizeQuery(clientId, 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq', { code_challenge_method: 'plain' })
    for (const q of [missing, plain]) {
      const r = await authorizeGet(q, alice.cookie)
      expect(r.status === 400 || (r.status === 302 && /[?&]error=invalid_request/.test(r.headers.get('location') ?? ''))).toBe(true)
      expect(r.headers.get('location') ?? '').not.toMatch(/[?&]code=/)
    }
  })

  it('refuses an unknown client and an unregistered redirect without redirecting to it', async () => {
    await start()
    const alice = makeUser('alice')
    const clientId = await registerOk()
    const ch = pkce().challenge
    const unknown = await authorizeGet(authorizeQuery('no-such-client', ch), alice.cookie)
    expect(unknown.status).toBe(400)
    const foreign = await authorizeGet(authorizeQuery(clientId, ch, { redirect_uri: 'https://claude.ai/other' }), alice.cookie)
    expect(foreign.status).toBe(400)
    expect(foreign.headers.get('location')).toBeNull()
  })

  it('consent POST needs the same session that opened the page, and works once', async () => {
    await start()
    const alice = makeUser('alice')
    const bob = makeUser('bob')
    const clientId = await registerOk()
    const page = await authorizeGet(authorizeQuery(clientId, pkce().challenge), alice.cookie)
    const nonce = nonceFrom(await page.text())

    const anon = await consentPost({ nonce, mode: 'rw', decision: 'approve' })
    expect([401, 403]).toContain(anon.status)
    expect(codeFrom(anon)).toBeNull()

    const asBob = await consentPost({ nonce, mode: 'rw', decision: 'approve' }, bob.cookie)
    expect(asBob.status).toBeGreaterThanOrEqual(400)
    expect(codeFrom(asBob)).toBeNull()

    const ok = await consentPost({ nonce, mode: 'rw', decision: 'approve' }, alice.cookie)
    expect(ok.status).toBe(302)
    const loc = new URL(ok.headers.get('location')!)
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT)
    expect(loc.searchParams.get('state')).toBe('st-1')
    expect(loc.searchParams.get('code')).toBeTruthy()

    const again = await consentPost({ nonce, mode: 'rw', decision: 'approve' }, alice.cookie)
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(codeFrom(again)).toBeNull()
  })

  it('refuses an unknown mode and reports a denial as access_denied', async () => {
    await start()
    const alice = makeUser('alice')
    const clientId = await registerOk()
    const p1 = await authorizeGet(authorizeQuery(clientId, pkce().challenge), alice.cookie)
    const bad = await consentPost({ nonce: nonceFrom(await p1.text()), mode: 'admin', decision: 'approve' }, alice.cookie)
    expect(bad.status).toBe(400)
    expect(codeFrom(bad)).toBeNull()

    const p2 = await authorizeGet(authorizeQuery(clientId, pkce().challenge), alice.cookie)
    const denied = await consentPost({ nonce: nonceFrom(await p2.text()), mode: 'rw', decision: 'deny' }, alice.cookie)
    expect(denied.status).toBe(302)
    const loc = new URL(denied.headers.get('location')!)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st-1')
    expect(loc.searchParams.get('code')).toBeNull()
  })
})

// ---------------------------------------------------------------- token endpoint

describe('token endpoint', () => {
  it('redeems a code with the right verifier, no-store', async () => {
    await start()
    const alice = makeUser('alice')
    const { clientId, code, verifier } = await getCode(alice)
    const r = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control') ?? '').toContain('no-store')
    const body = await r.json() as Record<string, any>
    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
    expect(body.expires_in).toBeGreaterThan(0)
  })

  it('a wrong verifier burns the code', async () => {
    await start()
    const alice = makeUser('alice')
    const { clientId, code, verifier } = await getCode(alice)
    const wrong = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier })
    expect(wrong.status).toBe(400)
    expect((await wrong.json() as { error: string }).error).toBe('invalid_grant')
    const right = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })
    expect(right.status).toBe(400)
  })

  it('a code works once, only for its client and redirect', async () => {
    await start()
    const alice = makeUser('alice')
    const a = await getCode(alice)
    const otherClient = await registerOk()
    const asOther = await tokenPost({ grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, client_id: otherClient, code_verifier: a.verifier })
    expect(asOther.status).toBe(400)

    const b = await getCode(alice)
    const otherRedirect = await tokenPost({ grant_type: 'authorization_code', code: b.code, redirect_uri: 'https://claude.ai/other', client_id: b.clientId, code_verifier: b.verifier })
    expect(otherRedirect.status).toBe(400)

    const c = await getCode(alice)
    const first = await tokenPost({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier })
    expect(first.status).toBe(200)
    const second = await tokenPost({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier })
    expect(second.status).toBe(400)
    expect((await second.json() as { error: string }).error).toBe('invalid_grant')
  })

  it('a code expires within ten minutes', async () => {
    await start()
    const alice = makeUser('alice')
    const c = await getCode(alice)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    const r = await tokenPost({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier })
    expect(r.status).toBe(400)
  })

  it('refresh rotates; replaying a used refresh token revokes the whole family', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    const r1 = await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })
    expect(r1.status).toBe(200)
    const n1 = await r1.json() as { access_token: string; refresh_token: string }
    expect(n1.access_token).not.toBe(t.access)
    expect(n1.refresh_token).not.toBe(t.refresh)
    expect((await rpc(n1.access_token, 'ping')).status).toBe(200)

    const replay = await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })
    expect(replay.status).toBe(400)
    expect((await rpc(n1.access_token, 'ping')).status).toBe(401)
    const later = await tokenPost({ grant_type: 'refresh_token', refresh_token: n1.refresh_token, client_id: t.clientId })
    expect(later.status).toBe(400)
  })

  it('an access token expires', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    expect((await rpc(t.access, 'ping')).status).toBe(200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + t.expiresIn * 1000 + 1000)
    expect((await rpc(t.access, 'ping')).status).toBe(401)
  })

  it('refuses an unsupported grant type', async () => {
    await start()
    const r = await tokenPost({ grant_type: 'password', username: 'a', password: 'b' })
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('unsupported_grant_type')
  })
})

// ---------------------------------------------------------------- /mcp transport

describe('/mcp transport and authentication', () => {
  it('401 without a token, pointing at the resource metadata', async () => {
    await start()
    const r = await rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate') ?? '').toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`)
  })

  it('the fleet dashboard token, a session cookie and garbage are not MCP tokens', async () => {
    await start()
    const alice = makeUser('alice')
    expect((await rpc(DASH_TOKEN, 'ping')).status).toBe(401)
    expect((await rpc(null, 'ping', undefined, { cookie: alice.cookie })).status).toBe(401)
    expect((await rpc('mcp-garbage-token', 'ping')).status).toBe(401)
  })

  it('an MCP token does not open the /api surface', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    const r = await fetch(`${base}/api/memories?agent=main-agent`, { headers: { Authorization: `Bearer ${t.access}` } })
    expect(r.status).toBe(401)
  })

  it('GET and DELETE /mcp are 405', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${t.access}` } })
      expect(r.status).toBe(405)
    }
  })

  it('speaks JSON-RPC: initialize, notification 202, ping, unknown method, parse error', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    const init = await rpc(t.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.status).toBe(200)
    expect(init.body.jsonrpc).toBe('2.0')
    expect(init.body.result.protocolVersion).toBe('2025-06-18')
    expect(init.body.result.capabilities.tools).toBeDefined()
    expect(typeof init.body.result.serverInfo.name).toBe('string')

    const note = await rpc(t.access, 'notifications/initialized', undefined, { notification: true })
    expect(note.status).toBe(202)

    const ping = await rpc(t.access, 'ping')
    expect(ping.body.result).toEqual({})

    const unknown = await rpc(t.access, 'no/such/method')
    expect(unknown.body.error.code).toBe(-32601)

    const broken = await rpc(t.access, 'ping', undefined, { raw: '{not json' })
    expect(broken.status === 400 || broken.body?.error?.code === -32700).toBe(true)
  })
})

// ---------------------------------------------------------------- E3 modes

describe('E3 modes', () => {
  async function toolNames(access: string): Promise<string[]> {
    const r = await rpc(access, 'tools/list')
    expect(r.status).toBe(200)
    return (r.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
  }

  it('lists the tools each mode allows', async () => {
    await start()
    const alice = makeUser('alice')
    expect(await toolNames((await connect(alice, 'rw')).access)).toEqual(['fetch', 'forget', 'list_topics', 'recent', 'remember', 'search', 'update_memory'])
    expect(await toolNames((await connect(alice, 'r')).access)).toEqual(['fetch', 'list_topics', 'recent', 'search'])
    expect(await toolNames((await connect(alice, 'w')).access)).toEqual(['remember'])
  })

  it('an r token cannot write', async () => {
    await start()
    const alice = makeUser('alice')
    const rw = await connect(alice, 'rw')
    const id = await remember(rw.access, 'alice likes green tea')
    const r = await connect(alice, 'r')

    expect(refused(await callTool(r.access, 'remember', { content: 'should not be saved' }))).toBe(true)
    expect(refused(await callTool(r.access, 'update_memory', { id: String(id), content: 'changed' }))).toBe(true)
    expect(refused(await callTool(r.access, 'forget', { id: String(id) }))).toBe(true)

    const rows = rowsOf('mcp:alice')
    expect(rows.map((x) => x.content)).toEqual(['alice likes green tea'])
    expect(toolJson(await callTool(r.access, 'fetch', { id: String(id) })).text).toBe('alice likes green tea')
  })

  it('a w token can only save, and learns nothing back', async () => {
    await start()
    const alice = makeUser('alice')
    const rw = await connect(alice, 'rw')
    const existing = await remember(rw.access, 'alice has a cat')
    const w = await connect(alice, 'w')

    expect(toolJson(await callTool(w.access, 'remember', { content: 'alice moved to a new flat' }))).toEqual({ saved: true })
    expect(refused(await callTool(w.access, 'search', { query: 'alice' }))).toBe(true)
    expect(refused(await callTool(w.access, 'fetch', { id: String(existing) }))).toBe(true)
    expect(refused(await callTool(w.access, 'recent', {}))).toBe(true)
    expect(rowsOf('mcp:alice').map((x) => x.content)).toEqual(['alice has a cat', 'alice moved to a new flat'])
  })
})

// ---------------------------------------------------------------- E2 isolation

describe('E2 isolation', () => {
  async function world() {
    await start()
    const alice = makeUser('alice')
    const bob = makeUser('bob')
    const ta = await connect(alice, 'rw')
    const tb = await connect(bob, 'rw')
    const agentId = saveAgentMemory('helper-agent', 'xyzzy agent fact', 'warm', 'xyzzy').id
    const sharedId = saveAgentMemory('helper-agent', 'xyzzy shared fact', 'shared', 'xyzzy').id
    const bobId = await remember(tb.access, 'xyzzy bob fact', { topic: 'bobtopic' })
    const aliceId = await remember(ta.access, 'xyzzy alice fact', { topic: 'family' })
    return { ta, tb, agentId, sharedId, bobId, aliceId }
  }

  it('search, recent and list_topics show only the caller\'s own rows', async () => {
    const w = await world()
    const found = toolJson(await callTool(w.ta.access, 'search', { query: 'xyzzy' }))
    expect(found.results.map((x: { id: string }) => x.id)).toEqual([String(w.aliceId)])
    const recent = toolJson(await callTool(w.ta.access, 'recent', {}))
    expect(recent.results.map((x: { id: string }) => x.id)).toEqual([String(w.aliceId)])
    const topics = toolJson(await callTool(w.ta.access, 'list_topics', {}))
    expect(topics.topics.map((x: { topic: string }) => x.topic)).toEqual(['family'])

    const bobFound = toolJson(await callTool(w.tb.access, 'search', { query: 'xyzzy' }))
    expect(bobFound.results.map((x: { id: string }) => x.id)).toEqual([String(w.bobId)])
  })

  it('fetch of a foreign row reads exactly like a missing one', async () => {
    const w = await world()
    const own = toolJson(await callTool(w.ta.access, 'fetch', { id: String(w.aliceId) }))
    expect(own.id).toBe(String(w.aliceId))
    expect(own.text).toBe('xyzzy alice fact')

    const missing = await callTool(w.ta.access, 'fetch', { id: '999999' })
    expect(refused(missing)).toBe(true)
    const shape = refusalText(missing).replace(/\d+/g, '#')
    for (const id of [w.agentId, w.sharedId, w.bobId]) {
      const r = await callTool(w.ta.access, 'fetch', { id: String(id) })
      expect(refused(r)).toBe(true)
      expect(refusalText(r).replace(/\d+/g, '#')).toBe(shape)
      expect(JSON.stringify(r.body)).not.toContain('fact')
    }
  })

  it('update_memory and forget cannot touch a foreign row', async () => {
    const w = await world()
    for (const id of [w.agentId, w.sharedId, w.bobId]) {
      const before = rowById(id)!.content
      expect(refused(await callTool(w.ta.access, 'update_memory', { id: String(id), content: 'hijacked' }))).toBe(true)
      expect(refused(await callTool(w.ta.access, 'forget', { id: String(id) }))).toBe(true)
      expect(rowById(id)?.content).toBe(before)
    }
    expect(getMemoryVersions(w.agentId)).toEqual([])
    expect(getMemoryVersions(w.bobId)).toEqual([])
  })
})

// ---------------------------------------------------------------- writes, E5

describe('writes', () => {
  it('remember stores a warm row in the caller\'s namespace with topic, tags and source', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice, 'rw', 'Claude')
    const id = await remember(t.access, 'alice works at a bakery', { topic: 'work', tags: 'job, bakery', category: 'shared' })
    const [row] = rowsOf('mcp:alice')
    expect(row!.id).toBe(id)
    expect(row!.category).toBe('warm')
    expect(row!.topic_key).toBe('work')
    expect(row!.keywords).toBe('job, bakery')
    expect(row!.source).toMatch(/^mcp:Claude/)

    const cols = (getDb().prepare('PRAGMA table_info(memories)').all() as Array<{ name: string; notnull: number }>)
    expect(cols.find((c) => c.name === 'source')?.notnull).toBe(0)
    const agentRow = saveAgentMemory('helper-agent', 'plain agent row', 'warm').id
    expect((getDb().prepare('SELECT source FROM memories WHERE id = ?').get(agentRow) as { source: string | null }).source).toBeNull()
  })

  it('refuses empty, oversized and secret-looking content', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice, 'rw')
    expect(refused(await callTool(t.access, 'remember', { content: '   ' }))).toBe(true)
    expect(refused(await callTool(t.access, 'remember', { content: 'x'.repeat(10001) }))).toBe(true)
    expect(refused(await callTool(t.access, 'remember', { content: `my token is ghp_${'a1B2'.repeat(9)}` }))).toBe(true)
    expect(refused(await callTool(t.access, 'remember', { content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc' }))).toBe(true)
    expect(refused(await callTool(t.access, 'remember', { content: 'card 4111 1111 1111 1111 exp 12/30' }))).toBe(true)
    expect(rowsOf('mcp:alice')).toEqual([])
    // A longer number is not a card number, even when a 13-19 digit slice of it
    // passes the Luhn check (here the first 19 digits do).
    await remember(t.access, 'account 411111111111111112834567')
    getDb().prepare('DELETE FROM memories WHERE agent_id = ?').run('mcp:alice')

    const id = await remember(t.access, 'x'.repeat(10000))
    expect(refused(await callTool(t.access, 'update_memory', { id: String(id), content: `ghp_${'a1B2'.repeat(9)}` }))).toBe(true)
    expect(rowById(id)?.content).toBe('x'.repeat(10000))
  })

  it('update_memory keeps the previous text as a version', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice, 'rw')
    const id = await remember(t.access, 'alice lives in Szeged')
    toolJson(await callTool(t.access, 'update_memory', { id: String(id), content: 'alice lives in Pecs' }))
    expect(rowById(id)?.content).toBe('alice lives in Pecs')
    const versions = getMemoryVersions(id)
    expect(versions[0]?.operation).toBe('update')
    expect(versions[0]?.content).toBe('alice lives in Szeged')
  })

  it('E5 forget removes the row from view but keeps it as a delete version', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice, 'rw')
    const id = await remember(t.access, 'alice plays the cello')
    toolJson(await callTool(t.access, 'forget', { id: String(id), reason: 'wrong' }))

    expect(rowById(id)).toBeUndefined()
    expect(refused(await callTool(t.access, 'fetch', { id: String(id) }))).toBe(true)
    expect(toolJson(await callTool(t.access, 'search', { query: 'cello' })).results).toEqual([])
    const versions = getMemoryVersions(id)
    expect(versions.some((v) => v.operation === 'delete' && v.content === 'alice plays the cello')).toBe(true)
  })
})

// ---------------------------------------------------------------- REST namespace guard

describe('the REST memory API cannot write into the mcp: namespace', () => {
  async function api(method: string, path: string, body: unknown): Promise<number> {
    const r = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${DASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return r.status
  }

  it('POST /api/memories refuses an mcp: owner (control: a plain agent id is accepted)', async () => {
    await start()
    expect(await api('POST', '/api/memories', { agent_id: 'some-agent', content: 'control row' })).toBe(200)
    expect(await api('POST', '/api/memories', { agent_id: 'mcp:alice', content: 'planted' })).toBe(400)
    expect(await api('POST', '/api/memories', { agent_id: 'MCP:alice', content: 'planted' })).toBe(400)
    expect(rowsOf('mcp:alice')).toEqual([])
    expect(rowsOf('MCP:alice')).toEqual([])
  })

  it('PUT /api/memories/:id refuses a reassignment into mcp: (control: to a plain agent is accepted)', async () => {
    await start()
    const id = saveAgentMemory('helper-agent', 'agent row', 'warm').id
    expect(await api('PUT', `/api/memories/${id}`, { content: 'agent row v2', agent_id: 'other-agent' })).toBe(200)
    expect(rowById(id)?.agent_id).toBe('other-agent')
    expect(await api('PUT', `/api/memories/${id}`, { content: 'agent row v3', agent_id: 'mcp:alice' })).toBe(400)
    expect(rowById(id)?.agent_id).toBe('other-agent')
    expect(rowById(id)?.content).toBe('agent row v2')
  })
})

// ---------------------------------------------------------------- E4, E7

describe('E4 token management, E7 storage', () => {
  it('stores tokens and codes only as hashes', async () => {
    await start()
    const alice = makeUser('alice')
    const { clientId, code, verifier } = await getCode(alice)
    const r = await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })
    const body = await r.json() as { access_token: string; refresh_token: string }
    const secrets = [code, body.access_token, body.refresh_token]

    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mcp_%'").all() as Array<{ name: string }>).map((x) => x.name)
    expect(tables.length).toBeGreaterThanOrEqual(3)
    let cells = 0
    for (const table of tables) {
      for (const row of getDb().prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>) {
        for (const value of Object.values(row)) {
          cells++
          for (const s of secrets) expect(String(value)).not.toContain(s)
        }
      }
    }
    expect(cells).toBeGreaterThan(0)
  })

  it('a user lists and revokes their own grants; a revoked token is 401', async () => {
    await start()
    const alice = makeUser('alice')
    const bob = makeUser('bob')
    const ta = await connect(alice, 'rw')
    const tb = await connect(bob, 'r')

    const listed = await fetch(`${base}/api/memory-mcp/tokens`, { headers: { cookie: alice.cookie } })
    expect(listed.status).toBe(200)
    const listText = await listed.text()
    expect(listText).not.toContain(ta.access)
    expect(listText).not.toContain(ta.refresh)
    const grants = (JSON.parse(listText) as { tokens: Array<{ id: string | number; mode: string; username: string }> }).tokens
    expect(grants).toHaveLength(1)
    expect(grants[0]!.mode).toBe('rw')

    const bobGrants = (await (await fetch(`${base}/api/memory-mcp/tokens`, { headers: { cookie: bob.cookie } })).json() as { tokens: Array<{ id: string | number }> }).tokens
    expect(bobGrants).toHaveLength(1)
    const notMine = await fetch(`${base}/api/memory-mcp/tokens/${bobGrants[0]!.id}/revoke`, { method: 'POST', headers: { cookie: alice.cookie } })
    expect(notMine.status).toBe(404)
    expect((await rpc(tb.access, 'ping')).status).toBe(200)

    const revoked = await fetch(`${base}/api/memory-mcp/tokens/${grants[0]!.id}/revoke`, { method: 'POST', headers: { cookie: alice.cookie } })
    expect(revoked.status).toBe(200)
    expect((await rpc(ta.access, 'ping')).status).toBe(401)
    const refresh = await tokenPost({ grant_type: 'refresh_token', refresh_token: ta.refresh, client_id: ta.clientId })
    expect(refresh.status).toBe(400)

    const all = await fetch(`${base}/api/memory-mcp/tokens`, { headers: { Authorization: `Bearer ${DASH_TOKEN}` } })
    expect(all.status).toBe(200)
    expect(((await all.json()) as { tokens: unknown[] }).tokens.length).toBeGreaterThanOrEqual(2)
  })

  it('a disabled dashboard user\'s token is 401', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice, 'rw')
    expect((await rpc(t.access, 'ping')).status).toBe(200)
    getDb().prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').run(alice.id)
    expect((await rpc(t.access, 'ping')).status).toBe(401)
  })
})

// ---------------------------------------------------------------- review round 1

describe('review round 1', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')

  it('PKCE: the challenge is exactly 43 base64url chars and the verifier follows RFC 7636', async () => {
    await start()
    const alice = makeUser('alice')
    const clientId = await registerOk()
    const long = await authorizeGet(authorizeQuery(clientId, 'a'.repeat(50)), alice.cookie)
    expect(long.status === 400 || /[?&]error=invalid_request/.test(long.headers.get('location') ?? '')).toBe(true)
    expect(codeFrom(long)).toBeNull()

    // A one-character verifier whose S256 challenge is well formed: the code must not redeem with it.
    const weak = 'a'
    const page = await authorizeGet(authorizeQuery(clientId, createHash('sha256').update(weak).digest('base64url')), alice.cookie)
    expect(page.status).toBe(200)
    const approved = await consentPost({ nonce: nonceFrom(await page.text()), mode: 'rw', decision: 'approve' }, alice.cookie)
    const r = await tokenPost({ grant_type: 'authorization_code', code: codeFrom(approved)!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: weak })
    expect(r.status).toBe(400)
  })

  it('refresh fails for a disabled user', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    getDb().prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').run(alice.id)
    const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })
    expect(r.status).toBe(400)
  })

  it('a replayed refresh token revokes the family even with a wrong client_id', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    const n1 = await (await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })).json() as { access_token: string }
    expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: 'someone-else' })).status).toBe(400)
    expect((await rpc(n1.access_token, 'ping')).status).toBe(401)
  })

  it('a code presented with the wrong client is burned', async () => {
    await start()
    const alice = makeUser('alice')
    const c = await getCode(alice)
    const other = await registerOk()
    expect((await tokenPost({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: other, code_verifier: c.verifier })).status).toBe(400)
    expect((await tokenPost({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier })).status).toBe(400)
  })

  it('the stored values are the sha256 of the code and the tokens', async () => {
    await start()
    const alice = makeUser('alice')
    const { clientId, code, verifier } = await getCode(alice)
    const body = await (await tokenPost({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json() as { access_token: string; refresh_token: string }
    const codes = (getDb().prepare('SELECT code_hash FROM mcp_oauth_codes').all() as Array<{ code_hash: string }>).map((x) => x.code_hash)
    const tokens = (getDb().prepare('SELECT token_hash FROM mcp_oauth_tokens').all() as Array<{ token_hash: string }>).map((x) => x.token_hash)
    expect(codes).toContain(sha(code))
    expect(tokens).toEqual(expect.arrayContaining([sha(body.access_token), sha(body.refresh_token)]))
  })

  it('a redirect with a port or user info is refused', async () => {
    await start()
    expect((await register('https://claude.ai:8443/api/mcp/auth_callback')).status).toBe(400)
    expect((await register('https://user@claude.ai/api/mcp/auth_callback')).status).toBe(400)
  })

  it('a grant does not follow a username whose case changed', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    getDb().prepare("UPDATE dashboard_users SET username = 'ALICE' WHERE id = ?").run(alice.id)
    expect((await rpc(t.access, 'ping')).status).toBe(401)
  })

  it('a grant revoked while the request body is still arriving is refused', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    await remember(t.access, 'alice keeps bees')
    const grants = (await (await fetch(`${base}/api/memory-mcp/tokens`, { headers: { cookie: alice.cookie } })).json() as { tokens: Array<{ id: string }> }).tokens
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'bees' } } })
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.access}`, 'Content-Length': String(Buffer.byteLength(payload)) } })
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.write(payload.slice(0, 10))
      setTimeout(() => {
        fetch(`${base}/api/memory-mcp/tokens/${grants[0]!.id}/revoke`, { method: 'POST', headers: { cookie: alice.cookie } })
          .then((r) => { expect(r.status).toBe(200); req.end(payload.slice(10)) }, reject)
      }, 300)
    })
    expect(status).toBe(401)
  })

  it('the LIKE fallback of search is owner-scoped too', async () => {
    await start()
    const alice = makeUser('alice')
    const bob = makeUser('bob')
    const ta = await connect(alice)
    const tb = await connect(bob)
    saveAgentMemory('helper-agent', 'xyzzy agent fact', 'warm')
    await remember(tb.access, 'xyzzy bob fact')
    const aliceId = await remember(ta.access, 'xyzzy alice fact')
    // 'yzz' is inside the word, so the FTS prefix query misses and the LIKE fallback answers.
    const found = toolJson(await callTool(ta.access, 'search', { query: 'yzz' }))
    expect(found.results.map((x: { id: string }) => x.id)).toEqual([String(aliceId)])
  })

  it('a w token cannot reach the other tools directly', async () => {
    await start()
    const alice = makeUser('alice')
    const rw = await connect(alice, 'rw')
    const id = await remember(rw.access, 'alice reads novels', { topic: 'hobby' })
    const w = await connect(alice, 'w')
    expect(refused(await callTool(w.access, 'list_topics', {}))).toBe(true)
    expect(refused(await callTool(w.access, 'update_memory', { id: String(id), content: 'changed' }))).toBe(true)
    expect(refused(await callTool(w.access, 'forget', { id: String(id) }))).toBe(true)
    expect(rowById(id)?.content).toBe('alice reads novels')
  })

  it('a forgotten row stays readable through the REST versions route', async () => {
    await start()
    const alice = makeUser('alice')
    const t = await connect(alice)
    const id = await remember(t.access, 'alice owns a red bike')
    toolJson(await callTool(t.access, 'forget', { id: String(id) }))
    const r = await fetch(`${base}/api/memories/${id}/versions`, { headers: { Authorization: `Bearer ${DASH_TOKEN}` } })
    expect(r.status).toBe(200)
    const versions = await r.json() as Array<{ operation: string; content: string }>
    expect(versions.some((v) => v.operation === 'delete' && v.content === 'alice owns a red bike')).toBe(true)
  })

  it('the REST API cannot change, move, delete or import into a connector row (controls: an agent row can)', async () => {
    await start()
    const api = async (method: string, path: string, body?: unknown) =>
      (await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${DASH_TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).status
    const mcpId = saveAgentMemory('mcp:alice', 'alice prefers tea', 'warm').id
    const agentId = saveAgentMemory('helper-agent', 'agent row', 'warm').id

    expect(await api('PUT', `/api/memories/${agentId}`, { content: 'agent row v2' })).toBe(200)
    expect(await api('PUT', `/api/memories/${mcpId}`, { content: 'alice prefers coffee' })).toBe(400)
    expect(await api('PUT', `/api/memories/${mcpId}`, { content: 'alice prefers tea', category: 'shared' })).toBe(400)
    expect(await api('PUT', `/api/memories/${mcpId}`, { content: 'alice prefers tea', agent_id: 'helper-agent' })).toBe(400)
    expect(await api('PATCH', `/api/memories/${mcpId}`, { prepend: 'x ' })).toBe(400)
    expect(await api('DELETE', `/api/memories/${mcpId}`)).toBe(400)
    expect(rowById(mcpId)).toMatchObject({ agent_id: 'mcp:alice', content: 'alice prefers tea' })

    expect(await api('POST', '/api/memories/import', { agent_id: 'some-agent', chunks: ['imported control'] })).toBe(200)
    expect(await api('POST', '/api/memories/import', { agent_id: 'mcp:alice', chunks: ['planted'] })).toBe(400)
    expect(rowsOf('mcp:alice').map((x) => x.content)).toEqual(['alice prefers tea'])
    expect(await api('DELETE', `/api/memories/${agentId}`)).toBe(200)
  })
})
