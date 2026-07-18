// Pure logic for the fleet-wide context guard (kanban #81).
//
// A Claude Code session that grows past its context window STALLS: near the
// limit the auto-compact request must ship the ENTIRE context (its most
// failure-prone request -- observed socket errors), the TUI parks behind
// "Resume from summary"/error banners, and nothing external notices. Three
// agents wedged this way on a single day (2026-07-09). The guard acts BEFORE
// that zone: at actPct it asks the agent to write a HANDOFF.md, then performs a
// FRESH restart and injects a resume prompt pointing at the handoff, so the
// agent continues on its own. At hardPct (or when the handoff never appears)
// it force-restarts anyway -- taskstate + kanban + hot memories are the
// fallback context.
//
// On top of the (opt-in) proactive tiers sits an ALWAYS-ON saturation net:
// once a pane reads "100% context used", prompt dispatch refuses it and the
// in-TUI auto-compact -- which only runs when a new turn starts -- can never
// fire, so without external action the agent is wedged forever (samu,
// 2026-07-18). The net fresh-restarts such a pane after a confirmation sweep.
//
// This module is dependency-free (no clock, tmux, or fs) so the state machine
// is unit-testable. The I/O lives in src/web/context-guard-runner.ts.

export interface ContextGuardConfig {
  /** Master toggle for the PROACTIVE tiers (actPct handoff / hardPct restart).
   *  Default FALSE: opt-in per agent. (The original rationale -- avoiding a
   *  double-restart against the #525 context-clean path -- is moot, #525 was
   *  closed unmerged; the toggle stays because a proactive handoff/restart
   *  cycle remains an operator choice.) */
  enabled: boolean
  /** Saturation safety net: fresh-restart an agent whose pane shows "100%
   *  context used". Default TRUE and independent of `enabled`, because a
   *  saturated pane can NEVER recover on its own: prompt dispatch refuses it
   *  (isSessionReadyForPrompt), so Claude Code's next-turn auto-compact never
   *  gets a turn to run in -- a pull-model deadlock (samu, 2026-07-18: 34h
   *  session wedged at 976k tokens, 20k+ dispatch refusals, zero compacts). */
  saturationRestart: boolean
  /** Context fraction at which the handoff sequence starts. */
  actPct: number
  /** Context fraction at which we stop waiting for anything and force a fresh
   *  restart -- a pane this deep is likely already wedged. */
  hardPct: number
  /** Explicit context-window override (tokens); null = infer from model. */
  limitTokens: number | null
  /** Quiet period after a guard cycle. Also absorbs the window right after a
   *  restart where the newest transcript is still the OLD heavy session. */
  cooldownMinutes: number
  /** How long to wait for HANDOFF.md before force-restarting anyway. */
  handoffTimeoutMinutes: number
}

export const DEFAULT_CONTEXT_GUARD: ContextGuardConfig = {
  enabled: false,
  saturationRestart: true,
  actPct: 0.90,
  hardPct: 0.97,
  limitTokens: null,
  cooldownMinutes: 15,
  handoffTimeoutMinutes: 6,
}

/** Coerce arbitrary parsed JSON into a safe, fully-populated config. */
export function normalizeContextGuardConfig(raw: unknown): ContextGuardConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const pct = (v: unknown, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1) ? v : dflt
  const mins = (v: unknown, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : dflt
  let actPct = pct(o.actPct, DEFAULT_CONTEXT_GUARD.actPct)
  let hardPct = pct(o.hardPct, DEFAULT_CONTEXT_GUARD.hardPct)
  if (hardPct < actPct) hardPct = actPct // hard tier can never sit below act
  let limitTokens: number | null = null
  if (typeof o.limitTokens === 'number' && Number.isFinite(o.limitTokens) && o.limitTokens >= 10_000) {
    limitTokens = Math.floor(o.limitTokens)
  }
  return {
    enabled: o.enabled === true, // default-off (opt-in): only an explicit true enables
    saturationRestart: o.saturationRestart !== false, // default-ON: only an explicit false disarms the net
    actPct,
    hardPct,
    limitTokens,
    cooldownMinutes: mins(o.cooldownMinutes, DEFAULT_CONTEXT_GUARD.cooldownMinutes),
    handoffTimeoutMinutes: mins(o.handoffTimeoutMinutes, DEFAULT_CONTEXT_GUARD.handoffTimeoutMinutes),
  }
}

// Known context-window tiers. We cannot hardcode every model's window (and new
// models ship), so contextLimitForModel gives a base and calibrateLimit steps
// it up when the OBSERVED context proves the base wrong.
export const CONTEXT_LIMIT_TIERS = [200_000, 500_000, 1_000_000] as const

/** Base context window inferred from the model id. Conservative: unknown → 200k. */
export function contextLimitForModel(model: string | null | undefined): number {
  if (typeof model === 'string' && model.includes('[1m]')) return 1_000_000
  return 200_000
}

/**
 * If the observed context tokens exceed the assumed limit, the assumption is
 * wrong (e.g. tars ran at 489k on a model we would have guessed 200k for).
 * Step up to the next tier that contains the observation instead of producing
 * a nonsense pct > 1 that would trigger a spurious restart storm.
 */
export function calibrateLimit(observedTokens: number, baseLimit: number): number {
  let limit = baseLimit
  for (const tier of CONTEXT_LIMIT_TIERS) {
    if (limit >= observedTokens * 0.98) break
    if (tier > limit) limit = tier
    if (limit >= observedTokens * 0.98) break
  }
  return limit
}

export type GuardPhase = 'idle' | 'await-handoff' | 'await-ready' | 'cooldown'

export interface GuardState {
  phase: GuardPhase
  /** HANDOFF.md mtime (ms) when the handoff was requested; null = file absent. */
  handoffMtimeAtRequest: number | null
  /** Phase deadline (ms): await-handoff → force-restart at; await-ready → give-up at. */
  deadlineMs: number
  /** cooldown → when the guard re-arms. */
  cooldownUntilMs: number
  /** Consecutive idle-phase sweeps that saw a saturated pane (debounce). */
  saturatedStreak: number
}

export const INITIAL_GUARD_STATE: GuardState = {
  phase: 'idle',
  handoffMtimeAtRequest: null,
  deadlineMs: 0,
  cooldownUntilMs: 0,
  saturatedStreak: 0,
}

/** Idle-phase sweeps that must agree the pane is saturated before the net
 *  restarts (one sweep apart, so ~one runner interval of extra latency). A
 *  genuinely saturated pane stays saturated forever; anything transient --
 *  a scrollback quote scrolling through the footer region, a mid-render
 *  frame -- clears by the next sweep. */
export const SATURATION_CONFIRM_SWEEPS = 2

export interface GuardInputs {
  nowMs: number
  /** Live context fraction (0..1+), or null when unmeasurable (no transcript / not running). */
  pct: number | null
  /** Agent session is up (tmux session exists / run state 'running'). */
  running: boolean
  /** Pane looks idle (safe to restart without cutting a turn). */
  paneIdle: boolean
  /** Session is ready to receive a prompt (post-restart readiness). */
  sessionReady: boolean
  /** Current HANDOFF.md mtime (ms), or null when the file does not exist. */
  handoffMtime: number | null
  /** Pane footer shows context saturation ("100% context used" & co). */
  paneSaturated: boolean
}

export type GuardActionType = 'none' | 'request-handoff' | 'restart' | 'inject-resume'

export interface GuardDecision {
  action: GuardActionType
  reason: string
  nextState: GuardState
}

// How long await-ready waits for the restarted session to accept the resume
// prompt before giving up (the agent still comes up fine -- it just starts
// without the injected pointer; kanban/memory hooks remain).
export const READY_TIMEOUT_MS = 5 * 60_000

function cooldown(nowMs: number, cfg: ContextGuardConfig, reason: string): GuardDecision {
  return {
    action: 'none',
    reason,
    nextState: {
      phase: 'cooldown',
      handoffMtimeAtRequest: null,
      deadlineMs: 0,
      cooldownUntilMs: nowMs + cfg.cooldownMinutes * 60_000,
      saturatedStreak: 0,
    },
  }
}

function restartDecision(nowMs: number, reason: string): GuardDecision {
  return {
    action: 'restart',
    reason,
    nextState: {
      phase: 'await-ready',
      handoffMtimeAtRequest: null,
      deadlineMs: nowMs + READY_TIMEOUT_MS,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
    },
  }
}

/**
 * One guard tick for one agent. Pure: caller gathers inputs, executes the
 * returned action, and persists nextState for the next tick.
 */
export function decideGuard(
  state: GuardState,
  inputs: GuardInputs,
  cfg: ContextGuardConfig,
): GuardDecision {
  const { nowMs } = inputs
  const none = (reason: string, next: GuardState = state): GuardDecision =>
    ({ action: 'none', reason, nextState: next })

  if (!cfg.enabled && !cfg.saturationRestart) return none('disabled', INITIAL_GUARD_STATE)

  switch (state.phase) {
    case 'cooldown': {
      if (nowMs >= state.cooldownUntilMs) return none('cooldown elapsed', INITIAL_GUARD_STATE)
      return none('cooling down')
    }

    case 'idle': {
      if (!inputs.running) return none('not running', INITIAL_GUARD_STATE)
      // Saturation net first: it needs no pct (works even when the transcript
      // is unreadable or the limit is miscalibrated) and outranks the
      // proactive tiers -- a saturated pane is already past all of them.
      if (cfg.saturationRestart && inputs.paneSaturated) {
        const streak = state.saturatedStreak + 1
        if (streak >= SATURATION_CONFIRM_SWEEPS) {
          return restartDecision(nowMs, `pane saturated (100% context) for ${streak} sweeps -- unrecoverable without restart`)
        }
        return none('pane saturated, awaiting confirmation sweep', { ...state, saturatedStreak: streak })
      }
      const cleared = state.saturatedStreak > 0 ? { ...state, saturatedStreak: 0 } : state
      if (!cfg.enabled) return none('proactive guard disabled (saturation net armed)', cleared)
      if (inputs.pct === null) return none('context unmeasurable', cleared)
      if (inputs.pct >= cfg.hardPct) {
        // Deep in the danger zone: the pane may already be wedged behind an
        // error/modal, so do not spend a turn asking for a handoff.
        return restartDecision(nowMs, `hard threshold (${Math.round(inputs.pct * 100)}% >= ${Math.round(cfg.hardPct * 100)}%)`)
      }
      if (inputs.pct >= cfg.actPct) {
        return {
          action: 'request-handoff',
          reason: `act threshold (${Math.round(inputs.pct * 100)}% >= ${Math.round(cfg.actPct * 100)}%)`,
          nextState: {
            phase: 'await-handoff',
            handoffMtimeAtRequest: inputs.handoffMtime,
            deadlineMs: nowMs + cfg.handoffTimeoutMinutes * 60_000,
            cooldownUntilMs: 0,
            saturatedStreak: 0,
          },
        }
      }
      return none('below threshold', cleared)
    }

    case 'await-handoff': {
      if (!cfg.enabled) {
        // Operator disabled the proactive guard mid-sequence; stand down.
        return cooldown(nowMs, cfg, 'guard disabled during await-handoff')
      }
      if (!inputs.running) {
        // Someone restarted/stopped the agent externally mid-sequence; a fresh
        // session has a small context, so stand down instead of restarting it.
        return cooldown(nowMs, cfg, 'agent stopped externally during await-handoff')
      }
      if (cfg.saturationRestart && inputs.paneSaturated) {
        // The pane tipped over while we waited for the handoff: the agent can
        // no longer act on the request, so restart now (no debounce -- the
        // act-threshold pct already corroborates a near-full context).
        return restartDecision(nowMs, 'pane saturated during await-handoff')
      }
      const handoffWritten =
        inputs.handoffMtime !== null &&
        (state.handoffMtimeAtRequest === null || inputs.handoffMtime > state.handoffMtimeAtRequest)
      if (handoffWritten && inputs.paneIdle) {
        return restartDecision(nowMs, 'handoff written')
      }
      if (inputs.pct !== null && inputs.pct >= cfg.hardPct) {
        return restartDecision(nowMs, 'hard threshold during await-handoff')
      }
      if (nowMs >= state.deadlineMs) {
        // No handoff in time (agent wedged or ignored the prompt). Restart
        // anyway: taskstate + kanban + hot memories are the fallback context.
        return restartDecision(nowMs, 'handoff timeout -- force restart')
      }
      return none(handoffWritten ? 'handoff written, waiting for idle pane' : 'waiting for handoff')
    }

    case 'await-ready': {
      if (inputs.running && inputs.sessionReady) {
        return {
          action: 'inject-resume',
          reason: 'session ready after restart',
          nextState: {
            phase: 'cooldown',
            handoffMtimeAtRequest: null,
            deadlineMs: 0,
            cooldownUntilMs: nowMs + cfg.cooldownMinutes * 60_000,
            saturatedStreak: 0,
          },
        }
      }
      if (nowMs >= state.deadlineMs) {
        return cooldown(nowMs, cfg, 'ready timeout -- giving up on resume injection')
      }
      return none('waiting for restarted session')
    }
  }
}
