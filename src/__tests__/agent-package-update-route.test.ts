// POST /api/agents/:name/package/check and /apply (MIOAGENTB4-1122, PR-I4; plan 6.2, 6.3, 8).
//
// The install route's harness (test deps over the in-memory fake server, the REAL owner gate, a temp tree): a 1.2.0
// install through the install route, then the update to 1.3.0 through check and apply.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-update-route-'))
process.env.CLAUDECLAW_ENV_DIR = tmpRoot
const STORE = join(tmpRoot, 'store')
const AGENTS = join(tmpRoot, 'agents')
mkdirSync(STORE, { recursive: true })
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'agent-a',
}))
const h = vi.hoisted(() => ({ baseCalls: [] as Array<[string, Record<string, unknown>]>, layoutSplit: false }))
vi.mock('../web/agent-create.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-create.js')>()),
  writeAgentBase: (name: string, base: Record<string, unknown>) => {
    h.baseCalls.push([name, base])
    writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify({ model: base.model }))
  },
}))
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null, measuredAt: null, error: null, source: 'test' }),
}))
vi.mock('../web/agent-package/install.js', async (orig) => {
  const real = await orig<typeof import('../web/agent-package/install.js')>()
  return { ...real, sameDeviceLayout: (s: string) => (h.layoutSplit ? real.sameDeviceLayout(s, (p) => ({ dev: p === s ? 1 : 2 })) : real.sameDeviceLayout(s)) }
})

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}
writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({ name: 'marveen', version: '1.50.0' }))

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { tryHandleAgentPackages } = await import('../web/routes/agent-packages.js')
const { makeRemote } = await import('../web/agent-package/remote.js')
const { makeKeyPair, makeSignedDelivery } = await import('./helpers/make-delivery.js')
import { TEST_DEVICE_ID, TEST_ORIGIN, TEST_TOKEN, callRoute, makeFakeServer, type FakeServer } from './helpers/agent-package-fake-server.js'
import type { PackageDeps } from '../web/routes/agent-packages.js'
import type { RouteContext } from '../web/routes/types.js'

const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const TOKEN_ONLY: RouteContext['auth'] = { kind: 'token' }
const NOW = new Date('2026-11-18T10:00:00.000Z')
const KEY = makeKeyPair()
const OTHER = makeKeyPair()
const CRED = join(STORE, 'agent-package-credential.json')

let fake: FakeServer
let deps: PackageDeps
const notified: string[] = []
const install = (body: unknown, auth: RouteContext['auth'] = SESSION, d: PackageDeps = deps) =>
  callRoute((ctx) => tryHandleAgentPackages(ctx, d), 'POST', '/api/agents/install-package', auth, body).then((r) => { expect(r.handled).toBe(true); return r.out })
const storeCredential = () => { writeFileSync(CRED, JSON.stringify({ schema: 1, token: TEST_TOKEN, deviceTokenId: TEST_DEVICE_ID, label: 'Mac', connectedAt: NOW.toISOString() }), { mode: 0o600 }); chmodSync(CRED, 0o600) }
const delivery = (over: Record<string, unknown> = {}) => Buffer.from(makeSignedDelivery({ kid: KEY.kid, privateKey: KEY.privateKey, slug: 'invoice-helper', version: '1.2.0', minMarveenVersion: '1.0.0', ...over }))
const messagesTo = (to: string) => (getDb().prepare('SELECT content FROM agent_messages WHERE to_agent = ?').all(to) as Array<{ content: string }>).map((r) => r.content)

// MIOAGENTB4-1122 (5b): the route reads the catalog before the download. Its answer comes from here, so `fake`
// keeps recording the download alone and the request counts below stay what they were.
const catalog: { body: unknown; calls: number } = { body: null, calls: 0 }
const withCatalog = (download: typeof fetch): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === `${TEST_ORIGIN}/functions/v1/agent-packages`) { catalog.calls++; return new Response(JSON.stringify(catalog.body), { status: 200 }) }
  return download(input, init)
}) as typeof fetch

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM agent_messages')
  _clearSessionCacheForTest()
  createDashboardUser('owner', 'x'.repeat(60))
  for (const f of readdirSync(STORE)) rmSync(join(STORE, f), { recursive: true, force: true })
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(AGENTS, { recursive: true })
  h.baseCalls.length = 0
  h.layoutSplit = false
  notified.length = 0
  fake = makeFakeServer()
  catalog.body = { access: 'full', trial_pick: null, packages: [{ slug: 'invoice-helper', version: '1.2.0', kid: KEY.kid }] }
  catalog.calls = 0
  deps = { keys: [KEY.jwk], fetchImpl: withCatalog(fake.fetchImpl), now: () => NOW, remote: makeRemote(TEST_ORIGIN), notify: async (t) => { notified.push(t); return true } }
  storeCredential()
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))


const NAME = 'invoice-helper'
const dirOf = (rel = '') => join(AGENTS, NAME, rel)
const V2 = {
  'CLAUDE.md': '# Invoice helper\n\nVersion two.\n',
  'SOUL.md': 'Calm.\n',
}
const call = (path: string, body: unknown, auth: RouteContext['auth'] = SESSION, d: PackageDeps = deps) =>
  callRoute((ctx) => tryHandleAgentPackages(ctx, d), 'POST', path, auth, body).then((r) => { expect(r.handled).toBe(true); return r.out })
const check = (body: unknown = {}, auth?: RouteContext['auth'], name = NAME) => call(`/api/agents/${name}/package/check`, body, auth)
const apply = (body: unknown, auth?: RouteContext['auth'], d?: PackageDeps) => call(`/api/agents/${NAME}/package/apply`, body, auth, d)
const serveVersion = (version: string, over: Record<string, unknown> = {}) => {
  catalog.body = { access: 'full', trial_pick: null, packages: [{ slug: NAME, version, kid: KEY.kid }] }
  fake.answer({ status: 200, body: delivery({ version, ...over }) })
}
const snapshot = (): string[] => {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = join(rel, e.name)
      if (e.isDirectory()) walk(join(d, e.name), r)
      else out.push(`${r}:${readFileSync(join(d, e.name), 'utf8').length}`)
    }
  }
  walk(dirOf(), '')
  return out.sort()
}

beforeEach(async () => {
  fake.answer({ status: 200, body: delivery() })
  const out = await install({ slug: NAME })
  expect(out.status).toBe(200)
})

describe('check (6.2)', () => {
  it('the owner first, before the body', async () => {
    expect((await check({}, TOKEN_ONLY)).status).toBe(403)
  })
  it('an upgrade: the change list, and nothing written', async () => {
    serveVersion('1.3.0', { files: V2 })
    const before = snapshot()
    const out = await check()
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ name: NAME, slug: NAME, kind: 'upgrade', installed: { version: '1.2.0' }, available: { version: '1.3.0' } })
    expect(out.body.planId).toMatch(/^[0-9a-f]{64}$/)
    expect(out.body.skillReport).toMatchObject({ quarantineApplies: false })
    expect('shellRepair' in out.body).toBe(false)
    expect(snapshot()).toEqual(before)
  })
  it('a repair answers shellRepair', async () => {
    serveVersion('1.2.0')
    const out = await check()
    expect(out.body).toMatchObject({ kind: 'repair', shellRepair: { shell: 'ok', local: 'ok' } })
  })
  it('a lower version: downgrade_refused with both versions; same version, other payload: version_conflict', async () => {
    serveVersion('1.1.0')
    expect(await check()).toMatchObject({ status: 409, body: { error: 'downgrade_refused', installed: '1.2.0', available: '1.1.0' } })
    serveVersion('1.2.0', { files: V2 })
    expect(await check()).toMatchObject({ status: 409, body: { error: 'version_conflict' } })
  })
  it('no such agent, a hand-made agent, an unreadable record', async () => {
    expect(await check({}, SESSION, 'nobody')).toMatchObject({ status: 404, body: { error: 'agent_not_found' } })
    mkdirSync(join(AGENTS, 'handmade'))
    expect(await check({}, SESSION, 'handmade')).toMatchObject({ status: 404, body: { error: 'not_a_package' } })
    writeFileSync(dirOf('.package/manifest.json'), '{broken')
    expect(await check()).toMatchObject({ status: 409, body: { error: 'manifest_unreadable' } })
  })
  it('a body that is not empty: 400', async () => {
    expect(await check({ x: 1 })).toMatchObject({ status: 400 })
  })
})

describe('apply (6.3)', () => {
  it('check then apply: the files and the record move to 1.3.0', async () => {
    serveVersion('1.3.0', { files: V2 })
    const c = await check()
    const out = await apply({ planId: c.body.planId, decisions: {} })
    expect(out).toMatchObject({ status: 200, body: { ok: true, kind: 'upgrade', version: '1.3.0', keptMine: [] } })
    expect(readFileSync(dirOf('PACKAGE.md'), 'utf8')).toBe(V2['CLAUDE.md'])
    expect(JSON.parse(readFileSync(dirOf('.package/manifest.json'), 'utf8')).payload.version).toBe('1.3.0')
  })
  it('a planId that is not the recomputed one: plan_changed with the new plan, nothing written', async () => {
    serveVersion('1.3.0', { files: V2 })
    const c = await check()
    writeFileSync(dirOf('SOUL.md'), 'owner soul\n')
    const out = await apply({ planId: c.body.planId, decisions: {} })
    expect(out).toMatchObject({ status: 409, body: { error: 'plan_changed' } })
    expect(out.body.plan.planId).not.toBe(c.body.planId)
    expect(readFileSync(dirOf('PACKAGE.md'), 'utf8')).not.toBe(V2['CLAUDE.md'])
  })
  it('a missing decision: decision_required; then keep-mine applies', async () => {
    serveVersion('1.3.0', { files: V2 })
    writeFileSync(dirOf('PACKAGE.md'), 'owner persona\n')
    const c = await check()
    expect(await apply({ planId: c.body.planId, decisions: {} })).toMatchObject({ status: 409, body: { error: 'decision_required', paths: ['CLAUDE.md'] } })
    const out = await apply({ planId: c.body.planId, decisions: { 'CLAUDE.md': 'keep-mine' } })
    expect(out).toMatchObject({ status: 200, body: { keptMine: ['CLAUDE.md'] } })
    expect(readFileSync(dirOf('PACKAGE.md'), 'utf8')).toBe('owner persona\n')
  })
  it('the owner first: 403, no request, the disk unchanged', async () => {
    serveVersion('1.3.0', { files: V2 })
    const c = await check()
    const n = fake.requests.length
    const before = snapshot()
    expect((await apply({ planId: c.body.planId, decisions: {} }, TOKEN_ONLY)).status).toBe(403)
    expect(fake.requests.length).toBe(n)
    expect(snapshot()).toEqual(before)
  })
  it('a malformed body: 400 before any download', async () => {
    const n = fake.requests.length
    for (const b of [{}, { planId: 'x', decisions: {} }, { planId: 'a'.repeat(64) }, { planId: 'a'.repeat(64), decisions: {}, extra: 1 }]) {
      expect((await apply(b)).status).toBe(400)
    }
    expect(fake.requests.length).toBe(n)
  })
  it('a second apply on the same agent while one runs: update_in_progress', async () => {
    serveVersion('1.3.0', { files: V2 })
    const c = await check()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow: PackageDeps = { ...deps, fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => { await gate; return deps.fetchImpl(input, init) }) as typeof fetch }
    const first = apply({ planId: c.body.planId, decisions: {} }, SESSION, slow)
    await new Promise((r) => setTimeout(r, 20))
    expect(await apply({ planId: c.body.planId, decisions: {} })).toMatchObject({ status: 409, body: { error: 'update_in_progress' } })
    release()
    expect((await first).status).toBe(200)
  })
})
