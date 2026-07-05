// Pure logic for the context-clean feature.
//
// A long-lived Claude Code session accumulates context: every turn re-reads the
// whole transcript, so a big context is slower, costlier and hits the per-session
// limit sooner. The auto-restart feature (src/auto-restart.ts) cycles sessions on
// a *schedule*; context-clean instead reacts to *size*: when an agent's live
// context grows past a soft threshold, the system cleans it -- but NEVER out of
// the blue. The requirement (Norbi, kanban bc45f27c) is a safe, signalled flow:
//
//   1. WARN the agent first (a prompt injected into its session) so it knows a
//      clean is coming and can persist what matters (memory, hot task state,
//      daily log).
//   2. The agent SAVES on its own terms.
//   3. The agent gives an EXPLICIT "safe-to-restart" signal -- the runner must
//      NOT infer readiness from an idle pane. The agent may also HOLD if it is
//      mid-critical-step (e.g. a multi-step git operation), and the clean waits.
//   4. Fallbacks so a silent or indefinitely-holding agent still gets cleaned:
//      a grace cap (force after N minutes) and a hard threshold (force once the
//      context grows past it, provided no hold is active).
//
// Only after that does a *fresh* restart (conversation dropped -- the actual
// clean) happen.
//
// This module is dependency-free so the state-machine decision is unit-testable
// without a clock, tmux, or the filesystem. The I/O (reading context tokens,
// injecting the warn prompt, reading the ready/hold signal, performing the
// restart) lives in src/web/context-clean-runner.ts.

export interface ContextCleanConfig {
  /** Master toggle. When false the agent is never context-cleaned. */
  enabled: boolean
  /** Warn (and begin the flow) at/above this many context tokens. */
  softThreshold: number
  /** Force-restart fallback at/above this many tokens, unless a hold is active. */
  hardThreshold: number
  /** Max minutes to wait after warning before forcing the restart (grace cap). */
  graceMinutes: number
}

// Thresholds are model-aware, NOT one global number. A model exposing a ~1M
// context window (the [1m] marker in its id) can safely accumulate far more
// before our deliberate clean should pre-empt the harness's own auto-compaction.
// A standard ~200k-window model (e.g. Sonnet without [1m]) would auto-compact
// near its real limit long before a 400k/500k threshold ever fired, so its
// clean must land at a proportionally lower point -- BEFORE native compaction,
// so our SIGNALLED clean wins over the harness's silent one, not the reverse.
export const DEFAULT_CONTEXT_CLEAN_LARGE: ContextCleanConfig = {
  enabled: true,
  softThreshold: 400_000,
  hardThreshold: 500_000,
  graceMinutes: 15,
}
export const DEFAULT_CONTEXT_CLEAN_STANDARD: ContextCleanConfig = {
  enabled: true,
  softThreshold: 120_000,
  hardThreshold: 160_000,
  graceMinutes: 15,
}

// Backwards-compatible alias: the large-window profile is the base for field-
// level fallbacks when normalizing a partial config with no explicit base.
export const DEFAULT_CONTEXT_CLEAN: ContextCleanConfig = DEFAULT_CONTEXT_CLEAN_LARGE

/** A model exposes the ~1M-token window when its resolved id carries [1m]. */
export function isLargeContextModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.includes('[1m]')
}

/** The out-of-the-box config for an agent, picked by its model's context window. */
export function defaultContextCleanForModel(model: string | null | undefined): ContextCleanConfig {
  return isLargeContextModel(model)
    ? { ...DEFAULT_CONTEXT_CLEAN_LARGE }
    : { ...DEFAULT_CONTEXT_CLEAN_STANDARD }
}

/**
 * Coerce arbitrary parsed JSON into a safe, fully-populated config. Unknown /
 * malformed fields fall back to `base` (the model-appropriate default), and the
 * invariant soft <= hard is repaired so a hand-edited store can never produce a
 * nonsensical schedule.
 */
export function normalizeContextCleanConfig(
  raw: unknown,
  base: ContextCleanConfig = DEFAULT_CONTEXT_CLEAN,
): ContextCleanConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const num = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : fallback
  const soft = num(o.softThreshold, base.softThreshold)
  let hard = num(o.hardThreshold, base.hardThreshold)
  // Hard must sit at or above soft, else the hard fallback would fire before the
  // agent is ever warned. Repair by lifting hard to soft.
  if (hard < soft) hard = soft
  return {
    enabled: o.enabled === true || (o.enabled === undefined && base.enabled),
    softThreshold: soft,
    hardThreshold: hard,
    graceMinutes: num(o.graceMinutes, base.graceMinutes),
  }
}

/** Per-agent phase, tracked in memory by the runner across ticks. */
export type ContextCleanPhase = 'idle' | 'warned'

export interface ContextCleanState {
  phase: ContextCleanPhase
  /** When the warn prompt was injected (ms), or null while idle. */
  warnedAtMs: number | null
}

export const INITIAL_STATE: ContextCleanState = { phase: 'idle', warnedAtMs: null }

/**
 * The agent-written signal, read from the signal file each tick. Absent /
 * malformed file -> both false (no explicit readiness, no hold).
 */
export interface RestartSignal {
  hold: boolean
  ready: boolean
}

export const NO_SIGNAL: RestartSignal = { hold: false, ready: false }

/** Parse the signal file's JSON into a safe RestartSignal. */
export function normalizeSignal(raw: unknown): RestartSignal {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return { hold: o.hold === true, ready: o.ready === true }
}

export type ContextCleanAction =
  | 'none'     // nothing to do; stay idle
  | 'warn'     // cross soft threshold: inject warn, enter 'warned'
  | 'wait'     // warned, but still waiting for the agent to save + signal
  | 'restart'  // proceed with the fresh restart (runner still gates on pane-idle)
  | 'reset'    // warned but context fell back below soft: abandon the flow

/**
 * Pure decision: given the current context size, the tracked per-agent state,
 * the agent's signal, and now, what should the runner do?
 *
 * The runner layers ONE additional gate the pure function deliberately does not
 * model: pane-idle. A 'restart' must never cut a live turn, so the runner defers
 * a 'restart' to the next tick while the pane is busy. Readiness itself, though,
 * is the agent's explicit signal -- never inferred from idle.
 *
 * @param contextTokens  Current session context size (tokens), or null if unknown.
 */
export function decideContextClean(
  cfg: ContextCleanConfig,
  state: ContextCleanState,
  contextTokens: number | null,
  signal: RestartSignal,
  nowMs: number,
): ContextCleanAction {
  if (!cfg.enabled) return 'none'
  if (contextTokens === null) return 'none'

  if (state.phase === 'idle') {
    // Begin the flow only when we cross the soft threshold.
    return contextTokens >= cfg.softThreshold ? 'warn' : 'none'
  }

  // phase === 'warned'.
  // The situation resolved itself (e.g. the agent ran its own /clear): the
  // context dropped back below soft, so abandon the flow.
  if (contextTokens < cfg.softThreshold) return 'reset'

  // Highest priority: the agent explicitly cleared itself for restart.
  if (signal.ready) return 'restart'

  // Grace cap: waited long enough -> force regardless of hold. This is the
  // anti-indefinite-hold backstop.
  const graceMs = cfg.graceMinutes * 60_000
  if (state.warnedAtMs !== null && (nowMs - state.warnedAtMs) >= graceMs) return 'restart'

  // Hard threshold: context grew past the ceiling and the agent is NOT actively
  // holding a critical step -> force. An active hold still defers (until grace).
  if (contextTokens >= cfg.hardThreshold && !signal.hold) return 'restart'

  // Otherwise keep waiting for the agent to save + signal.
  return 'wait'
}
