// POST /api/agents/install-package (MIOAGENTINSTALL1114, PR-I3; plan 6, 6.1, 10.2 (3), 10.3).
//
// Through tryHandleAgentPackages with test deps (makeRemote(TEST_ORIGIN) over the in-memory fake server, a key pair
// made at run time), the REAL owner gate over an in-memory database, and a temp PROJECT_ROOT and store. The CLI probe
// answers "unmeasured" (fail-open), writeAgentBase is a recorder (its writes are pinned elsewhere). Mutant rows 17, 18,
// 19, 25 (the name-only fleet notice) and 47 (the layout half) of plan 10.4 are pinned here.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-install-route-'))
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

describe('the success path (plan 6.1)', () => {
  it('downloads with the version header, verifies, installs, answers, and tells the fleet the NAME only', async () => {
    fake.answer({ status: 200, body: delivery({ description: 'SECRET-DESCRIPTION-WORD here.' }) })
    const out = await install({ slug: 'invoice-helper' })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, name: 'invoice-helper', version: '1.2.0', modelHintApplied: null })
    expect(out.body.skillReport).toMatchObject({ quarantineApplies: false, findings: {}, globalNameCollisions: [] })
    expect(typeof out.body.skillReport.quarantineOn).toBe('boolean')
    expect(fake.requests).toHaveLength(1)
    const r = fake.requests[0]
    expect(r.url).toBe(`${TEST_ORIGIN}/functions/v1/agent-package-download`)
    expect(r.method).toBe('POST')
    expect(r.redirect).toBe('manual')
    expect(r.headers['x-marveen-version']).toBe('1.50.0')
    expect(r.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(JSON.parse(r.body!)).toEqual({ slug: 'invoice-helper' })
    expect(existsSync(join(AGENTS, 'invoice-helper', 'PACKAGE.md'))).toBe(true)
    // (25) the fleet notice carries the name, never the payload's description.
    const msgs = messagesTo('agent-a')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('invoice-helper')
    expect(msgs[0]).not.toContain('SECRET-DESCRIPTION-WORD')
    expect(JSON.stringify(out.body)).not.toContain(TEST_TOKEN)
  })

  it('the same package again: 409 already_installed with the version, no download', async () => {
    fake.answer({ status: 200, body: delivery() })
    expect((await install({ slug: 'invoice-helper' })).status).toBe(200)
    const out = await install({ slug: 'invoice-helper' })
    expect(out).toMatchObject({ status: 409, body: { error: 'already_installed', version: '1.2.0' } })
    expect(fake.requests).toHaveLength(1)
  })
})

describe('local refusals come before any download (plan 6.1 steps 1-5)', () => {
  it('(18) no owner session: 403 owner_session_required, 0 requests, no folder', async () => {
    fake.answer({ status: 200, body: delivery() })
    const out = await install({ slug: 'invoice-helper' }, TOKEN_ONLY)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('owner_session_required')
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(join(AGENTS, 'invoice-helper'))).toBe(false)
  })

  it('a body that is not exactly {slug}: 400 bad_request', async () => {
    for (const b of ['x', [], { slug: 'a1', more: 1 }, { slug: 5 }, {}]) {
      expect(await install(b)).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('a slug off the strict form: 400 invalid_slug, 0 requests', async () => {
    for (const slug of ['a--b', 'ab-', '-ab', 'A1', 'a', 'a'.repeat(41), 'a_b', '../x']) {
      expect(await install({ slug })).toMatchObject({ status: 400, body: { error: 'invalid_slug' } })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('(K2) the six fixed route segments, the message-layer ids and the main agent: 409 name_reserved, 0 requests', async () => {
    for (const slug of ['activity', 'status', 'model-suggest', 'export-all', 'import', 'install-package', 'system', 'heartbeat', 'agent-a']) {
      expect(await install({ slug })).toMatchObject({ status: 409, body: { error: 'name_reserved' } })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('(19) a hand-made agent under the name: 409 name_taken, 0 requests, its folder byte for byte unchanged', async () => {
    mkdirSync(join(AGENTS, 'invoice-helper'))
    writeFileSync(join(AGENTS, 'invoice-helper', 'CLAUDE.md'), '# Mine\n')
    fake.answer({ status: 200, body: delivery() })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'name_taken' } })
    expect(fake.requests).toHaveLength(0)
    expect(readdirSync(join(AGENTS, 'invoice-helper'))).toEqual(['CLAUDE.md'])
    expect(readFileSync(join(AGENTS, 'invoice-helper', 'CLAUDE.md'), 'utf8')).toBe('# Mine\n')
  })

  it('a manifest of another slug, or an unreadable one: name_taken', async () => {
    mkdirSync(join(AGENTS, 'invoice-helper', '.package'), { recursive: true })
    writeFileSync(join(AGENTS, 'invoice-helper', '.package', 'manifest.json'), '{')
    expect((await install({ slug: 'invoice-helper' })).body.error).toBe('name_taken')
  })

  it('an orphan marker is reaped on the request path and the install goes on', async () => {
    mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
    writeFileSync(join(STORE, 'agent-package-installing', 'invoice-helper.json'), JSON.stringify({ slug: 'invoice-helper', version: '1.0.0', startedAt: 'x', pid: 1 }))
    fake.answer({ status: 200, body: delivery() })
    expect((await install({ slug: 'invoice-helper' })).status).toBe(200)
  })

  it('a link in the marker\'s place: 409 stale_install, a marker_blocked notice, 0 requests', async () => {
    mkdirSync(join(STORE, 'agent-package-installing'), { recursive: true })
    symlinkSync(join(tmpRoot, 'nowhere'), join(STORE, 'agent-package-installing', 'invoice-helper.json'))
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'stale_install' } })
    expect(fake.requests).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(notified.some((t) => t.includes('invoice-helper'))).toBe(true)
  })

  it('(47) agents/ and store/ on different devices: 409 unsupported_layout, 0 requests, nothing written', async () => {
    h.layoutSplit = true
    const out = await install({ slug: 'invoice-helper' })
    expect(out).toMatchObject({ status: 409, body: { error: 'unsupported_layout' } })
    expect(out.body.message).toContain('different volumes')
    expect(fake.requests).toHaveLength(0)
    expect(readdirSync(AGENTS)).toEqual([])
  })

  it('no credential: 409 not_connected, 0 requests', async () => {
    rmSync(CRED)
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'not_connected' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('(18) an empty key list, or no origin: 502 not_configured, 0 requests', async () => {
    expect(await install({ slug: 'invoice-helper' }, SESSION, { ...deps, keys: [] })).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'not_configured' } })
    expect(await install({ slug: 'invoice-helper' }, SESSION, { ...deps, remote: makeRemote('') })).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'not_configured' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('an own version that cannot be read: 500 own_version_unknown, 0 requests', async () => {
    const pj = join(tmpRoot, 'package.json')
    const before = readFileSync(pj)
    writeFileSync(pj, '{}')
    try {
      expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 500, body: { error: 'own_version_unknown' } })
    } finally {
      writeFileSync(pj, before)
    }
    expect(fake.requests).toHaveLength(0)
  })
})

describe('the signing key is checked against the catalog BEFORE the download (MIOAGENTB4-1122, 5b; Samu D2)', () => {
  // On a trial account the download fixes the one pick: a package this build would refuse must not be downloaded.
  it('a kid this build does not know: 409 unknown_kid, no download, nothing on disk', async () => {
    catalog.body = { access: 'trial', trial_pick: null, packages: [{ slug: 'invoice-helper', kid: OTHER.kid }] }
    fake.answer({ status: 200, body: delivery() })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'unknown_kid' } })
    expect(catalog.calls).toBe(1)
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(join(AGENTS, 'invoice-helper'))).toBe(false)
  })

  it.each([
    ['no kid on the row', { slug: 'invoice-helper' }],
    ['a kid that is not a string', { slug: 'invoice-helper', kid: 7 }],
  ])('fail-closed, %s: 409 unknown_kid, no download', async (_l, row) => {
    catalog.body = { access: 'full', trial_pick: null, packages: [row] }
    fake.answer({ status: 200, body: delivery() })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'unknown_kid' } })
    expect(fake.requests).toHaveLength(0)
  })

  it.each([
    ['another slug only', { access: 'full', trial_pick: null, packages: [{ slug: 'other-one', kid: 'x' }] }],
    ['no packages list', { access: 'full', trial_pick: null }],
    ['a list of non-objects', { access: 'full', trial_pick: null, packages: ['invoice-helper', null] }],
  ])('no catalog row for the slug (%s): 404 package_not_found, no download', async (_l, body) => {
    catalog.body = body
    fake.answer({ status: 200, body: delivery() })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 404, body: { error: 'package_not_found' } })
    expect(fake.requests).toHaveLength(0)
  })

  it('a catalog refusal passes through as the shared table says, no download', async () => {
    const d: PackageDeps = { ...deps, fetchImpl: fake.fetchImpl }
    fake.answer((r) => (r.url.endsWith('/agent-packages') ? { status: 401, body: JSON.stringify({ error: 'token_expired' }) } : { status: 200, body: delivery() }))
    expect(await install({ slug: 'invoice-helper' }, SESSION, d)).toMatchObject({ status: 409, body: { error: 'credential_rejected', reason: 'token_expired' } })
    expect(fake.requests.map((r) => r.url)).toEqual([`${TEST_ORIGIN}/functions/v1/agent-packages`])
  })

  it('local refusals still come first: an installed package is refused without reading the catalog', async () => {
    fake.answer({ status: 200, body: delivery() })
    expect((await install({ slug: 'invoice-helper' })).status).toBe(200)
    expect(catalog.calls).toBe(1)
    expect((await install({ slug: 'invoice-helper' })).status).toBe(409)
    expect(catalog.calls).toBe(1)
  })
})

describe('after the download (plan 6.1 steps 6-9)', () => {
  it('the publishing side refuses: the closed table answers', async () => {
    fake.answer({ status: 403, body: JSON.stringify({ error: 'not_entitled', reason: 'trial_limit', trial_pick: 'other-one' }) })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'not_entitled', reason: 'trial_limit', trialPick: 'other-one' } })
    fake.answer({ status: 401, body: JSON.stringify({ error: 'token_expired' }) })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'credential_rejected', reason: 'token_expired' } })
    fake.answer({ status: 302, headers: { location: 'https://evil.test/' } })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 502, body: { error: 'download_failed', reason: 'redirect' } })
    expect(readdirSync(AGENTS)).toEqual([])
  })

  it('(17) a delivery signed by a key not on the list: 422 package_rejected, nothing on disk', async () => {
    fake.answer({ status: 200, body: Buffer.from(makeSignedDelivery({ kid: KEY.kid, privateKey: OTHER.privateKey, slug: 'invoice-helper' })) })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 422, body: { error: 'package_rejected', step: 1, reason: 'bad_signature' } })
    expect(readdirSync(AGENTS)).toEqual([])
    expect(existsSync(join(STORE, 'agent-package-installing', 'invoice-helper.json'))).toBe(false)
  })

  it('MIOAGENTB4-1122 (Samu 83364): the catalog names a known kid, the delivery comes with another one: verifyDelivery still refuses it after the download', async () => {
    // The catalog check before the download is the first line; between the two calls the publishing side may change.
    expect((catalog.body as { packages: Array<{ kid: string }> }).packages[0].kid).toBe(KEY.kid)
    fake.answer({ status: 200, body: Buffer.from(makeSignedDelivery({ kid: OTHER.kid, privateKey: OTHER.privateKey, slug: 'invoice-helper' })) })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 422, body: { error: 'package_rejected', step: 1, reason: 'unknown_kid' } })
    expect(catalog.calls).toBe(1)
    expect(fake.requests).toHaveLength(1)
    expect(readdirSync(AGENTS)).toEqual([])
  })

  it('(55) a manifest text the rules refuse: rejected before anything reaches a config', async () => {
    fake.answer({ status: 200, body: delivery({ displayName: '@evil name' }) })
    expect((await install({ slug: 'invoice-helper' })).status).toBe(422)
    expect(h.baseCalls).toEqual([])
    expect(readdirSync(AGENTS)).toEqual([])
  })

  it('an own version under the minimum: 409 incompatible, nothing on disk', async () => {
    fake.answer({ status: 200, body: delivery({ minMarveenVersion: '9.0.0' }) })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'incompatible', minMarveenVersion: '9.0.0' } })
    expect(readdirSync(AGENTS)).toEqual([])
  })

  it('(18) the model hint applies only to a Claude model of the closed list', async () => {
    const cases: Array<[string, boolean]> = [['claude-sonnet-5', true], ['gpt-5', false], ['claude-made-up-9', false], ['deepseek-chat', false]]
    for (const [hint, applied] of cases) {
      rmSync(AGENTS, { recursive: true, force: true })
      mkdirSync(AGENTS)
      h.baseCalls.length = 0
      fake.answer({ status: 200, body: delivery({ modelHint: hint }) })
      const out = await install({ slug: 'invoice-helper' })
      expect(out.status).toBe(200)
      expect(out.body.modelHintApplied).toBe(applied)
      expect(h.baseCalls[0][1].model === hint).toBe(applied)
    }
  })
})

describe('Dani, #2826 review 79824 (2): the credential file is not read through a link', () => {
  it('a link in the credential\'s place: not connected, nothing sent; the real file: connected', async () => {
    const real = join(tmpRoot, 'elsewhere-credential.json')
    writeFileSync(real, readFileSync(CRED), { mode: 0o600 })
    rmSync(CRED)
    symlinkSync(real, CRED)
    const get = await callRoute((ctx) => tryHandleAgentPackages(ctx, deps), 'GET', '/api/agent-packages/credential', SESSION)
    expect(get.out.body).toEqual({ connected: false, configured: true })
    fake.answer({ status: 200, body: delivery() })
    expect(await install({ slug: 'invoice-helper' })).toMatchObject({ status: 409, body: { error: 'not_connected' } })
    expect(fake.requests).toHaveLength(0)
    rmSync(CRED)
    storeCredential()
    const again = await callRoute((ctx) => tryHandleAgentPackages(ctx, deps), 'GET', '/api/agent-packages/credential', SESSION)
    expect(again.out.body.connected).toBe(true)
  })
})

describe('the name the owner chose in the install dialog (MIOAGENTB4-1122, Samu 83718/83741)', () => {
  const base = () => h.baseCalls[0]?.[1] as Record<string, unknown> | undefined

  it('sets only the display name: the agent id, the folder and the download stay the slug', async () => {
    fake.answer({ status: 200, body: delivery() })
    const out = await install({ slug: 'invoice-helper', display_name: 'Számlázó Kati' })
    expect(out).toMatchObject({ status: 200, body: { ok: true, name: 'invoice-helper' } })
    expect(h.baseCalls.map(([n]) => n)).toEqual(['invoice-helper'])
    expect(base()?.displayName).toBe('Számlázó Kati')
    expect(existsSync(join(AGENTS, 'invoice-helper', 'PACKAGE.md'))).toBe(true)
    expect(JSON.parse(fake.requests[0]!.body!)).toEqual({ slug: 'invoice-helper' }) // the chosen name never leaves the machine
  })

  it('is cleaned the way the package name is held: one line, no S11 code point, no edge space, at most 60', async () => {
    fake.answer({ status: 200, body: delivery() })
    await install({ slug: 'invoice-helper', display_name: '  Számlázó\nKati\t​ ' + 'x'.repeat(70) })
    const name = String(base()?.displayName)
    expect(name.startsWith('Számlázó Kati x')).toBe(true)
    expect(Array.from(name)).toHaveLength(60)
    expect(/[\n\t​]|^\s|\s$/u.test(name)).toBe(false)
  })

  it('empty or only white space: the package\'s own name stays', async () => {
    for (const display_name of ['', '   \n ']) {
      rmSync(join(AGENTS, 'invoice-helper'), { recursive: true, force: true })
      h.baseCalls.length = 0
      fake.answer({ status: 200, body: delivery() })
      expect((await install({ slug: 'invoice-helper', display_name })).status).toBe(200)
      expect(base()?.displayName).toBe('Invoice helper')
    }
  })

  it('not a string, longer than 200, or an import token after the cleaning: 400 invalid_display_name, 0 requests, no folder', async () => {
    fake.answer({ status: 200, body: delivery() })
    for (const display_name of [5, null, ['x'], 'x'.repeat(201), '@notes/secret.md', 'Kati &#x40; x']) {
      expect(await install({ slug: 'invoice-helper', display_name })).toMatchObject({ status: 400, body: { error: 'invalid_display_name' } })
    }
    expect(fake.requests).toHaveLength(0)
    expect(existsSync(join(AGENTS, 'invoice-helper'))).toBe(false)
  })

  it('exactly 200 characters is accepted (and cut to 60)', async () => {
    fake.answer({ status: 200, body: delivery() })
    expect((await install({ slug: 'invoice-helper', display_name: 'y'.repeat(200) })).status).toBe(200)
    expect(base()?.displayName).toBe('y'.repeat(60))
  })

  it('any other key next to it is still a 400 bad_request', async () => {
    expect(await install({ slug: 'invoice-helper', display_name: 'Kati', folder: '../x' })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(await install({ display_name: 'Kati' })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(fake.requests).toHaveLength(0)
  })
})
