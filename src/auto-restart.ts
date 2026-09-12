// Pure logic for the per-agent auto-restart feature.
//
// A long-lived Claude Code session accumulates context: every turn re-reads the
// whole transcript, so a big context is slower and costlier and hits the
// per-session limit sooner. Restarting periodically (by default after the
// nightly dream consolidation -- "the brain sleeps, tidies up, wakes fresh")
// keeps sessions lean. Two modes:
//   - 'fresh':    drop the conversation (start without --continue) -- the speed-up.
//   - 'continue': keep the conversation (--continue) but re-spawn the process,
//                 so a tier/limit-budget refresh takes effect without losing context.
//
// This module is dependency-free so the due-decision is unit-testable without a
// clock, tmux, or the filesystem. The I/O (reading the config store, checking the
// pane is idle, performing the restart) lives in src/web/auto-restart-runner.ts.

export type AutoRestartMode = 'fresh' | 'continue'

/** How the MAIN channels session is restarted on this host. */
export type MainRestartMechanism = 'launchd' | 'tmux-respawn'

/**
 * Pick the main-session restart mechanism from what the host actually has.
 *
 * The predicate is the launchctl BINARY, not process.platform: the bug this
 * replaces was not "wrong OS" but "the binary this code exec'd unconditionally
 * does not exist here", and the binary is what decides whether the call can
 * work at all. Kept here, in the dependency-free module, so it is unit-testable
 * without a filesystem -- same reason the due-logic lives here.
 */
export function mainRestartMechanism(launchctlPresent: boolean): MainRestartMechanism {
  return launchctlPresent ? 'launchd' : 'tmux-respawn'
}

export interface AutoRestartConfig {
  /** Master toggle. When false the agent is never auto-restarted. */
  enabled: boolean
  /** What kind of restart to perform. */
  mode: AutoRestartMode
  /** Daily restart wall-clock time, 'HH:MM' in local time, or null. */
  dailyTime: string | null
  /** Restart every N hours, or null. Exactly one of dailyTime/intervalHours is
   *  meaningful; dailyTime wins if both are somehow set. */
  intervalHours: number | null
  /** Hours an unanswered inbound question may keep deferring a due restart
   *  before the restart proceeds anyway. See OPEN_QUESTION_DEFERRAL_CAP_HOURS. */
  openQuestionDeferralCapHours: number
}

export const OPEN_QUESTION_DEFERRAL_CAP_HOURS = 24

/**
 * Config keys this endpoint still ACCEPTS but no longer stores.
 *
 * `handoff` was declared here as "Phase 2: run the handoff skill before a fresh
 * restart" and was never wired: the restart path (auto-restart-runner,
 * agent-process) contained zero references to it, and performRestart passed only
 * `{ fresh }`. So the field read as a switch -- it is in every agent's stored
 * config, the PUT accepted it, a GET echoed it back -- while setting it to true
 * changed nothing. That is worse than a missing feature: the obvious remedy for a
 * nightly restart losing uncommitted context is "turn handoff on for the working
 * agents", and it would have looked done while doing nothing.
 *
 * Handoffs have ONE owner, and it is not this module: the context-guard writes
 * HANDOFF.md through its own await-handoff state machine, with a timeout and a
 * staleness refresh. Do not re-add a handoff flag here without wiring it; if the
 * nightly restart should request a handoff, that belongs in the context-guard as
 * another trigger, not as a second machine racing the first over the same file.
 *
 * Kept in the accepted set purely so an already-loaded dashboard page (whose
 * cached app.js still sends `handoff: false`) does not start failing its save
 * with a 400. normalizeAutoRestartConfig drops it, so it is never persisted.
 */
export const LEGACY_AUTO_RESTART_FIELDS = ['handoff'] as const

export const DEFAULT_AUTO_RESTART: AutoRestartConfig = {
  enabled: false,
  mode: 'continue',
  dailyTime: null,
  intervalHours: null,
  openQuestionDeferralCapHours: OPEN_QUESTION_DEFERRAL_CAP_HOURS,
}

/** Parse 'HH:MM' (24h) into minutes since local midnight, or null if invalid. */
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/**
 * Coerce arbitrary parsed JSON into a safe, fully-populated config. Unknown /
 * malformed fields fall back to defaults, so a hand-edited or older store can
 * never crash the runner or yield a half-set config.
 */
export function normalizeAutoRestartConfig(raw: unknown): AutoRestartConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const mode: AutoRestartMode = o.mode === 'fresh' ? 'fresh' : 'continue'
  const dailyTime = parseHHMM(o.dailyTime) !== null ? (o.dailyTime as string).trim() : null
  let intervalHours: number | null = null
  if (typeof o.intervalHours === 'number' && Number.isFinite(o.intervalHours) && o.intervalHours > 0) {
    intervalHours = o.intervalHours
  }
  // dailyTime takes precedence: never keep both, so the schedule is unambiguous.
  if (dailyTime !== null) intervalHours = null
  let openQuestionDeferralCapHours = OPEN_QUESTION_DEFERRAL_CAP_HOURS
  if (typeof o.openQuestionDeferralCapHours === 'number' &&
      Number.isFinite(o.openQuestionDeferralCapHours) && o.openQuestionDeferralCapHours > 0) {
    openQuestionDeferralCapHours = o.openQuestionDeferralCapHours
  }
  return {
    enabled: o.enabled === true,
    mode,
    dailyTime,
    intervalHours,
    openQuestionDeferralCapHours,
  }
}

/**
 * Pure decision: is a restart due *now*?
 *
 * `dueAtMs` is the timestamp the caller computed for the next scheduled restart
 * (today's HH:MM for the daily schedule, or lastRestart + interval for the
 * interval schedule). A restart is due when now has reached it AND we have not
 * already restarted at or after it (so it fires once per scheduled point, not
 * every tick in the window).
 *
 * @param lastRestartAtMs  When this agent was last auto-restarted, or null if never.
 * @param nowMs            Current clock (ms).
 * @param dueAtMs          The scheduled restart timestamp to compare against.
 */
export function restartDue(lastRestartAtMs: number | null, nowMs: number, dueAtMs: number): boolean {
  if (!Number.isFinite(dueAtMs)) return false
  if (nowMs < dueAtMs) return false
  if (lastRestartAtMs !== null && lastRestartAtMs >= dueAtMs) return false
  return true
}

/**
 * Start-of-local-day timestamp for the day containing `nowMs`, given the
 * environment's local-midnight offset already applied by the caller. Kept here
 * as a pure helper that takes the local Y/M/D components so it is testable
 * without a timezone: the runner passes `new Date(nowMs)` getFullYear/Month/Date.
 */
export function dailyDueAtMs(
  localMidnightMs: number,
  minutesSinceMidnight: number,
): number {
  return localMidnightMs + minutesSinceMidnight * 60_000
}

/**
 * Start-of-local-day timestamp for the day containing `nowMs`.
 *
 * Lives here, next to dailyDueAtMs, because TWO runners now schedule on a
 * daily wall-clock slot: the nightly auto-restart and the context-guard's
 * daily-handoff tier. A second private copy of this would be a second place
 * for a midnight boundary to drift.
 */
export function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Why a due restart must still be deferred, or null when it may proceed.
 * Pure so the invariants are unit-testable:
 *   - a busy pane defers (never cut off a live turn), and
 *   - an unanswered inbound question defers -- an idle pane is NOT proof there
 *     is nothing to lose, because an agent waiting on the owner's answer is
 *     idle precisely then, and a restart swallows the pending exchange (for a
 *     channel agent even a "continue" restart is effectively fresh).
 * Busy-pane wins the ordering: it is the harder invariant (mid-turn cutoff).
 */
export function restartBlockedBy(
  signals: { paneIdle: boolean; openQuestion: boolean },
): 'busy-pane' | 'open-question' | null {
  if (!signals.paneIdle) return 'busy-pane'
  if (signals.openQuestion) return 'open-question'
  return null
}

/**
 * Cap on how long an unanswered inbound question may keep deferring a due
 * restart. The open-question signal has no clock of its own: a question the
 * owner never answers stays "open" forever (a live agent ledger showed one
 * standing for 72 days), and an uncapped deferral turns the nightly restart
 * into a mechanism that silently never runs. After the cap the restart
 * proceeds anyway -- the deferral must have an end, and the override is
 * logged so it also has a voice. The hours are configurable per agent via
 * AutoRestartConfig.openQuestionDeferralCapHours; this is the default.
 */
export const OPEN_QUESTION_DEFERRAL_CAP_MS = OPEN_QUESTION_DEFERRAL_CAP_HOURS * 60 * 60 * 1000

/**
 * Whether a due-but-deferred restart must proceed despite the block.
 * Only 'open-question' deferrals are overridden: a busy pane is the harder
 * invariant (never cut off a live turn) and is never overridden, no matter
 * how long the streak.
 *
 * @param blocked          Result of restartBlockedBy for this tick.
 * @param deferredSinceMs  When the current open-question deferral streak
 *                         started, or null if there is no streak.
 * @param nowMs            Current clock (ms).
 * @param capMs            Maximum streak length before the override fires.
 */
export function deferralOverride(
  blocked: 'busy-pane' | 'open-question' | null,
  deferredSinceMs: number | null,
  nowMs: number,
  capMs: number = OPEN_QUESTION_DEFERRAL_CAP_MS,
): boolean {
  if (blocked !== 'open-question') return false
  if (deferredSinceMs === null) return false
  return nowMs - deferredSinceMs >= capMs
}
