// MAINAUTHSWITCH1107 (APIKULCSINDITAS1004 D): the dashboard switch on the main agent card. The main agent's PUT stays
// read-only for everything else; only authMode (shared | api | router) with apiKey and model open, for the owner, with
// the refusals the launch-time decision (main-auth.ts) would otherwise turn into a silent fallback.
//
// HOSTINGERROUTER1122 (Samu 83036): "router" is the Hostinger AI Router, offered only on a Hostinger install. It is the
// one write path for it: the onboarding's claude-auth step checks the same key and model rules (hostinger-router.ts).
//
// Pure on purpose: the route (routes/agents.ts) gathers the facts and does the I/O; what is allowed is decided here,
// where it is under test.
import { checkRouterKey, resolveRouterModel } from './hostinger-router.js'

export const MAIN_AUTH_SWITCH_FIELDS = ['authMode', 'apiKey', 'model'] as const

export type MainAuthSwitchFacts = {
  /** MAIN_AGENT_CONFIG_DIR with its own login (resolveMainAgentConfigDir). */
  explicitConfigDir: boolean
  /** A rotated claude-plans entry with its own config dir is active for the main agent. */
  rotatedConfigDir: boolean
  /** A token-mode rotated plan is active for the main agent. */
  rotatedTokenPlan: boolean
  /** A custom provider OTHER than the Hostinger AI Router is set (the router itself is switched by this switch). */
  customProvider: boolean
  /** A key the main agent could run on already exists (vault agent-<main>-api-key, or .env). */
  keyAvailable: boolean
  /** This is a Hostinger install (store/.platform), so the router may be chosen. */
  routerAvailable?: boolean
  /** A router key is already in the vault. */
  routerKeyAvailable?: boolean
  /** The selectable ids of the router's own model list (cached); the three measured ones are always allowed. */
  routerModels?: readonly string[]
}

export type MainAuthSwitchVerdict =
  | { ok: true; mode: 'shared' | 'api' | 'router'; newKey: string | null; model?: string }
  | { ok: false; status: 400 | 409; code: string; error: string }

const KEY_MIN = 20
const KEY_MAX = 512

/** What the switch may do with this body, given the main agent's current setup. */
export function checkMainAuthSwitch(body: unknown, f: MainAuthSwitchFacts): MainAuthSwitchVerdict {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'bad-body', error: 'Request body must be a JSON object.' }
  }
  const b = body as Record<string, unknown>
  const extra = Object.keys(b).filter((k) => !(MAIN_AUTH_SWITCH_FIELDS as readonly string[]).includes(k))
  if (extra.length) {
    return { ok: false, status: 400, code: 'read-only', error: `Main agent configuration is read-only through the dashboard API, except authMode, apiKey and model (rejected: ${extra.join(', ')})` }
  }
  const mode = b.authMode
  if (mode === 'own_team') return { ok: false, status: 409, code: 'own-team', error: 'own_team is not available for the main agent' }
  if (mode !== 'shared' && mode !== 'api' && mode !== 'router') return { ok: false, status: 400, code: 'bad-mode', error: 'authMode must be "shared", "api" or "router"' }
  if (b.model !== undefined && mode !== 'router') return { ok: false, status: 400, code: 'model-without-router', error: 'model is only accepted with authMode "router"' }
  const hasKey = b.apiKey !== undefined && b.apiKey !== null && b.apiKey !== ''
  if (hasKey && mode === 'shared') return { ok: false, status: 400, code: 'key-without-api', error: 'apiKey is only accepted with authMode "api" or "router"' }
  if (hasKey && typeof b.apiKey !== 'string') return { ok: false, status: 400, code: 'bad-key', error: 'apiKey must be a string' }
  const k = hasKey ? (b.apiKey as string).trim() : ''
  // The same conflicts main-auth.ts resolves to the non-billing side at launch: refused here, so the owner never sees
  // a key-billed mode saved while the pane keeps running on something else.
  const precedence = (): MainAuthSwitchVerdict | null => {
    if (f.explicitConfigDir) return { ok: false, status: 409, code: 'own-login', error: 'The main agent has its own Claude login (MAIN_AGENT_CONFIG_DIR), which takes precedence. Remove it first.' }
    if (f.rotatedConfigDir || f.rotatedTokenPlan) return { ok: false, status: 409, code: 'rotated-plan', error: 'A rotated Claude plan is active for the main agent, which takes precedence. Switch the plan off first.' }
    if (f.customProvider) return { ok: false, status: 409, code: 'custom-provider', error: 'The main agent runs on a custom provider, which carries its own key. Remove the provider first.' }
    return null
  }
  if (mode === 'router') {
    if (!f.routerAvailable) return { ok: false, status: 409, code: 'router-unavailable', error: 'The Hostinger AI Router is offered only on a Hostinger install.' }
    const refused = precedence()
    if (refused) return refused
    if (hasKey) {
      const bad = checkRouterKey(k)
      if (bad) return { ok: false, status: 400, code: 'bad-key', error: bad }
    } else if (!f.routerKeyAvailable) {
      return { ok: false, status: 400, code: 'no-key', error: 'No Hostinger AI Router key is stored: paste one.' }
    }
    const model = resolveRouterModel(b.model, f.routerModels ?? [])
    if (!model) return { ok: false, status: 400, code: 'bad-model', error: 'model must be one of the Hostinger AI Router models offered.' }
    return { ok: true, mode, newKey: hasKey ? k : null, model }
  }
  let newKey: string | null = null
  if (hasKey) {
    if (k.length < KEY_MIN || k.length > KEY_MAX || /\s/.test(k)) {
      return { ok: false, status: 400, code: 'bad-key', error: 'apiKey does not look like a key (no spaces, 20 to 512 characters)' }
    }
    newKey = k
  }
  if (mode === 'api') {
    const refused = precedence()
    if (refused) return refused
    if (!newKey && !f.keyAvailable) return { ok: false, status: 400, code: 'no-key', error: 'No API key is stored for the main agent: paste one.' }
  }
  return { ok: true, mode, newKey }
}
