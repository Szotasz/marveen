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
  /** Idle-flush tier: hand off a HEAVY but QUIET session. Independent of
   *  `enabled` (a different question: cost, not danger) and default FALSE,
   *  because it ends agent conversations that nothing else would have ended. */
  idleFlushEnabled: boolean
  /** Absolute context size (tokens) above which an idle session is worth
   *  flushing. Absolute, not a window fraction: this tier is about what the
   *  context COSTS to re-read every turn, which is a token count, while
   *  act/hardPct are about how close the window is to wedging. */
  idleFlushTokens: number
  /** How long the session must have been quiet before the idle tier acts. */
  idleMinutes: number
}

export const DEFAULT_CONTEXT_GUARD: ContextGuardConfig = {
  enabled: false,
  saturationRestart: true,
  actPct: 0.90,
  hardPct: 0.97,
  limitTokens: null,
  cooldownMinutes: 15,
  // 20 minutes, raised from 6 (2026-07-27): a working agent mid-turn cannot
  // stop to write a handoff, and 6 minutes was shorter than a normal
  // tool-heavy turn -- the timeout fired straight into a force-restart while
  // the agent was actively working. Restarts now also defer while the pane is
  // positively busy (see decideGuard), so this timeout only disciplines an
  // IDLE agent that ignored the handoff request.
  handoffTimeoutMinutes: 20,
  idleFlushEnabled: false,
  // 400k, the same figure the soft restart gate reasoned its way to
  // (DEFAULT_THRESHOLD_TOKENS): it leaves a 1M-window model 600k of room for a
  // clean transition, and exceeds a 200k window entirely so the tier never
  // fires there -- act/hardPct keep those sessions instead.
  //
  // 500k was the alternative, and the trade is worth recording because moving
  // this number means re-deciding it:
  //
  //   LOWER wins on tokens. Sitting 100k deeper costs that much extra input on
  //   EVERY turn; one flush costs a handoff turn plus a restart, once. The
  //   per-turn saving dominates the one-off cost by orders of magnitude, so
  //   leaving the expensive band sooner is the cheaper direction.
  //
  //   HIGHER wins on continuity. Each flush makes the agent re-orient from
  //   HANDOFF.md, which costs quality in a way tokens do not measure.
  //
  //   Tokens won, and the gap is smaller than it looks: the flush RATE is set
  //   by the idle gate, not by this number. Once a long session is past either
  //   threshold it stays past it, so the two differ by roughly one extra flush
  //   during the first climb, not by a standing difference in rate.
  //
  // Threshold against RAW tokens read from the transcript, never against a
  // window percentage. Deriving a token count by multiplying a percentage by a
  // presumed window size is wrong by a factor of five on a 200k-window
  // session, and would invite the reader to treat a small-window agent as a
  // candidate when the threshold exceeds its whole window.
  idleFlushTokens: 400_000,
  // 20 minutes, matching handoffTimeoutMinutes. That number is already set to
  // comfortably exceed a normal tool-heavy turn, so it is an evidenced
  // "quieter than this is not a working turn" boundary rather than a second
  // invented figure.
  idleMinutes: 20,
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
  // Same >= 10_000 floor as limitTokens: a token threshold small enough to be
  // a typo (400 for 400_000) would flush a session that has barely started.
  const idleFlushTokens =
    (typeof o.idleFlushTokens === 'number' && Number.isFinite(o.idleFlushTokens) && o.idleFlushTokens >= 10_000)
      ? Math.floor(o.idleFlushTokens)
      : DEFAULT_CONTEXT_GUARD.idleFlushTokens
  return {
    enabled: o.enabled === true, // default-off (opt-in): only an explicit true enables
    saturationRestart: o.saturationRestart !== false, // default-ON: only an explicit false disarms the net
    actPct,
    hardPct,
    limitTokens,
    cooldownMinutes: mins(o.cooldownMinutes, DEFAULT_CONTEXT_GUARD.cooldownMinutes),
    handoffTimeoutMinutes: mins(o.handoffTimeoutMinutes, DEFAULT_CONTEXT_GUARD.handoffTimeoutMinutes),
    idleFlushEnabled: o.idleFlushEnabled === true, // default-off (opt-in), like `enabled`
    idleFlushTokens,
    idleMinutes: mins(o.idleMinutes, DEFAULT_CONTEXT_GUARD.idleMinutes),
  }
}

// Known context-window tiers. We cannot hardcode every model's window (and new
// models ship), so contextLimitForModel gives a base and calibrateLimit steps
// it up when the OBSERVED context proves the base wrong.
export const CONTEXT_LIMIT_TIERS = [200_000, 500_000, 1_000_000] as const

/**
 * Base context window inferred from the model id.
 *
 * The `[1m]` suffix is an explicit operator opt-in and always wins. Beyond
 * that, the current Fable/Mythos/Opus families run 1M windows in Claude Code
 * WITHOUT the suffix -- verified from live sources, not assumed: the Models
 * API reports 1M for all of them, and this host's own transcripts show
 * sessions genuinely reaching it (measured 2026-07-27: fable-5 976k, geri
 * fable-5 911k, opus-4-8 985k-999k, opus-5 979k). The previous blanket-200k
 * guess made the guard read a fable-5 session at 21% real usage as "106%
 * full" and force-restart working agents all day (17 hard-threshold events
 * on 2026-07-27, two of them killing samu mid-task and losing dispatched
 * instructions).
 *
 * Sonnet stays at 200k deliberately: this host has never observed a sonnet
 * session above 198k (sonnet-5 max 197,885 across 14 days), so 200k is the
 * evidenced effective window there. Haiku is 200k by spec. Unknown models
 * stay conservative at 200k -- calibrateLimit and the runner's persisted
 * high-water mark step the denominator up from live evidence, and
 * over-estimating would blind the proactive tiers (the 2026-07-26 failure
 * mode), while under-estimating is loud and self-correcting.
 */
const ONE_MILLION_FAMILIES = [/fable-\d/, /mythos-\d/, /opus-4-[6-9]/, /opus-[5-9]\b/]

export function contextLimitForModel(model: string | null | undefined): number {
  if (typeof model !== 'string') return 200_000
  const m = model.toLowerCase()
  if (m.includes('[1m]')) return 1_000_000
  if (ONE_MILLION_FAMILIES.some(rx => rx.test(m))) return 1_000_000
  return 200_000
}

/**
 * How far the OBSERVED context may exceed a limit while still being explained by
 * that limit rather than disproving it.
 *
 * The observation is the sum of input + cache_read + cache_creation tokens of a
 * session's last request, which overshoots the nominal window: measured
 * 2026-07-26 across 11 sessions that Claude Code itself had flagged "100%
 * context used" (main agent 194226/204285/207942/208132/213175, heimdall
 * 178536/179772/182648/188129/191286/198544 -- all on 200k-window models), the
 * largest overshoot was 213175/200000 = 1.066x. The previous tolerance was
 * effectively 1.0204x (`limit >= observed * 0.98`), i.e. NARROWER than the real
 * overshoot, so a genuinely-full 200k session crossed it at 204082 observed
 * tokens and the denominator jumped to 500k -- reporting 43% for a session the
 * CLI had just declared full, and putting actPct (0.9) and hardPct (0.97) out of
 * reach for the rest of that session's life. This value is deliberately ~2x the
 * measured overshoot so a full window is never mistaken for a bigger one.
 */
export const CALIBRATION_OVERSHOOT_TOLERANCE = 1.25

/**
 * If the observed context tokens exceed the assumed limit by more than an
 * accounting overshoot can explain, the assumption is wrong (e.g. tars ran at
 * 489k -- 2.4x -- on a model we would have guessed 200k for). Step up to the
 * smallest tier that can hold the observation, instead of producing a nonsense
 * pct > 1 that would trigger a spurious restart storm.
 *
 * The tolerance direction is chosen deliberately. Under-estimating the limit
 * reports a too-high pct and costs at most a premature (but LOUD, logged, and
 * self-correcting) handoff/restart; over-estimating it goes SILENTLY blind and
 * costs the whole session with no handoff at all -- which is what happened on
 * 2026-07-26. When in doubt we keep the smaller denominator.
 *
 * Residual, stated rather than hidden: a session whose real window is a tier we
 * did not guess is measured against the smaller tier until it exceeds it by the
 * tolerance -- e.g. a genuine 500k window observed in 200000..250000 reads as
 * over-full and may be restarted once before it grows past the step-up point.
 * No model in the fleet is configured that way today (every agent resolves to a
 * 200k window; only the `[1m]` suffix selects a larger one), and `limitTokens`
 * pins the denominator explicitly when an operator knows better.
 */
export function calibrateLimit(observedTokens: number, baseLimit: number): number {
  const explains = (limit: number): boolean =>
    observedTokens <= limit * CALIBRATION_OVERSHOOT_TOLERANCE
  let limit = baseLimit
  for (const tier of CONTEXT_LIMIT_TIERS) {
    if (explains(limit)) break
    if (tier > limit) limit = tier
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
  /** Set at restart time when HANDOFF.md predates the agent's last transcript
   *  activity by more than the slack: ~minutes of work the handoff does NOT
   *  cover. Carried into await-ready so the resume prompt can say so -- a
   *  fresh session pointed at a stale handoff re-opens already-decided
   *  questions (2026-08-17: a merge-gate verdict on a payment PR was missing
   *  from a 20-minute-old handoff presented as current). */
  handoffStaleMinutes: HandoffStaleness
}

export const INITIAL_GUARD_STATE: GuardState = {
  phase: 'idle',
  handoffMtimeAtRequest: null,
  deadlineMs: 0,
  cooldownUntilMs: 0,
  saturatedStreak: 0,
  handoffStaleMinutes: null,
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
  /** Pane shows a POSITIVE mid-turn signal (spinner / esc-to-interrupt /
   *  token counter). Distinct from `!paneIdle`: a wedged pane behind an
   *  error banner is neither idle nor busy, and must NOT be treated as
   *  working -- deferring on `!paneIdle` would protect wedged panes from
   *  the restart that is their only way out. */
  paneBusy: boolean
  /** Session is ready to receive a prompt (post-restart readiness). */
  sessionReady: boolean
  /** Current HANDOFF.md mtime (ms), or null when the file does not exist. */
  handoffMtime: number | null
  /** Pane footer shows context saturation ("100% context used" & co). */
  paneSaturated: boolean
  /** Raw observed context size (tokens), or null when unmeasurable. The
   *  idle-flush tier thresholds on this rather than on `pct`, so its trigger
   *  does not move when the window denominator is recalibrated. */
  contextTokens: number | null
  /** How long the session's transcript has been untouched (ms), or null when
   *  unmeasurable. NOT proof the agent is finished -- a single long tool call
   *  writes nothing while it runs -- so it is only ever read together with
   *  paneIdle. See readTranscriptMtimeFromProjectDir. */
  idleMs: number | null
}

/**
 * Reason prefix marking a decision that came from the idle-flush tier.
 *
 * The runner has to word the handoff request differently for it: the act tier
 * asks an agent to stop because its session is about to break, the idle tier
 * asks a session that is already finished to wrap up, and telling an idle agent
 * its context is "critical" would be a lie that provokes exactly the panicked
 * mid-task abandonment this tier is designed to avoid. Exported so the runner
 * matches a constant rather than re-typing the string.
 */
export const IDLE_FLUSH_REASON_PREFIX = 'idle-flush'

/**
 * Reason prefix for a repeated handoff request sent because the one on disk
 * went stale while the guard waited for an idle pane. The runner words this
 * request differently again: the agent DID write a handoff, it just kept
 * working afterwards, so "write a handoff" would read as a bug and "your
 * context is critical" may be false.
 */
export const STALE_REFRESH_REASON_PREFIX = 'stale-handoff-refresh'

/** Slack between HANDOFF.md's mtime and the last transcript activity before
 *  the handoff counts as stale. The handoff-writing turn itself touches the
 *  transcript slightly AFTER the file write (tool result + closing reply), so
 *  a zero-slack comparison would flag every handoff as stale. */
export const STALE_HANDOFF_SLACK_MS = 3 * 60_000

/** Freshness verdict for HANDOFF.md at decision time: minutes of uncovered
 *  work, 'unknown', or null (= fresh enough / no artifact to judge). */
export type HandoffStaleness = number | 'unknown' | null

/**
 * How many minutes of work HANDOFF.md fails to cover; null when it is fresh
 * enough or there is no artifact to judge. "Existence is not freshness": the
 * guard's handoff precondition must compare the artifact against the agent's
 * LAST MEANINGFUL OUTPUT (transcript mtime = nowMs - idleMs), not merely
 * observe that the file appeared after the request -- an agent that writes
 * the handoff and then keeps working (messages keep arriving while the guard
 * waits for an idle pane) satisfies the mtime-advanced check with an
 * artifact that is minutes-to-hours behind.
 *
 * When the artifact exists but the transcript clock is unreadable the answer
 * is 'unknown', NOT null: a missing measurement must not impersonate a
 * fresh one (the same error class this function exists to fix). 'unknown'
 * never triggers a refresh -- there is no evidence to demand one on -- but
 * it rides to the resume prompt so the fresh session is told the freshness
 * was unverifiable instead of nothing.
 */
export function handoffStaleMinutes(inputs: GuardInputs): HandoffStaleness {
  if (inputs.handoffMtime === null) return null
  if (inputs.idleMs === null) return 'unknown'
  const lastActivityMs = inputs.nowMs - inputs.idleMs
  const gapMs = lastActivityMs - inputs.handoffMtime
  return gapMs > STALE_HANDOFF_SLACK_MS ? Math.round(gapMs / 60_000) : null
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
      handoffStaleMinutes: null,
    },
  }
}

/** staleMinutes rides into await-ready so inject-resume can tell the fresh
 *  session its handoff does not cover the last N minutes. */
function restartDecision(nowMs: number, reason: string, staleMinutes: HandoffStaleness = null): GuardDecision {
  return {
    action: 'restart',
    reason,
    nextState: {
      phase: 'await-ready',
      handoffMtimeAtRequest: null,
      deadlineMs: nowMs + READY_TIMEOUT_MS,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
      handoffStaleMinutes: staleMinutes,
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

  if (!cfg.enabled && !cfg.saturationRestart && !cfg.idleFlushEnabled) {
    return none('disabled', INITIAL_GUARD_STATE)
  }

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
          return restartDecision(
            nowMs,
            `pane saturated (100% context) for ${streak} sweeps -- unrecoverable without restart`,
            handoffStaleMinutes(inputs),
          )
        }
        return none('pane saturated, awaiting confirmation sweep', { ...state, saturatedStreak: streak })
      }
      const cleared = state.saturatedStreak > 0 ? { ...state, saturatedStreak: 0 } : state
      if (cfg.enabled && inputs.pct !== null) {
        const wedgeTier = decideWedgeTiers(nowMs, inputs, cfg, cleared, none)
        if (wedgeTier) return wedgeTier
      }
      // Idle-flush tier. Ranked BELOW the wedge tiers deliberately: those two
      // answer "is this session about to break", this one answers "is it worth
      // paying for", and a session that is both should be rescued on the
      // urgent grounds, not the thrifty ones. In practice it only ever sees
      // sessions below actPct, which is exactly the band it is for.
      if (cfg.idleFlushEnabled) {
        const flush = decideIdleFlush(nowMs, inputs, cfg, cleared, none)
        if (flush) return flush
      }
      if (!cfg.enabled) return none('proactive guard disabled (saturation net armed)', cleared)
      if (inputs.pct === null) return none('context unmeasurable', cleared)
      return none('below threshold', cleared)
    }

    case 'await-handoff': {
      if (!cfg.enabled && !cfg.idleFlushEnabled) {
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
        return restartDecision(nowMs, 'pane saturated during await-handoff', handoffStaleMinutes(inputs))
      }
      const handoffWritten =
        inputs.handoffMtime !== null &&
        (state.handoffMtimeAtRequest === null || inputs.handoffMtime > state.handoffMtimeAtRequest)
      if (handoffWritten && inputs.paneIdle) {
        // mtime-advanced is necessary but NOT sufficient: the agent may have
        // written the handoff and then kept working while we waited for an
        // idle pane (2026-08-17: 20 minutes of work, including a merge-gate
        // verdict, happened after the write). Existence is not freshness.
        const staleMin = handoffStaleMinutes(inputs)
        if (typeof staleMin === 'number' && nowMs < state.deadlineMs && !(inputs.pct !== null && inputs.pct >= cfg.hardPct)) {
          // There is still budget before the deadline and the context is not
          // yet at the hard threshold: ask for a refresh instead of shipping
          // a handoff that misses the last N minutes. Advancing the recorded
          // mtime makes the NEXT write count as fresh; the deadline is left
          // alone, so an agent that keeps working through refresh requests
          // still restarts on time (with the staleness said out loud).
          return {
            action: 'request-handoff',
            reason: `${STALE_REFRESH_REASON_PREFIX}: handoff written but ~${staleMin}m of work happened after it -- requesting refresh`,
            nextState: { ...state, handoffMtimeAtRequest: inputs.handoffMtime },
          }
        }
        return restartDecision(
          nowMs,
          typeof staleMin === 'number' ? `handoff written but STALE (~${staleMin}m of work after it)` : 'handoff written',
          staleMin,
        )
      }
      // Same mid-turn deferral as the idle-phase hard tier: neither the hard
      // threshold nor the handoff timeout may cut a live turn. The deadline
      // stays in the past while we defer, so the restart fires on the first
      // sweep that finds the pane no longer busy; a turn that saturates
      // mid-flight is caught by the paneSaturated branch above.
      if (inputs.pct !== null && inputs.pct >= cfg.hardPct) {
        if (inputs.paneBusy) return none('hard threshold during await-handoff but agent mid-turn -- deferring restart')
        return restartDecision(nowMs, 'hard threshold during await-handoff', handoffStaleMinutes(inputs))
      }
      if (nowMs >= state.deadlineMs) {
        if (inputs.paneBusy) return none('handoff timeout but agent mid-turn -- deferring restart')
        // No handoff in time (agent wedged or ignored the prompt). Restart
        // anyway: taskstate + kanban + hot memories are the fallback context.
        // An OLD HANDOFF.md may still exist; measure how far behind it is so
        // the resume prompt does not present it as current.
        return restartDecision(nowMs, 'handoff timeout -- force restart', handoffStaleMinutes(inputs))
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
            handoffStaleMinutes: null,
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

type NoneFn = (reason: string, next?: GuardState) => GuardDecision

/** The two wedge tiers (hardPct restart, actPct handoff). Null = neither applies. */
function decideWedgeTiers(
  nowMs: number,
  inputs: GuardInputs,
  cfg: ContextGuardConfig,
  cleared: GuardState,
  none: NoneFn,
): GuardDecision | null {
  const pct = inputs.pct as number
  if (pct >= cfg.hardPct) {
    // Deep in the danger zone: the pane may already be wedged behind an
    // error/modal, so do not spend a turn asking for a handoff. But a
    // POSITIVELY busy pane is working, not wedged -- restarting it cuts
    // a live turn and destroys any queued/parked input with it (Szabi,
    // 2026-07-27: agents restarted mid-work, dispatched instructions
    // lost). Defer while busy; the sweep re-decides every interval, and
    // a turn that tips into saturation is caught by the saturation net,
    // which deliberately ignores the busy signal.
    if (inputs.paneBusy) {
      return none(`hard threshold (${Math.round(pct * 100)}%) but agent mid-turn -- deferring restart`, cleared)
    }
    return restartDecision(
      nowMs,
      `hard threshold (${Math.round(pct * 100)}% >= ${Math.round(cfg.hardPct * 100)}%)`,
      handoffStaleMinutes(inputs),
    )
  }
  if (pct >= cfg.actPct) {
    return handoffRequest(nowMs, inputs, cfg, `act threshold (${Math.round(pct * 100)}% >= ${Math.round(cfg.actPct * 100)}%)`)
  }
  return null
}

/**
 * Idle-flush tier: a session heavy enough to be worth re-reading less often,
 * that has ALSO gone quiet. Null = does not apply.
 *
 * Every condition fails closed, because the cost of a wrong "yes" (an agent
 * loses the thread it was holding) dwarfs the cost of a wrong "no" (one more
 * heavy session until the next sweep).
 *
 * The quiet test is deliberately TWO signals, not one:
 *
 *   idleMs    -- how long the transcript has been untouched. Survives a
 *                dashboard restart because the clock lives in the filesystem,
 *                written by the session itself.
 *   paneIdle  -- whether the pane is idle RIGHT NOW. Needed because a single
 *                long tool call appends nothing to the transcript while it
 *                runs, so idleMs alone reads a working agent as quiet.
 *
 * paneIdle, not !paneBusy: a pane parked behind an error banner is neither,
 * and flushing one on the strength of a stale mtime would throw away whatever
 * state a human might still recover from it. The saturation net is the
 * mechanism for wedged panes; this tier stays out of that business.
 */
function decideIdleFlush(
  nowMs: number,
  inputs: GuardInputs,
  cfg: ContextGuardConfig,
  cleared: GuardState,
  none: NoneFn,
): GuardDecision | null {
  if (inputs.contextTokens === null) return none('idle-flush: context size unmeasurable', cleared)
  if (inputs.contextTokens < cfg.idleFlushTokens) return null
  if (inputs.idleMs === null) return none('idle-flush: transcript idle time unmeasurable', cleared)
  if (inputs.idleMs < cfg.idleMinutes * 60_000) {
    return none(
      `idle-flush: heavy (${Math.round(inputs.contextTokens / 1000)}k) but quiet for only ` +
      `${Math.round(inputs.idleMs / 60_000)}m of ${cfg.idleMinutes}m`,
      cleared,
    )
  }
  if (!inputs.paneIdle) {
    return none(
      `idle-flush: heavy and quiet, but pane is not confirmed idle -- deferring`,
      cleared,
    )
  }
  return handoffRequest(
    nowMs, inputs, cfg,
    `${IDLE_FLUSH_REASON_PREFIX} (${Math.round(inputs.contextTokens / 1000)}k tokens, quiet for ` +
    `${Math.round(inputs.idleMs / 60_000)}m >= ${cfg.idleMinutes}m)`,
  )
}

/**
 * Ask the agent to write HANDOFF.md and enter await-handoff.
 *
 * Shared by both tiers that hand off (actPct and idle-flush) so they cannot
 * drift apart: whatever await-handoff expects to find in the state -- the
 * pre-request HANDOFF.md mtime, the timeout deadline -- is set in exactly one
 * place. The handoff is also what makes the idle tier safe to run on a
 * sub-agent at all: it does not depend on any transcript-capture mechanism
 * existing, because the agent writes down where it got to itself.
 */
function handoffRequest(
  nowMs: number,
  inputs: GuardInputs,
  cfg: ContextGuardConfig,
  reason: string,
): GuardDecision {
  return {
    action: 'request-handoff',
    reason,
    nextState: {
      phase: 'await-handoff',
      handoffMtimeAtRequest: inputs.handoffMtime,
      deadlineMs: nowMs + cfg.handoffTimeoutMinutes * 60_000,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
      handoffStaleMinutes: null,
    },
  }
}
