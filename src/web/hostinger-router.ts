// HOSTINGERROUTER1122: the Hostinger AI Router as an optional provider for the MAIN agent, offered only on a Hostinger
// install and never the default (owner's condition). The router speaks the Anthropic Messages API (measured live,
// 2026-11-22: streaming, tool_use and several turns, with x-api-key), so it rides the existing customProvider path:
// a provider record, a vault key, and the main agent's customProvider + model fields. One write path (Samu 83036):
// the main-agent auth switch (main-auth-switch.ts) and the onboarding's claude-auth step both call applyMainRouter.
//
// Only the main agent: a sub-agent keeps running on the Claude subscription (or its own setup), and the wizard says so.
import { readFileSync } from 'node:fs'
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
export function resolveRouterModel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return HOSTINGER_ROUTER_DEFAULT_MODEL
  return typeof raw === 'string' && (HOSTINGER_ROUTER_MODELS as readonly string[]).includes(raw) ? raw : null
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
  const m = readAgentModel(mainAgentId)
  return resolveRouterModel(m) ? m : null
}

/**
 * Point the main agent at the router: the key (when a new one is given) into the vault, the provider record, and the
 * main agent's customProvider + model. The caller has checked the key, the model and who may do it.
 */
export function applyMainRouter(mainAgentId: string, newKey: string | null, model: string): void {
  if (newKey) setSecret(HOSTINGER_ROUTER_VAULT_KEY, 'Hostinger AI Router key (main agent)', newKey.trim())
  saveCustomProvider({
    id: HOSTINGER_ROUTER_PROVIDER_ID,
    label: 'Hostinger AI Router',
    baseUrl: HOSTINGER_ROUTER_BASE_URL,
    authHeader: 'x-api-key',
    vaultKey: HOSTINGER_ROUTER_VAULT_KEY,
  })
  writeAgentModel(mainAgentId, model)
  writeAgentCustomProvider(mainAgentId, HOSTINGER_ROUTER_PROVIDER_ID)
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
  if (typeof config.model === 'string' && (HOSTINGER_ROUTER_MODELS as readonly string[]).includes(config.model)) {
    delete config.model
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
  }
  return true
}
