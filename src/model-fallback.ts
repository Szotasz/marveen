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
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

// Revert only well after the typical 5-hour plan window so we do not climb back
// to the primary just to re-trip the same limit. Configurable.
export const DEFAULT_REVERT_AFTER_MINUTES = Number(process.env['DEFAULT_REVERT_AFTER_MINUTES']) || 330

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
// "session limit" variant observed in production (2026-08-08):
//   "You hit your session limit · resets 5:50pm"
// The original regex only covered "usage limit"; "session" was missing.
const USAGE_LIMIT_RX =
  /(usage limit reached|reached your usage limit|hit (?:your|the) (?:session|usage) limit|approaching (?:your )?usage limit|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached|upgrade to increase your usage limit)/i

/**
 * True when the live pane shows a Claude *plan usage-limit* banner (not a
 * transient API 429). Pure + dependency-free. Restricted to the bottom region
 * so quoted text in scrollback or a reply body cannot trigger it.
 */
export function detectsUsageLimit(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  const lines = pane.split('\n')
  const region = lines.slice(-USAGE_LIMIT_BANNER_REGION_LINES).join('\n')
  return USAGE_LIMIT_RX.test(region)
}

// Claude Code shows this message when the configured model is no longer
// available (retired or removed). Unlike a usage-limit banner it does NOT
// self-clear after a window reset: only a model switch fixes it.
const MODEL_UNAVAILABLE_RX =
  /There['‘’]s an issue with the selected model|Run \/model to pick a different model/i
const MODEL_UNAVAILABLE_REGION_LINES = 15

// Matches Claude Code’s input box borders (used to locate the live region).
const BOX_BORDER_RX = /─{10,}/

/**
 * The Claude Code live status region: the status line directly above the upper
 * box border (top-1), plus the hint lines below the lower box border.
 * The box interior (where user input and inter-agent messages live) is
 * intentionally excluded -- Claude Code never writes its own model-unavailable
 * errors there, and a quoted message could persist across many sweeps and cause
 * a false positive that box-interior exclusion prevents.
 * Returns null when the pane has no recognisable input box (headless / crashed).
 */
function liveStatusRegionOf(pane: string): string | null {
  const lines = pane.split('\n')
  const borders: number[] = []
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) {
    if (BOX_BORDER_RX.test(lines[i])) borders.push(i)
  }
  if (borders.length < 2) return null
  // borders[0] = lower border (larger index), borders[1] = upper border (smaller index)
  const lower = borders[0]
  const upper = borders[1]
  const statusLine = upper >= 1 ? [lines[upper - 1]] : []
  const belowBox = lines.slice(lower + 1)
  return [...statusLine, ...belowBox].join('\n')
}

/**
 * True when the live pane shows a "model unavailable" error (retired / removed
 * model ID). Pure + dependency-free.
 *
 * When the pane has a Claude Code input box, only the status line (directly
 * above the upper border) and the hint lines below the lower border are
 * examined. The box interior is excluded to prevent false-positives from quoted
 * inter-agent messages that mention the error phrase. When no box is present
 * (headless or crashed pane), falls back to the bottom 15 lines.
 *
 * This is NOT a usage-limit event -- it does not self-clear. The correct
 * response is to change the model, then restart. Callers must NOT trigger a
 * bare respawn without first updating the model config.
 */
export function detectsModelUnavailable(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  const region = liveStatusRegionOf(pane)
    ?? pane.split('\n').slice(-MODEL_UNAVAILABLE_REGION_LINES).join('\n')
  return MODEL_UNAVAILABLE_RX.test(region)
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
 *   - limit detected & already at the bottom -> nothing (cannot go lower).
 *   - no limit & downgraded long enough ago -> revert to the primary (chain[0]).
 *   - otherwise -> nothing.
 */
export function decideModelAction(f: ModelFallbackFacts): ModelAction {
  if (f.limitDetected) {
    const next = nextFallbackModel(f.currentModel, f.chain)
    if (next && next !== f.currentModel) return { kind: 'downgrade', model: next }
    return { kind: 'none' }
  }
  if (f.downgradedAt !== null && f.now - f.downgradedAt >= f.revertAfterMs) {
    const primary = f.chain[0]
    if (primary && f.currentModel !== primary) return { kind: 'revert', model: primary }
  }
  return { kind: 'none' }
}
