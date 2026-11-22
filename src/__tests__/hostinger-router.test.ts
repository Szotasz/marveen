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
