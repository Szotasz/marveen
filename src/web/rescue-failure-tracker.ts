/**
 * Consecutive failed context-guard rescues, per agent.
 *
 * WHY THIS EXISTS. After RESTARTRACE901 a failed rescue is honest: the guard
 * checks the restart result, rolls its state back, and writes logger.error. It
 * is honest and it is SILENT. A saturated pane cannot be prompted (dispatch
 * refuses it), so an agent whose rescue keeps failing is simply gone -- and the
 * only place that knows is a log line nobody is reading. That is the same shape
 * the fleet hit three times on 2026-09-01: a hand-carried total, a stale note,
 * and a change log that was present and said nothing. A control that works
 * correctly and is never heard is not a control.
 *
 * So: three consecutive failures raise an inter-agent alert to the main agent,
 * and a persistent outage re-alerts hourly instead of either going quiet or
 * repeating every ten minutes.
 *
 * NOT time-windowed, deliberately. A failed rescue is rare; three of them with
 * no success in between is a signal whether they took thirty minutes or three
 * days. The counter clears on the first rescue that succeeds.
 *
 * Kept IO-free and separate from the runner so the escalation rule is testable
 * without the tmux/transcript machinery around it.
 */

/** Consecutive failures that raise the first alert. */
export const RESCUE_ALERT_AFTER = 3
/** While it keeps failing, repeat at most this often. */
export const RESCUE_REALERT_MS = 60 * 60_000

type Entry = { count: number; lastAlertMs: number }

const failures = new Map<string, Entry>()

/**
 * Record one failed rescue. Returns the new consecutive count and whether this
 * failure should raise an alert (the threshold crossing, or the hourly repeat).
 * Calling it is what advances the state, so call it exactly once per failure.
 */
export function recordRescueFailure(name: string, nowMs: number): { count: number; alert: boolean } {
  const prev = failures.get(name) ?? { count: 0, lastAlertMs: 0 }
  const count = prev.count + 1
  const alert = count === RESCUE_ALERT_AFTER
    || (count > RESCUE_ALERT_AFTER && nowMs - prev.lastAlertMs >= RESCUE_REALERT_MS)
  failures.set(name, { count, lastAlertMs: alert ? nowMs : prev.lastAlertMs })
  return { count, alert }
}

/** A rescue succeeded: the streak is over. */
export function clearRescueFailures(name: string): void {
  failures.delete(name)
}

/** Current consecutive-failure count (0 when the last rescue worked). */
export function rescueFailureCount(name: string): number {
  return failures.get(name)?.count ?? 0
}

/** Test-only: drop all counters so one test cannot leak into the next. */
export function __resetRescueFailures(): void {
  failures.clear()
}
