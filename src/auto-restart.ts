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

/** What caused a restart. Kept separate from the schedule fields so the
 *  runner can log why an agent went down, and so the fresh/continue decision
 *  can depend on it (see shouldStartFresh). */
export type RestartReason = 'schedule' | 'card'

export interface AutoRestartConfig {
  /** Master toggle. When false the agent is never auto-restarted. */
  enabled: boolean
  /** What kind of restart to perform. */
  mode: AutoRestartMode
  /** Daily restart wall-clock time, 'HH:MM' in local time, or null. */
  dailyTime: string | null
  /** Restart every N hours, or null. */
  intervalHours: number | null
  /** Phase 2: run the handoff skill to persist context before a fresh restart. */
  handoff: boolean
  /** Restart before each new kanban card instead of on a clock. See the
   *  three-way schedule note on normalizeAutoRestartConfig. */
  onCardStart: boolean
}

export const DEFAULT_AUTO_RESTART: AutoRestartConfig = {
  enabled: false,
  mode: 'continue',
  dailyTime: null,
  intervalHours: null,
  handoff: false,
  onCardStart: false,
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
 *
 * The schedule is a THREE-WAY EXCLUSIVE choice -- daily time, every N hours, or
 * per kanban card -- and this function is what enforces it. Storing two of them
 * at once would make "when does this agent restart?" unanswerable from the
 * config alone. Precedence, most specific first: onCardStart > dailyTime >
 * intervalHours.
 */
export function normalizeAutoRestartConfig(raw: unknown): AutoRestartConfig {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const mode: AutoRestartMode = o.mode === 'fresh' ? 'fresh' : 'continue'
  const onCardStart = o.onCardStart === true
  let dailyTime = parseHHMM(o.dailyTime) !== null ? (o.dailyTime as string).trim() : null
  let intervalHours: number | null = null
  if (typeof o.intervalHours === 'number' && Number.isFinite(o.intervalHours) && o.intervalHours > 0) {
    intervalHours = o.intervalHours
  }
  // dailyTime takes precedence: never keep both, so the schedule is unambiguous.
  if (dailyTime !== null) intervalHours = null
  // ...and the per-card schedule takes precedence over both clocks.
  if (onCardStart) {
    dailyTime = null
    intervalHours = null
  }
  return {
    enabled: o.enabled === true,
    mode,
    dailyTime,
    intervalHours,
    handoff: o.handoff === true,
    onCardStart,
  }
}

/**
 * Pure decision: should this agent restart because a new kanban card just
 * arrived?
 *
 * The point of the per-card schedule is that a card boundary is the one moment
 * when dropping the context is free -- the work that built it is finished, and
 * there is nothing to cut in half. A clock-based schedule has neither property.
 *
 * @param onCardStart      Is this agent on the per-card schedule at all?
 * @param pendingCardAt    When a card dispatch requested a restart, or null.
 * @param lastRestartAtMs  When this agent was last auto-restarted, or null if never.
 * @param nowMs            Current clock (ms).
 * @param minIntervalMs    Restart-storm guard: several cards moved to
 *                         in_progress in quick succession must not each cost a
 *                         restart -- the first one already gave a clean context.
 */
export function shouldRestartOnCard(input: {
  onCardStart: boolean
  pendingCardAt: number | null
  lastRestartAtMs: number | null
  nowMs: number
  minIntervalMs: number
}): boolean {
  const { onCardStart, pendingCardAt, lastRestartAtMs, nowMs, minIntervalMs } = input
  if (!onCardStart) return false
  if (pendingCardAt === null) return false
  if (lastRestartAtMs !== null && nowMs - lastRestartAtMs < minIntervalMs) return false
  return true
}

/**
 * Pure decision: does this restart drop the conversation?
 *
 * A card-triggered restart exists to clear the accumulated context, so keeping
 * the conversation would make it pointless -- it is always fresh, whatever the
 * mode control says. A scheduled restart honours the operator's `mode` choice,
 * which is a separate axis (how to restart) from the schedule (when).
 */
export function shouldStartFresh(reason: RestartReason, mode: AutoRestartMode): boolean {
  return reason === 'card' || mode === 'fresh'
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
