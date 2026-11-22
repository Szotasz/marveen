// HOSTINGERROUTER1122 (Samu 83036): the Hostinger AI Router as an optional main-agent provider. Offered only on a
// Hostinger install (store/.platform), never the default, one write path (applyMainRouter), and the onboarding's
// claudeAuthPresent knows a router install. The vault and the install root are real, in a temp directory.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'hrouter-'))
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: root, STORE_DIR: join(root, 'store') }
})
const vault = new Map<string, string>()
vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vault.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vault.set(id, value) },
  deleteSecret: (id: string) => vault.delete(id),
}))

const {
  applyMainRouter, checkRouterKey, clearMainRouter, readInstallPlatform, resolveRouterModel, routerActive,
  routerAuthPresent, routerAvailable, routerModel, HOSTINGER_ROUTER_PROVIDER_ID, HOSTINGER_ROUTER_VAULT_KEY,
  HOSTINGER_ROUTER_DEFAULT_MODEL,
} = await import('../web/hostinger-router.js')
const { loadCustomProvider, saveCustomProvider } = await import('../web/custom-providers.js')
const { agentDir, readAgentCustomProvider, writeAgentCustomProvider } = await import('../web/agent-config.js')

// built at run time: a literal sk- shape trips the repository's secret gate (a fixture, not a key)
const KEY = ['sk', 'hstgr', '0123456789abcdefghij'].join('-')
const MAIN = 'marveen'
const cfgPath = () => join(agentDir(MAIN), 'agent-config.json')

beforeEach(() => {
  rmSync(join(root, 'store'), { recursive: true, force: true })
  rmSync(join(root, 'agents'), { recursive: true, force: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(agentDir(MAIN), { recursive: true })
  vault.clear()
})
afterEach(() => { vi.restoreAllMocks() })

describe('the platform marker', () => {
  it('only "hostinger" offers the router; absent, empty or anything else does not', () => {
    expect(routerAvailable(root)).toBe(false)
    expect(readInstallPlatform(root)).toBeNull()
    writeFileSync(join(root, 'store', '.platform'), '\n')
    expect(routerAvailable(root)).toBe(false)
    writeFileSync(join(root, 'store', '.platform'), 'docker\n')
    expect(routerAvailable(root)).toBe(false)
    writeFileSync(join(root, 'store', '.platform'), 'hostinger\n')
    expect(routerAvailable(root)).toBe(true)
  })
})

describe('key and model rules', () => {
  it('the key needs the sk-hstgr- prefix, one token, 20 to 512 characters', () => {
    expect(checkRouterKey(KEY)).toBeNull()
    expect(checkRouterKey(`  ${KEY}  `)).toBeNull()
    expect(checkRouterKey(['sk', 'ant', 'api03', 'x'.repeat(30)].join('-'))).not.toBeNull()
    expect(checkRouterKey('sk-hstgr-short')).not.toBeNull()
    expect(checkRouterKey(`${KEY} more`)).not.toBeNull()
  })
  it('the model is one of the dashed list; empty means the default; dotted or other ids are refused', () => {
    expect(resolveRouterModel(undefined)).toBe('claude-sonnet-5-5')
    expect(resolveRouterModel('')).toBe('claude-sonnet-5-5')
    expect(resolveRouterModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(resolveRouterModel('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(resolveRouterModel('claude-sonnet-5.5')).toBeNull()
    expect(resolveRouterModel('claude-fable-5-2')).toBeNull()
    expect(resolveRouterModel(42)).toBeNull()
  })
})

describe('apply and clear', () => {
  it('nothing is set by default: no custom provider, no auth from the router', () => {
    expect(readAgentCustomProvider(MAIN)).toBeNull()
    expect(routerActive(MAIN)).toBe(false)
    expect(routerAuthPresent(MAIN)).toBe(false)
  })
  it('apply writes the key, the provider record and the main agent fields; the router then counts as auth', () => {
    applyMainRouter(MAIN, KEY, 'claude-opus-5-5')
    expect(vault.get(HOSTINGER_ROUTER_VAULT_KEY)).toBe(KEY)
    expect(loadCustomProvider(HOSTINGER_ROUTER_PROVIDER_ID)).toEqual({
      id: 'hostinger-router', label: 'Hostinger AI Router', baseUrl: 'https://router.hostinger.com',
      authHeader: 'x-api-key', vaultKey: 'hostinger-router-api-key',
    })
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf-8')) as Record<string, unknown>
    expect(cfg.customProvider).toBe('hostinger-router')
    expect(cfg.model).toBe('claude-opus-5-5')
    expect(routerAuthPresent(MAIN)).toBe(true)
    expect(routerModel(MAIN)).toBe('claude-opus-5-5')
  })
  it('apply without a new key keeps the stored one; no key at all is no auth', () => {
    applyMainRouter(MAIN, null, HOSTINGER_ROUTER_DEFAULT_MODEL)
    expect(routerActive(MAIN)).toBe(true)
    expect(routerAuthPresent(MAIN)).toBe(false)
    vault.set(HOSTINGER_ROUTER_VAULT_KEY, KEY)
    expect(routerAuthPresent(MAIN)).toBe(true)
  })
  it('clear takes the provider and the router model off; the key and the record stay', () => {
    applyMainRouter(MAIN, KEY, 'claude-sonnet-5-5')
    expect(clearMainRouter(MAIN)).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf-8')) as Record<string, unknown>
    expect('customProvider' in cfg).toBe(false)
    expect('model' in cfg).toBe(false)
    expect(vault.get(HOSTINGER_ROUTER_VAULT_KEY)).toBe(KEY)
    expect(loadCustomProvider(HOSTINGER_ROUTER_PROVIDER_ID)).not.toBeNull()
    expect(routerAuthPresent(MAIN)).toBe(false)
  })
  it('clear leaves another custom provider alone', () => {
    saveCustomProvider({ id: 'own', label: 'Own', baseUrl: 'https://llm.example.com', authHeader: 'none', vaultKey: null })
    writeAgentCustomProvider(MAIN, 'own')
    expect(clearMainRouter(MAIN)).toBe(false)
    expect(readAgentCustomProvider(MAIN)).toBe('own')
    expect(existsSync(cfgPath())).toBe(true)
  })
})

// With a custom provider the main launch must not pass --model: the flag outranks the provider's ANTHROPIC_MODEL and
// would send the router (or any provider) a model it may not serve, e.g. the shipped default.
describe('channels.sh: no --model next to a custom provider', () => {
  it('the flag is cleared where the provider env is injected, before the launch line', () => {
    const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
    const inject = sh.indexOf('      CUSTOM_PROVIDER_ENV="$_cp_env"\n')
    const cleared = sh.indexOf('      MODEL_FLAG=""\n', inject)
    const launch = sh.indexOf('${CUSTOM_PROVIDER_ENV}${GROMZO_ENV}$CLAUDE --dangerously-skip-permissions${EXTRA_SETTINGS_FLAG} ${MODEL_FLAG}')
    expect(inject).toBeGreaterThan(-1)
    expect(cleared).toBeGreaterThan(inject)
    expect(cleared - inject).toBeLessThan(600)
    expect(launch).toBeGreaterThan(cleared)
  })
})

const { parseRouterModels, routerModelList, clearRouterModelCache } = await import('../web/hostinger-router.js')
describe('the router model list (Marveen 83042)', () => {
  const row = (id: string, endpoints = ['/v1/messages', '/v1/chat/completions'], params = ['tools', 'temperature']) =>
    ({ id, supported_endpoints: endpoints, supported_parameters: params })
  const BODY = { data: [
    row('kimi-k3'), row('claude-opus-4.6'), row('claude-haiku-5.5'), row('claude-sonnet-5.5'), row('claude-opus-5.5'),
    row('gpt-chat-only', ['/v1/chat/completions']), row('claude-no-tools', ['/v1/messages'], ['temperature']), row('claude-sonnet-5.5'),
  ] }
  it('keeps /v1/messages + tools, writes the measured three dashed, Claude first, the rest experimental', () => {
    const list = parseRouterModels(BODY)
    expect(list.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'kimi-k3'])
    expect(list.find((m) => m.id === 'kimi-k3')).toMatchObject({ claude: false, experimental: true, measured: false })
    // Samu 83056: a dotted, not measured claude- id stays out until it is measured
    expect(list.some((m) => m.id === 'claude-opus-4.6' || m.id === 'claude-opus-4-6')).toBe(false)
  })
  it('garbage in: an empty list', () => {
    for (const b of [null, 42, 'x', { data: 'x' }, { data: [null, { id: 'bad id with spaces' }] }]) expect(parseRouterModels(b)).toEqual([])
  })
  it('no key: the measured three, no request', async () => {
    clearRouterModelCache()
    let calls = 0
    const list = await routerModelList((async () => { calls++; return new Response('{}') }) as typeof fetch)
    expect([list.source, list.models.map((m) => m.id), calls]).toEqual(['fallback', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], 0])
  })
  it('with a key: one request with x-api-key, cached for 10 minutes; an error falls back and is not cached', async () => {
    clearRouterModelCache()
    vault.set(HOSTINGER_ROUTER_VAULT_KEY, KEY)
    const seen: Array<{ url: string; key: string | null }> = []
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get('x-api-key') })
      return new Response(JSON.stringify(BODY), { status: 200 })
    }) as unknown as typeof fetch
    const a = await routerModelList(ok, 1_000_000)
    const b = await routerModelList(ok, 1_000_000 + 9 * 60_000)
    expect([a.source, b.source, seen.length]).toEqual(['router', 'router', 1])
    expect(seen[0]).toEqual({ url: 'https://router.hostinger.com/v1/models', key: KEY })
    await routerModelList(ok, 1_000_000 + 11 * 60_000)
    expect(seen.length).toBe(2)
    clearRouterModelCache()
    const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect((await routerModelList(bad)).source).toBe('fallback')
    const thrown = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect((await routerModelList(thrown)).source).toBe('fallback')
    let after = 0
    await routerModelList((async () => { after++; return new Response(JSON.stringify(BODY)) }) as unknown as typeof fetch)
    expect(after).toBe(1)
  })
})

// Samu 83054: an experimental (non-Claude) model gets min(context_length, 200k) as Claude Code's window; the measured
// Claude models get nothing (Claude Code's own table); no window known -> not selectable.
const { routerContextTokens, routerModelSelectable, EXPERIMENTAL_CONTEXT_CAP, EXPERIMENTAL_CONTEXT_MIN } = await import('../web/hostinger-router.js')
describe('the context window of a router model', () => {
  it('caps an experimental model at 200k, leaves the Claude models alone, refuses an unknown window', () => {
    expect(EXPERIMENTAL_CONTEXT_CAP).toBe(200_000)
    const kimi = parseRouterModels({ data: [{ id: 'kimi-k3', supported_endpoints: ['/v1/messages'], supported_parameters: ['tools'], context_length: 1048576 }] })[0]
    expect(kimi).toMatchObject({ id: 'kimi-k3', experimental: true, contextTokens: 1048576 })
    expect(routerContextTokens(kimi)).toBe(200_000)
    expect(routerContextTokens({ id: 'small', experimental: true, contextTokens: 128_000 })).toBe(128_000)
    expect(routerContextTokens({ id: 'claude-sonnet-5-5', experimental: false, contextTokens: 1_000_000 })).toBeNull()
    const noWindow = { id: 'x', claude: false, measured: false, experimental: true, contextTokens: null }
    expect([routerContextTokens(noWindow), routerModelSelectable(noWindow)]).toEqual([null, false])
  })
  it('an experimental window under the 32k minimum is not offered (Geri N2); the minimum itself is', () => {
    expect(EXPERIMENTAL_CONTEXT_MIN).toBe(32_000)
    const tiny = { id: 'tiny', claude: false, measured: false, experimental: true, contextTokens: 1000 }
    expect([routerContextTokens(tiny), routerModelSelectable(tiny)]).toEqual([null, false])
    const under = { ...tiny, contextTokens: 31_999 }
    expect([routerContextTokens(under), routerModelSelectable(under)]).toEqual([null, false])
    const atMin = { ...tiny, contextTokens: 32_000 }
    expect([routerContextTokens(atMin), routerModelSelectable(atMin)]).toEqual([32_000, true])
  })
  it('apply writes the window for an experimental model and removes it otherwise; clear removes it', () => {
    applyMainRouter(MAIN, KEY, 'kimi-k3', 200_000)
    expect(JSON.parse(readFileSync(cfgPath(), 'utf-8')).customProviderContextTokens).toBe(200_000)
    applyMainRouter(MAIN, null, 'claude-opus-5-5', null)
    expect('customProviderContextTokens' in JSON.parse(readFileSync(cfgPath(), 'utf-8'))).toBe(false)
    applyMainRouter(MAIN, null, 'kimi-k3', 200_000)
    clearMainRouter(MAIN)
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf-8'))
    expect(['customProviderContextTokens' in cfg, 'model' in cfg, 'customProvider' in cfg]).toEqual([false, false, false])
  })
})
