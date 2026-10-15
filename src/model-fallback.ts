// Pure logic for the model-fallback-on-limit feature.
//
// Motivation: when an agent's Claude plan usage limit is reached, the Claude
// Code session pauses and prints a usage-limit banner in its tmux pane. Until
// the window resets (or the user intervenes) the agent is deaf. This feature
// detects that banner and downgrades the agent one step down a configured model
// chain (e.g. opus -> sonnet -> haiku), respawning the session so the cheaper
// model -- on a separate budget -- takes over without losing the conversation.
// After a revert window with no limit in sight, it climbs back to the primary.
//
// This module is dependency-free so every decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (capture-pane, model write, restart)
// lives in src/web/model-fallback-runner.ts; the config store lives in
// src/web/model-fallback-store.ts.

// Resolved full model IDs, mirroring MODEL_ALIASES in src/web/agent-config.ts.
// chain[0] is the primary (what we revert UP to); each subsequent entry is the
// next downgrade target. Kept as literals here to preserve the zero-import,
// trivially-testable property of this module.
export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

// Revert only well after the typical 5-hour plan window so we do not climb back
// to the primary just to re-trip the same limit. Configurable.
export const DEFAULT_REVERT_AFTER_MINUTES = 330

export interface ModelFallbackConfig {
  /** Master toggle. When false no agent is ever auto-switched. */
  enabled: boolean
  /** Primary-first model chain. Downgrades walk forward; revert goes to [0]. */
  chain: string[]
  /** Minutes a downgraded agent must stay limit-free before climbing back. */
  revertAfterMinutes: number
}

export const DEFAULT_MODEL_FALLBACK: ModelFallbackConfig = {
  enabled: false,
  chain: [...DEFAULT_MODEL_CHAIN],
  revertAfterMinutes: DEFAULT_REVERT_AFTER_MINUTES,
}

/** Coerce an untrusted parsed-JSON value into a valid config (defaults on junk). */
export function normalizeModelFallbackConfig(raw: unknown): ModelFallbackConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const enabled = o.enabled === true
  let chain = DEFAULT_MODEL_FALLBACK.chain
  if (Array.isArray(o.chain)) {
    const cleaned = o.chain.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    // A chain needs at least a primary + one fallback to be meaningful.
    if (cleaned.length >= 2) chain = cleaned
  }
  let revertAfterMinutes = DEFAULT_MODEL_FALLBACK.revertAfterMinutes
  if (typeof o.revertAfterMinutes === 'number' && Number.isFinite(o.revertAfterMinutes) && o.revertAfterMinutes > 0) {
    revertAfterMinutes = Math.floor(o.revertAfterMinutes)
  }
  return { enabled, chain, revertAfterMinutes }
}

// The Claude Code usage-limit banner appears at the bottom of the pane (above
// the footer) when the plan budget is exhausted or nearly so. Match only the
// live banner region so a message body or scrollback that merely quotes the
// phrase does not trip a downgrade.
const USAGE_LIMIT_BANNER_REGION_LINES = 15

// Distinctive plan-limit phrasings. Deliberately NARROW: a generic "rate limit"
// / "API Error: 429" (transient overload, handled elsewhere) must NOT match --
// that is a momentary blip, not a plan-budget exhaustion that warrants a model
// switch.
// KET MERES UNIOJA, egyik oldal sem hagyhato el:
//  - "session limit" alak, elesben merve 2026-08-08: "You hit your session limit · resets 5:50pm"
//  - heti/session alakok, merve 2026-08-18: a "reached your weekly limit" es a
//    "Session limit reached" panelnel a detektor nema maradt -- ez az az eset, aminek kiesés az ara.
// A rebase (2026-08-19) elott a ket ag KULON-KULON javitotta ezt a regexet, es a sajat aganak
// `hit ... limit` resze epp a masik meresét (session) ejtette volna ki. Ezert unio, nem valasztas.
const USAGE_LIMIT_RX =
  /(usage limit reached|reached your (?:usage|weekly) limit|hit (?:your|the) (?:session|usage) limit|approaching (?:your )?(?:\w+ )?(?:usage|weekly) limit|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached|(?:weekly|session) limit reached|upgrade to increase your usage limit)/i

// The exhausted-extra-usage reply. Measured on the live install: the main
// session answered 2798 turns with exactly this synthetic API-error message
// between 2026-09-20T02:19Z and 2026-09-21T03:59Z (transcript records with
// isApiErrorMessage=true, error="rate_limit", apiErrorStatus=429), and
// USAGE_LIMIT_RX matched none of them. Observed wordings, verbatim:
//   "You're out of extra usage · resets 6am (Europe/Budapest)"            (2609)
//   "You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)"    (189)
// The phrase itself is easy to quote in ordinary conversation (an agent
// reporting this very bug writes it), so the match is anchored to the banner
// SHAPE: the phrase opens its own line (after indentation and the "⎿" / "●"
// glyph Claude Code draws before an API-error reply) and the line either ends
// there or continues only with the "· resets ..." tail. A sentence that merely
// mentions it mid-line, or continues past it ("..., so the heartbeat ..."),
// does not match. Kept separate from USAGE_LIMIT_RX because it needs the
// multiline flag, and the older alternatives must keep matching mid-line.
const EXTRA_USAGE_EXHAUSTED_RX =
  /^[\s⎿●>]*you(?:['’]re| are) out of extra usage[ \t]*(?:[·∙•][^\n]*)?$/im

/**
 * True when the live pane shows a Claude *plan usage-limit* banner (not a
 * transient API 429). Pure + dependency-free. Restricted to the bottom region
 * so quoted text in scrollback or a reply body cannot trigger it.
 */
export function detectsUsageLimit(pane: string): boolean {
  return usageLimitBannerLine(pane) !== null
}

/**
 * The banner line detectsUsageLimit() matched, trimmed and stripped of the
 * leading pane glyphs (e.g. "You're out of extra usage · resets 6am
 * (Europe/Budapest)"), or null when there is none. Lets a caller key a limit
 * episode by its wording and read the reset tail without re-deriving the
 * match. Same live-region restriction as detectsUsageLimit.
 */
export function usageLimitBannerLine(pane: string): string | null {
  if (!pane || !pane.trim()) return null
  const lines = pane.split('\n').slice(-USAGE_LIMIT_BANNER_REGION_LINES)
  // Bottom-up: the newest banner is the one that describes the live state.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // Each regex is tested on a single line here. USAGE_LIMIT_RX has no
    // multi-line alternative, and EXTRA_USAGE_EXHAUSTED_RX is line-anchored,
    // so this is the same verdict the old whole-region test gave.
    if (USAGE_LIMIT_RX.test(line) || EXTRA_USAGE_EXHAUSTED_RX.test(line)) {
      return line.replace(/^[\s⎿●>]+/, '').trim()
    }
  }
  return null
}

/**
 * The next model one step down the chain from `current`, or null if already at
 * the bottom. An unrecognised current model is treated as the primary, so the
 * first downgrade target (chain[1]) applies.
 */
export function nextFallbackModel(current: string, chain: string[]): string | null {
  if (chain.length < 2) return null
  const idx = chain.indexOf(current)
  if (idx < 0) return chain[1] ?? null
  if (idx >= chain.length - 1) return null
  return chain[idx + 1]
}

export interface ModelFallbackFacts {
  /** Whether the agent's pane currently shows a usage-limit banner. */
  limitDetected: boolean
  /** The agent's current resolved model id. */
  currentModel: string
  /** Primary-first model chain. */
  chain: string[]
  /** When this agent was last downgraded (ms epoch), or null if on primary. */
  downgradedAt: number | null
  /** Current time (ms epoch). */
  now: number
  /** Revert window in ms. */
  revertAfterMs: number
}

export type ModelAction =
  | { kind: 'none' }
  | { kind: 'downgrade'; model: string }
  | { kind: 'revert'; model: string }

/**
 * Decide what to do for one agent. Pure: the runner gates the I/O (idle pane,
 * actual write+restart) separately.
 *
 *   - limit detected & a lower model exists -> downgrade to it.
 *   - limit detected & already at the bottom -> nothing inside the revert
 *     window; past it, revert anyway (a stale --continue banner must not pin it).
 *   - no limit & downgraded long enough ago -> revert to the primary (chain[0]).
 *   - otherwise -> nothing.
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  if (f.limitDetected) {
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) return { kind: 'downgrade', model: next }
    // At the bottom of the chain (FALLBACKSTUCK924): a limit
    // banner here must not block the revert forever. After a downgrade the
    // session restarts with --continue, so on an idle pane the OLD banner can
    // sit in the bottom region indefinitely and the agent never gets back to
    // the primary. Past the revert window, try the primary anyway: if the
    // limit is real, the next sweep sees the banner on the primary and
    // downgrades again -- at most one retry per window, never a pinned fleet.
    if (f.downgradedAt === null || f.now - f.downgradedAt < f.revertAfterMs) return { kind: 'none' }
  }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const primary = f.chain[0]
    if (primary && f.currentModel !== primary) return { kind: 'revert', model: primary }
  }
  return { kind: 'none' }
}
