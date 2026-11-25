// HOSTINGERROUTER1122: the Hostinger AI Router as an optional provider for the MAIN agent, offered only on a Hostinger
// install and never the default (owner's condition). The router speaks the Anthropic Messages API (measured live,
// 2026-11-22: streaming, tool_use and several turns, with x-api-key), so it rides the existing customProvider path:
// a provider record, a vault key, and the main agent's customProvider + model fields. One write path (Samu 83036):
// the main-agent auth switch (main-auth-switch.ts) and the onboarding's claude-auth step both call applyMainRouter.
//
// Only the main agent: a sub-agent keeps running on the Claude subscription (or its own setup), and the wizard says so.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSecret, setSecret } from './vault.js'
import { loadCustomProvider, saveCustomProvider } from './custom-providers.js'
import {
  agentDir, readAgentCustomProvider, readAgentModel, readJsonObjectForWrite, writeAgentCustomProvider, writeAgentModel,
} from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const HOSTINGER_ROUTER_PROVIDER_ID = 'hostinger-router'
export const HOSTINGER_ROUTER_BASE_URL = 'https://router.hostinger.com'
export const HOSTINGER_ROUTER_VAULT_KEY = 'hostinger-router-api-key'
/** Dashed Anthropic ids: the ones our model tables and the context guard know (the router maps them, measured). */
export const HOSTINGER_ROUTER_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const
export const HOSTINGER_ROUTER_DEFAULT_MODEL = 'claude-sonnet-5-5'

/** The install's platform marker (store/.platform), written once by docker/first-boot.sh; null when absent. */
export function readInstallPlatform(projectRoot: string): string | null {
  try {
    const v = readFileSync(join(projectRoot, 'store', '.platform'), 'utf-8').split('\n')[0].trim()
    return v || null
  } catch { return null }
}

/** The router is offered only on a Hostinger install (the marker comes only from docker/hostinger-compose.yml). */
export function routerAvailable(projectRoot: string): boolean {
  return readInstallPlatform(projectRoot) === 'hostinger'
}

/** A router key: the sk-hstgr- prefix, one token, 20 to 512 characters. Returns an error text, or null when it fits. */
export function checkRouterKey(raw: string): string | null {
  const k = raw.trim()
  if (!k.startsWith('sk-hstgr-')) return 'The Hostinger AI Router key starts with sk-hstgr-.'
  if (k.length < 20 || k.length > 512 || /\s/.test(k)) return 'The Hostinger AI Router key does not look like a key (no spaces, 20 to 512 characters).'
  return null
}

/** A model the router path accepts: one of the fixed list. Empty means the default. */
export function resolveRouterModel(raw: unknown, allowed: readonly string[] = []): string | null {
  if (raw === undefined || raw === null || raw === '') return HOSTINGER_ROUTER_DEFAULT_MODEL
  if (typeof raw !== 'string') return null
  return (HOSTINGER_ROUTER_MODELS as readonly string[]).includes(raw) || allowed.includes(raw) ? raw : null
}

/**
 * HOSTINGERSUBAGENTAUTH1122: a Claude sub-agent on a router install that has no way to sign in. A router install
 * usually has no Claude subscription at all: no fleet setup-token and no login in the shared ~/.claude. Such an
 * agent would start and sit on the login screen in silence, so the launcher refuses it and the create form warns.
 * Only on a router install (owner's rule: elsewhere nothing changes), and only for an agent that would use the
 * Claude login (not authMode 'api', not 'own_team', not a custom provider, not an operator-set config dir), and that
 * has no host API key to run on (a key-only install, Geri #3045 B1).
 */
export function subAgentClaudeAuthMissing(f: {
  routerInstall: boolean
  isMainAgent: boolean
  needsClaudeLogin: boolean
  tokenExported: boolean
  /** A key-only install (no fleet token, ANTHROPIC_API_KEY in .env): the launcher runs the agent on the host key. */
  hostKeyLaunch: boolean
  configuredConfigDir: boolean
  sharedLoginPresent: boolean
}): boolean {
  return f.routerInstall && !f.isMainAgent && f.needsClaudeLogin && !f.tokenExported && !f.hostKeyLaunch
    && !f.configuredConfigDir && !f.sharedLoginPresent
}

export function routerActive(mainAgentId: string): boolean {
  return readAgentCustomProvider(mainAgentId) === HOSTINGER_ROUTER_PROVIDER_ID
}

export function routerKeyStored(): boolean {
  try { return !!(getSecret(HOSTINGER_ROUTER_VAULT_KEY) ?? '').trim() } catch { return false }
}

/** The main agent runs on the router and can authenticate: provider set, its record present, its key in the vault. */
export function routerAuthPresent(mainAgentId: string): boolean {
  return routerActive(mainAgentId) && loadCustomProvider(HOSTINGER_ROUTER_PROVIDER_ID) !== null && routerKeyStored()
}

/** The router model the main agent is set to, when it runs on the router. */
export function routerModel(mainAgentId: string): string | null {
  if (!routerActive(mainAgentId)) return null
  return readAgentModel(mainAgentId) || null
}

/**
 * Point the main agent at the router: the key (when a new one is given) into the vault, the provider record, and the
 * main agent's customProvider + model. The caller has checked the key, the model and who may do it.
 */
export function applyMainRouter(mainAgentId: string, newKey: string | null, model: string, contextTokens: number | null = null): void {
  // A fresh Docker install has no agents/<main>/ folder yet, so the config write failed with ENOENT after the key and
  // the provider record were already stored: the wizard answered 500 and left a half-made setting (Geri 83274, v1.51.1).
  // Created first, before anything is written.
  mkdirSync(agentDir(mainAgentId), { recursive: true })
  if (newKey) {
    setSecret(HOSTINGER_ROUTER_VAULT_KEY, 'Hostinger AI Router key (main agent)', newKey.trim())
    clearRouterModelCache()
  }
  saveCustomProvider({
    id: HOSTINGER_ROUTER_PROVIDER_ID,
    label: 'Hostinger AI Router',
    baseUrl: HOSTINGER_ROUTER_BASE_URL,
    authHeader: 'x-api-key',
    vaultKey: HOSTINGER_ROUTER_VAULT_KEY,
  })
  writeAgentModel(mainAgentId, model)
  writeProviderContextTokens(mainAgentId, contextTokens)
  writeAgentCustomProvider(mainAgentId, HOSTINGER_ROUTER_PROVIDER_ID)
}

/** The main agent's customProviderContextTokens: set for an experimental router model, removed otherwise. */
function writeProviderContextTokens(mainAgentId: string, tokens: number | null): void {
  const configPath = join(agentDir(mainAgentId), 'agent-config.json')
  const config = readJsonObjectForWrite(configPath)
  if (tokens !== null && Number.isSafeInteger(tokens) && tokens > 0) config.customProviderContextTokens = tokens
  else if ('customProviderContextTokens' in config) delete config.customProviderContextTokens
  else return
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
}

/**
 * Back from the router: the main agent's customProvider and the router model go (on the subscription the main model
 * comes from MAIN_AGENT_MODEL or .claude/settings.json, so a leftover router model would only mislead the dashboard);
 * the vault key and the record stay. Another custom provider is left alone.
 */
export function clearMainRouter(mainAgentId: string): boolean {
  if (!routerActive(mainAgentId)) return false
  writeAgentCustomProvider(mainAgentId, null)
  const configPath = join(agentDir(mainAgentId), 'agent-config.json')
  const config = readJsonObjectForWrite(configPath)
  // the model was the router's (any router model, the list included): it goes with the router
  delete config.model
  delete config.customProviderContextTokens
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
  return true
}

// --- The router's own model list (owner decision Marveen 83042, Samu 83044) -------------------------------------
// GET {base}/v1/models, server side with the vault key (the key never reaches the browser), cached for 10 minutes
// (the endpoint is free, but the key has a daily limit). Kept: models that serve /v1/messages AND support tools.
// Order: the three measured Claude models first (written dashed, the ids our tables and the context guard know), then
// the non-Claude models, labelled experimental until a tool-call trial (credits, owner GO). Other Claude ids stay out
// until measured (Samu 83056).
// When the list cannot be fetched (no key, network, 4xx/5xx), the three measured Claude models, and the UI says so.

export interface RouterModelOption {
  /** The id written into the main agent's config. */
  id: string
  claude: boolean
  /** One of the three measured, dashed Claude ids. */
  measured: boolean
  /** Not a Claude model: no tool-call trial yet. */
  experimental: boolean
  /** The model's context window in tokens, when the router names it. */
  contextTokens: number | null
}
export interface RouterModelList { source: 'router' | 'fallback'; models: RouterModelOption[] }

const ROUTER_MODELS_TTL_MS = 10 * 60_000
const ROUTER_MODELS_TIMEOUT_MS = 8_000
let modelsCache: { at: number; list: RouterModelList } | null = null

/**
 * The context window Claude Code is told for a router model (CLAUDE_CODE_MAX_CONTEXT_TOKENS), Samu 83054. Claude Code
 * assumes 1M tokens for an id it does not know (measured, CC 2.1.330), and every non-Claude router model reports the
 * same 1048576, which is a default, not its real window. Saying too much makes the model fail BEFORE compaction, a
 * silent failure; saying too little only compacts earlier. So an experimental model gets min(context_length, 200k),
 * the context guard's own default for an unknown model, until a measurement (credits, owner GO) raises it here.
 */
export const EXPERIMENTAL_CONTEXT_CAP = 200_000
/**
 * The smallest window an experimental model may have (HOSTINGERROUTERFU1122, Geri N2). Claude Code's own prompt is
 * about 20k tokens, so a smaller reported window would compact on every turn; such a model is not offered.
 */
export const EXPERIMENTAL_CONTEXT_MIN = 32_000
/** Measured windows, model id -> tokens. Starts empty: a value here only after a measured trial. */
export const MEASURED_ROUTER_CONTEXT: Readonly<Record<string, number>> = {}

/** The window to pass for a model option; null when Claude Code's own table applies (a Claude model). */
export function routerContextTokens(o: Pick<RouterModelOption, 'id' | 'experimental' | 'contextTokens'>): number | null {
  if (!o.experimental) return null
  const measured = MEASURED_ROUTER_CONTEXT[o.id]
  if (measured) return measured
  if (!o.contextTokens || o.contextTokens < EXPERIMENTAL_CONTEXT_MIN) return null
  return Math.min(o.contextTokens, EXPERIMENTAL_CONTEXT_CAP)
}

/** An option can be chosen: a Claude model, or an experimental one whose window is known and at least the minimum. */
export function routerModelSelectable(o: RouterModelOption): boolean {
  return !o.experimental || routerContextTokens(o) !== null
}

/** The dashed form of a router id when it is one of the measured three (claude-sonnet-5.5 -> claude-sonnet-5-5). */
function measuredDashed(id: string): string | null {
  const dashed = id.replace(/(\d)\.(\d)/g, '$1-$2')
  return (HOSTINGER_ROUTER_MODELS as readonly string[]).includes(dashed) ? dashed : null
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Pure: the /v1/models response body -> the ordered options. Unparsable input gives an empty list. */
export function parseRouterModels(body: unknown): RouterModelOption[] {
  const rows = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : []
  const seen = new Set<string>()
  const out: RouterModelOption[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const m = r as Record<string, unknown>
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id || !/^[A-Za-z0-9._:/+-]{1,128}$/.test(id)) continue
    const endpoints = Array.isArray(m.supported_endpoints) ? m.supported_endpoints.map(String) : []
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.map(String) : []
    if (!endpoints.some((e) => e === '/v1/messages' || e.endsWith('/v1/messages'))) continue
    if (!params.includes('tools')) continue
    const dashed = measuredDashed(id)
    const claude = /^claude-/i.test(id)
    // Samu 83056: a Claude id that is not one of the measured three stays out until it is measured. Claude Code's
    // window override does not apply on its own to an unknown claude- id, so our 200k cap would not protect it.
    if (claude && dashed === null) continue
    const finalId = dashed ?? id
    if (seen.has(finalId)) continue
    seen.add(finalId)
    out.push({ id: finalId, claude, measured: dashed !== null, experimental: !claude, contextTokens: positiveInt(m.context_length) })
  }
  const rank = (o: RouterModelOption) => (o.measured ? 0 : o.claude ? 1 : 2)
  const measuredOrder = (o: RouterModelOption) => (HOSTINGER_ROUTER_MODELS as readonly string[]).indexOf(o.id)
  return out.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? measuredOrder(a) - measuredOrder(b) : a.id.localeCompare(b.id)))
}

/** The fallback: the three measured Claude models. */
export function fallbackRouterModels(): RouterModelList {
  return {
    source: 'fallback',
    models: HOSTINGER_ROUTER_MODELS.map((id) => ({ id, claude: true, measured: true, experimental: false, contextTokens: null })),
  }
}

/**
 * The router's model list, fetched with the stored key and cached for 10 minutes; the fallback when it cannot be
 * fetched. `fetchImpl` is the test seam. The key is only sent to the router, never returned.
 */
export async function routerModelList(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<RouterModelList> {
  if (modelsCache && now - modelsCache.at < ROUTER_MODELS_TTL_MS) return modelsCache.list
  let key = ''
  try { key = (getSecret(HOSTINGER_ROUTER_VAULT_KEY) ?? '').trim() } catch { key = '' }
  if (!key) return fallbackRouterModels()
  let list: RouterModelList
  try {
    const res = await fetchImpl(`${HOSTINGER_ROUTER_BASE_URL}/v1/models`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      redirect: 'error',
      signal: AbortSignal.timeout(ROUTER_MODELS_TIMEOUT_MS),
    })
    const models = res.ok ? parseRouterModels(await res.json()) : []
    list = models.length ? { source: 'router', models } : fallbackRouterModels()
  } catch {
    list = fallbackRouterModels()
  }
  // Only a real list is cached: a fallback is retried on the next request.
  if (list.source === 'router') modelsCache = { at: now, list }
  return list
}

/** Test seam, and after a key change: the next request fetches again. */
export function clearRouterModelCache(): void { modelsCache = null }
