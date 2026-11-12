// APIAGENTWRITE1104: the shared access token (every sub-agent can read it) must not change what another agent is told
// (CLAUDE.md, SOUL.md), what it runs (.mcp.json), where its prompt goes (customProvider, custom providers), which login
// it runs under (authMode, apiKey, claudePlan), its memory boundary, its security profile, where it runs (remote) or
// replace it wholesale (import with overwrite). Those need the owner: the browser login, the token with the owner's
// session cookie beside it, or the Bridge's full key with that cookie (mayActAsOwner, strict since OWNERGATE2-1104 / OWNERGATE4-1104: no first-run branch). model and
// modelProfile stay token-writable (Samu 69185). A refused call writes NOTHING, measured on the bytes.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleCustomProviders } = await import('../web/routes/custom-providers.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT } = await import('../config.js')
// custom-providers.ts keeps its file under PROJECT_ROOT/store (this checkout's, gitignored): saved and restored here,
// the same pattern as agent-model-custom-provider-brackets.test.ts.
const PROVIDERS_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')
let providersBefore: string | null = null
const { AGENT_PUT_OWNER_FIELDS, AGENT_PUT_WRITABLE_FIELDS, agentPutOwnerFields } = await import('../web/agent-put-fields.js')

const AGENT = '__test-agent-write-owner-gated'
const DIR = agentDir(AGENT)
const FILES = ['CLAUDE.md', 'SOUL.md', '.mcp.json', 'agent-config.json'] as const
const ORIGINAL: Record<string, string> = {
  'CLAUDE.md': '# original instructions\n',
  'SOUL.md': 'original soul\n',
  '.mcp.json': '{"mcpServers":{}}\n',
  'agent-config.json': '{"model":"claude-opus-5"}\n',
}

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; device?: string; tokenAgent?: string } | undefined
type Handler = (ctx: any, webDir: string) => Promise<boolean>
async function hit(handler: Handler, method: string, path: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth }
  expect(await handler(ctx, join(PROJECT_ROOT, "web"))).toBe(true)
  return { status: out.status || 200, body: out.body }
}
const refusedByOwnerGate = (r: { status: number, body: any }) => r.status === 403 && r.body?.code === 'owner_session_required'
const snapshot = () => Object.fromEntries(FILES.map((f) => [f, existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), 'utf-8') : null]))

let ownerId = 0
const ownerCookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}` })
const TOKEN: Auth = { kind: 'token' }
const SESSION: Auth = { kind: 'session' }

beforeAll(() => {
  initDatabase(':memory:')
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  providersBefore = existsSync(PROVIDERS_PATH) ? readFileSync(PROVIDERS_PATH, 'utf-8') : null
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  for (const f of FILES) writeFileSync(join(DIR, f), ORIGINAL[f])
  writeFileSync(PROVIDERS_PATH, JSON.stringify({ providers: [{ id: 'keep', label: 'Keep', baseUrl: 'http://127.0.0.1:1', authHeader: 'none', vaultKey: null }] }, null, 2))
})
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  if (providersBefore !== null) writeFileSync(PROVIDERS_PATH, providersBefore)
  else rmSync(PROVIDERS_PATH, { force: true })
})

describe('the field split', () => {
  it('owner fields + {model, modelProfile} are exactly the writable fields (a new writable field must be classified)', () => {
    expect([...AGENT_PUT_OWNER_FIELDS, 'model', 'modelProfile'].sort()).toEqual([...AGENT_PUT_WRITABLE_FIELDS].sort())
  })
  it('a field set to null or an empty string still counts (clearing a provider or a plan changes the target)', () => {
    expect(agentPutOwnerFields({ customProvider: null, claudePlan: '', model: 'x' })).toEqual(['claudePlan', 'customProvider'])
  })
})

describe('PUT /api/agents/:name with the bare shared token', () => {
  const values: Record<string, unknown> = {
    claudeMd: '# injected\n', soulMd: 'injected', mcpJson: '{"mcpServers":{"x":{"command":"true"}}}',
    authMode: 'shared', apiKey: 'k', claudePlan: '', memoryIsolation: true, customProvider: null,
    engine: 'codex', codexConfigDir: '/tmp/codex-home-x',
  }
  for (const field of AGENT_PUT_OWNER_FIELDS) {
    it(`${field}: 403 owner_session_required, and no file changed`, async () => {
      const before = snapshot()
      const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, TOKEN, { [field]: values[field] })
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(r.body.fields).toEqual([field])
      expect(snapshot()).toEqual(before)
    })
  }

  it('a mixed body {model, claudeMd} is refused whole: the token-writable model is NOT written either', async () => {
    const before = snapshot()
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, TOKEN, { model: 'claude-sonnet-5', claudeMd: '# injected\n' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(snapshot()).toEqual(before)
  })

  it('control: {model} alone still goes through with the token', async () => {
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, TOKEN, { model: 'claude-opus-5' })
    expect(refusedByOwnerGate(r)).toBe(false)
  })

  it('a sub-agent\'s own token with the owner cookie is refused too', async () => {
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, { kind: 'token', tokenAgent: 'samu' }, { claudeMd: '# x\n' }, ownerCookie())
    expect(refusedByOwnerGate(r)).toBe(true)
  })

  it('a bare full device key, and an operator key with the cookie, are refused', async () => {
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, { kind: 'device', scope: 'full', device: 'Bridge' }, { claudeMd: '# x\n' }))).toBe(true)
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, { kind: 'device', scope: 'operator', device: 'Op' }, { claudeMd: '# x\n' }, ownerCookie()))).toBe(true)
    expect(snapshot()['CLAUDE.md']).toBe(ORIGINAL['CLAUDE.md'])
  })
})

describe('PUT /api/agents/:name on the owner lanes', () => {
  const lanes: Array<[string, Auth, () => Record<string, string>]> = [
    ['session (browser login)', SESSION, () => ({})],
    ['token + owner cookie', TOKEN, ownerCookie],
    ['full device key + owner cookie (the Bridge)', { kind: 'device', scope: 'full', device: 'Bridge' }, ownerCookie],
  ]
  for (const [label, auth, headers] of lanes) {
    it(`${label}: CLAUDE.md, SOUL.md and .mcp.json are written`, async () => {
      const body = { claudeMd: `# by ${label}\n`, soulMd: `soul ${label}`, mcpJson: '{"mcpServers":{}}' }
      const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, auth, body, headers())
      expect(r.status).toBe(200)
      expect(readFileSync(join(DIR, 'CLAUDE.md'), 'utf-8')).toBe(body.claudeMd)
      expect(readFileSync(join(DIR, 'SOUL.md'), 'utf-8')).toBe(body.soulMd)
      expect(readFileSync(join(DIR, '.mcp.json'), 'utf-8')).toBe(body.mcpJson)
    })
  }

  // OWNERGATE2-1104 (review finding, tech lead decision): the first-run branch no longer reaches these gates. Before the
  // first dashboard login the bare token is refused too, with setup_required (create a login first).
  it('before the first dashboard login the shared token is refused with setup_required, and nothing is written', async () => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    const before = snapshot()
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, TOKEN, { claudeMd: '# first run\n' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBe(true)
    expect(r.body.fields).toEqual(['claudeMd'])
    expect(snapshot()).toEqual(before)
  })
})

describe('OWNERGATE2-1104: first-run (zero dashboard users), every APIAGENTWRITE1104 gate refuses the bare token', () => {
  const zeroUsers = () => { getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users'); _clearSessionCacheForTest() }
  const providers = () => readFileSync(PROVIDERS_PATH, 'utf-8')
  const rows: Array<[string, Handler, string, string, unknown, Record<string, string>?]> = [
    ['PUT /api/agents/:name (owner field)', tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, { mcpJson: '{"mcpServers":{"x":{"command":"true"}}}' }],
    ['PUT /api/agents/:name/security', tryHandleAgents, 'PUT', `/api/agents/${AGENT}/security`, { profile: 'default' }],
    ['PUT /api/agents/:name/remote', tryHandleAgents, 'PUT', `/api/agents/${AGENT}/remote`, { host: 'evil.example', workdir: '/tmp' }],
    ['POST /api/agents/import (overwrite)', tryHandleAgents, 'POST', `/api/agents/import?name=${AGENT}&overwrite=1`, Buffer.from('not a bundle'), { 'content-type': 'application/gzip' }],
    ['POST /api/custom-providers', tryHandleCustomProviders, 'POST', '/api/custom-providers', { id: 'added', label: 'Added', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null }],
    ['DELETE /api/custom-providers/:id', tryHandleCustomProviders, 'DELETE', '/api/custom-providers/keep', undefined],
  ]
  for (const [label, handler, method, path, body, headers] of rows) {
    it(`${label}: 403 owner_session_required + setup_required, nothing written`, async () => {
      zeroUsers()
      const before = { files: snapshot(), providers: providers(), settings: existsSync(join(DIR, '.claude', 'settings.json')) }
      const r = await hit(handler, method, path, TOKEN, body, headers)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(r.body.setup_required).toBe(true)
      expect(r.body.error).toMatch(/no dashboard login exists yet/)
      expect({ files: snapshot(), providers: providers(), settings: existsSync(join(DIR, '.claude', 'settings.json')) }).toEqual(before)
    })
  }
  it('control: {model} alone still goes through with the bare token before the first login (not an owner field)', async () => {
    zeroUsers()
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, TOKEN, { model: 'claude-opus-5' }))).toBe(false)
  })
  it('a session principal passes the gate whatever the user count (control)', async () => {
    zeroUsers()
    expect((await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}`, SESSION, { claudeMd: '# by session\n' })).status).toBe(200)
  })
})

describe('the related agent endpoints', () => {
  it('PUT /security: the token is refused, settings.json is not written; the session passes the gate', async () => {
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/security`, TOKEN, { profile: 'default' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(existsSync(join(DIR, '.claude', 'settings.json'))).toBe(false)
    // Past the gate, the profile validation answers (an empty profile is a 400): nothing is written.
    const s = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/security`, SESSION, {})
    expect(s.status).toBe(400)
  })

  it('PUT /remote: the token is refused and agent-config.json is unchanged; the session passes the gate', async () => {
    const before = snapshot()
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/remote`, TOKEN, { host: 'evil.example', workdir: '/tmp' }))).toBe(true)
    expect(snapshot()).toEqual(before)
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/remote`, SESSION, { host: '', workdir: '' }))).toBe(false)
  })

  it('POST /import: the token is refused before the bundle is read, with or without overwrite (OWNERGATE2-1104)', async () => {
    const before = snapshot()
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', `/api/agents/import?name=${AGENT}&overwrite=1`, TOKEN, Buffer.from('not a bundle'), { 'content-type': 'application/gzip' }))).toBe(true)
    expect(snapshot()).toEqual(before)
    // OWNERGATE2-1104 changed this control: importing a NEW agent is owner-only too, so the token is refused here as well.
    const plain = await hit(tryHandleAgents, 'POST', `/api/agents/import?name=${AGENT}-new`, TOKEN, Buffer.from('not a bundle'), { 'content-type': 'application/gzip' })
    expect(refusedByOwnerGate(plain)).toBe(true)
    // And the session passes the overwrite gate (then the same bundle error).
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', `/api/agents/import?name=${AGENT}&overwrite=1`, SESSION, Buffer.from('not a bundle'), { 'content-type': 'application/gzip' }))).toBe(false)
  })
})

describe('/api/custom-providers', () => {
  const providers = () => readFileSync(PROVIDERS_PATH, 'utf-8')
  // A valid definition (a local baseUrl passes validation), so the session control measures the gate, not validation.
  const def = { id: 'added', label: 'Added', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null }

  it('POST and DELETE with the bare token are refused; the store file is unchanged', async () => {
    const before = providers()
    expect(refusedByOwnerGate(await hit(tryHandleCustomProviders, 'POST', '/api/custom-providers', TOKEN, def))).toBe(true)
    expect(refusedByOwnerGate(await hit(tryHandleCustomProviders, 'DELETE', '/api/custom-providers/keep', TOKEN))).toBe(true)
    expect(providers()).toBe(before)
  })

  it('reading stays token-readable (control)', async () => {
    const r = await hit(tryHandleCustomProviders, 'GET', '/api/custom-providers', TOKEN)
    expect(r.status).toBe(200)
    expect(r.body.providers.map((p: { id: string }) => p.id)).toEqual(['keep'])
    expect((await hit(tryHandleCustomProviders, 'GET', '/api/custom-providers/keep', TOKEN)).status).toBe(200)
  })

  it('the owner session adds and removes one', async () => {
    expect((await hit(tryHandleCustomProviders, 'POST', '/api/custom-providers', SESSION, def)).status).toBe(200)
    expect(JSON.parse(providers()).providers.map((p: { id: string }) => p.id)).toContain('added')
    expect((await hit(tryHandleCustomProviders, 'DELETE', '/api/custom-providers/added', TOKEN, undefined, ownerCookie())).status).toBe(200)
    expect(JSON.parse(providers()).providers.map((p: { id: string }) => p.id)).not.toContain('added')
  })
})
