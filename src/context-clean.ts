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
//
// v2 (kanban 5cdc0d14) adds two things on top of the token-triggered flow:
//   - A SECOND trigger source: an optional schedule (daily time or every-N-hours)
//     kicks off the same safe warn->save->signal->restart flow even when the
//     token threshold has not been reached. Kept as context-clean's OWN schedule
//     (not entangled with the legacy abrupt auto-restart loop) so the two watcher
//     loops can never both fire a restart on the same tick.
//   - STRUCTURED task-state resume: the agent persists what it was doing during
//     the save phase, and the runner auto-injects that as the first prompt after
//     the fresh restart so the agent continues exactly where it left off, without
//     waiting for a new instruction.

// Shared with the auto-restart module so the two schedules use one proven,
// unit-tested set of time helpers instead of a second parser. Imported for local
// use (normalize) and re-exported for the runner.
import { parseHHMM, dailyDueAtMs, restartDue } from './auto-restart.js'
export { parseHHMM, dailyDueAtMs, restartDue }

export interface ContextCleanConfig {
  /** Master toggle. When false the agent is never context-cleaned. */
  enabled: boolean
  /** Warn (and begin the flow) at/above this many context tokens. */
  softThreshold: number
  /** Force-restart fallback at/above this many tokens, unless a hold is active. */
  hardThreshold: number
  /** Max minutes to wait after warning before forcing the restart (grace cap). */
  graceMinutes: number
  /** Optional schedule trigger: warn daily at 'HH:MM' local, or null. */
  dailyTime: string | null
  /** Optional schedule trigger: warn every N hours, or null. dailyTime wins if
   *  both are somehow set, so the schedule stays unambiguous. */
  intervalHours: number | null
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
  dailyTime: null,
  intervalHours: null,
}
export const DEFAULT_CONTEXT_CLEAN_STANDARD: ContextCleanConfig = {
  enabled: true,
  softThreshold: 120_000,
  hardThreshold: 160_000,
  graceMinutes: 15,
  dailyTime: null,
  intervalHours: null,
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
  const dailyTime = parseHHMM(o.dailyTime) !== null ? (o.dailyTime as string).trim() : null
  let intervalHours: number | null = null
  if (typeof o.intervalHours === 'number' && Number.isFinite(o.intervalHours) && o.intervalHours > 0) {
    intervalHours = o.intervalHours
  }
  // dailyTime takes precedence: never keep both, so the schedule is unambiguous.
  if (dailyTime !== null) intervalHours = null
  return {
    enabled: o.enabled === true || (o.enabled === undefined && base.enabled),
    softThreshold: soft,
    hardThreshold: hard,
    graceMinutes: num(o.graceMinutes, base.graceMinutes),
    dailyTime,
    intervalHours,
  }
}

/** Per-agent phase, tracked in memory by the runner across ticks. */
export type ContextCleanPhase = 'idle' | 'warned'

/** What kicked off the flow. A TOKEN warn self-cancels if context drops back
 *  below soft and can be force-restarted at the hard threshold. The non-token
 *  triggers (a periodic SCHEDULE slot, or a TASK boundary -- an assigned kanban
 *  card reaching done) run regardless of context size, so they neither reset on
 *  low tokens nor use the hard-threshold force; they proceed via the ready signal
 *  or the grace cap. */
export type ContextCleanTrigger = 'token' | 'schedule' | 'task'

export interface ContextCleanState {
  phase: ContextCleanPhase
  /** When the warn prompt was injected (ms), or null while idle. */
  warnedAtMs: number | null
  /** Why we are in the warned phase (null while idle). */
  trigger: ContextCleanTrigger | null
}

export const INITIAL_STATE: ContextCleanState = { phase: 'idle', warnedAtMs: null, trigger: null }

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
 * the agent's signal, whether a schedule slot is due, and now, what should the
 * runner do?
 *
 * The runner layers ONE additional gate the pure function deliberately does not
 * model: pane-idle. A 'restart' must never cut a live turn, so the runner defers
 * a 'restart' to the next tick while the pane is busy. Readiness itself, though,
 * is the agent's explicit signal -- never inferred from idle.
 *
 * @param contextTokens     Current session context size (tokens), or null if unknown.
 * @param externalTriggerDue True when a non-token trigger (schedule slot or task
 *                           boundary) has come due this tick.
 */
export function decideContextClean(
  cfg: ContextCleanConfig,
  state: ContextCleanState,
  contextTokens: number | null,
  signal: RestartSignal,
  nowMs: number,
  externalTriggerDue = false,
): ContextCleanAction {
  if (!cfg.enabled) return 'none'

  if (state.phase === 'idle') {
    // Two entry-point kinds: cross the soft token threshold, OR a non-token
    // trigger (schedule slot / task boundary) is due. Token unknown (null) does
    // not block the external trigger.
    const tokenTrigger = contextTokens !== null && contextTokens >= cfg.softThreshold
    return (tokenTrigger || externalTriggerDue) ? 'warn' : 'none'
  }

  // phase === 'warned'.
  // A TOKEN-triggered flow self-cancels if the situation resolved (e.g. the agent
  // ran its own /clear and context dropped back below soft). A SCHEDULE-triggered
  // flow must NOT reset on low tokens -- a periodic clean is meant to run even
  // when the context is small; it proceeds via the ready signal or the grace cap.
  if (state.trigger === 'token' && contextTokens !== null && contextTokens < cfg.softThreshold) {
    return 'reset'
  }

  // Highest priority: the agent explicitly cleared itself for restart.
  if (signal.ready) return 'restart'

  // Grace cap: waited long enough -> force regardless of hold. This is the
  // anti-indefinite-hold backstop (and the sole force path for a schedule flow).
  const graceMs = cfg.graceMinutes * 60_000
  if (state.warnedAtMs !== null && (nowMs - state.warnedAtMs) >= graceMs) return 'restart'

  // Hard threshold (token flow only): context grew past the ceiling and the agent
  // is NOT actively holding a critical step -> force. An active hold still defers
  // (until grace).
  if (state.trigger === 'token' && contextTokens !== null && contextTokens >= cfg.hardThreshold && !signal.hold) {
    return 'restart'
  }

  // Otherwise keep waiting for the agent to save + signal.
  return 'wait'
}

// ---- structured task-state resume ----------------------------------------
//
// The agent writes this during the save phase so the runner can auto-inject it
// as the first prompt after the fresh restart. This is deliberately MORE than
// the free-form hot-memory / HANDOFF note: it is structured and reloaded
// automatically, so the agent continues exactly where it left off without anyone
// re-asking. All fields are optional strings/arrays; a resume with no active task
// is treated as absent (nothing to inject).

export interface ResumeState {
  /** The one task the agent was actively working on. */
  activeTask: string
  /** Where in that task it was (which step / phase). */
  currentStep: string
  /** Files / paths / branches that are relevant to resuming. */
  relevantFiles: string[]
  /** The concrete next action to take on resume. */
  nextAction: string
  /** Any extra context worth carrying across the restart. */
  notes: string
}

/**
 * Coerce a parsed resume file into a safe ResumeState, or null if it carries no
 * usable content (no active task and no next action -> nothing to resume).
 */
export function normalizeResumeState(raw: unknown): ResumeState | null {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(x => str(x)).filter(Boolean) : (str(v) ? [str(v)] : [])
  const rs: ResumeState = {
    activeTask: str(o.activeTask ?? o.active_task),
    currentStep: str(o.currentStep ?? o.current_step),
    relevantFiles: arr(o.relevantFiles ?? o.relevant_files),
    nextAction: str(o.nextAction ?? o.next_action),
    notes: str(o.notes),
  }
  if (!rs.activeTask && !rs.nextAction) return null
  return rs
}

/**
 * Render a resume state into the prompt injected as the agent's first turn after
 * a fresh restart. It must read as a self-contained instruction to continue, not
 * a question -- the whole point is that the agent resumes without being asked.
 */
export function formatResumePrompt(rs: ResumeState): string {
  const lines = [
    `[CONTEXT-CLEAN auto-resume] A kontextusod tisztitva lett (fresh restart). A korabbi munkadat FOLYTASD onnan ahol abbahagytad -- ne varj uj utasitasra.`,
    ``,
    `Aktiv feladat: ${rs.activeTask || '(nincs megadva)'}`,
  ]
  if (rs.currentStep) lines.push(`Hol tartottal: ${rs.currentStep}`)
  if (rs.relevantFiles.length) lines.push(`Relevans fajlok/branch: ${rs.relevantFiles.join(', ')}`)
  if (rs.nextAction) lines.push(`Kovetkezo lepes: ${rs.nextAction}`)
  if (rs.notes) lines.push(`Megjegyzes: ${rs.notes}`)
  lines.push(``, `Folytasd a kovetkezo lepessel.`)
  return lines.join('\n')
}
