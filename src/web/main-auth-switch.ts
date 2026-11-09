// MAINAUTHSWITCH1107 (APIKULCSINDITAS1004 D): the dashboard switch on the main agent card. The main agent's PUT stays
// read-only for everything else; only authMode (shared | api) and apiKey open, for the owner, with the refusals the
// launch-time decision (main-auth.ts) would otherwise turn into a silent fallback.
//
// Pure on purpose: the route (routes/agents.ts) gathers the facts and does the I/O; what is allowed is decided here,
// where it is under test.

export const MAIN_AUTH_SWITCH_FIELDS = ['authMode', 'apiKey'] as const

export type MainAuthSwitchFacts = {
  /** MAIN_AGENT_CONFIG_DIR with its own login (resolveMainAgentConfigDir). */
  explicitConfigDir: boolean
  /** A rotated claude-plans entry with its own config dir is active for the main agent. */
  rotatedConfigDir: boolean
  /** A token-mode rotated plan is active for the main agent. */
  rotatedTokenPlan: boolean
  customProvider: boolean
  /** A key the main agent could run on already exists (vault agent-<main>-api-key, or .env). */
  keyAvailable: boolean
}

export type MainAuthSwitchVerdict =
  | { ok: true; mode: 'shared' | 'api'; newKey: string | null }
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
    return { ok: false, status: 400, code: 'read-only', error: `Main agent configuration is read-only through the dashboard API, except authMode and apiKey (rejected: ${extra.join(', ')})` }
  }
  const mode = b.authMode
  if (mode === 'own_team') return { ok: false, status: 409, code: 'own-team', error: 'own_team is not available for the main agent' }
  if (mode !== 'shared' && mode !== 'api') return { ok: false, status: 400, code: 'bad-mode', error: 'authMode must be "shared" or "api"' }
  let newKey: string | null = null
  if (b.apiKey !== undefined && b.apiKey !== null && b.apiKey !== '') {
    if (mode !== 'api') return { ok: false, status: 400, code: 'key-without-api', error: 'apiKey is only accepted with authMode "api"' }
    if (typeof b.apiKey !== 'string') return { ok: false, status: 400, code: 'bad-key', error: 'apiKey must be a string' }
    const k = b.apiKey.trim()
    if (k.length < KEY_MIN || k.length > KEY_MAX || /\s/.test(k)) {
      return { ok: false, status: 400, code: 'bad-key', error: 'apiKey does not look like a key (no spaces, 20 to 512 characters)' }
    }
    newKey = k
  }
  if (mode === 'api') {
    // The same conflicts main-auth.ts resolves to the non-billing side at launch: refused here, so the owner never
    // sees "API key" saved while the pane keeps running on something else.
    if (f.explicitConfigDir) return { ok: false, status: 409, code: 'own-login', error: 'The main agent has its own Claude login (MAIN_AGENT_CONFIG_DIR), which takes precedence over an API key. Remove it first.' }
    if (f.rotatedConfigDir || f.rotatedTokenPlan) return { ok: false, status: 409, code: 'rotated-plan', error: 'A rotated Claude plan is active for the main agent, which takes precedence over an API key. Switch the plan off first.' }
    if (f.customProvider) return { ok: false, status: 409, code: 'custom-provider', error: 'The main agent runs on a custom provider, which carries its own key. Remove the provider first.' }
    if (!newKey && !f.keyAvailable) return { ok: false, status: 400, code: 'no-key', error: 'No API key is stored for the main agent: paste one.' }
  }
  return { ok: true, mode, newKey }
}
