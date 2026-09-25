/**
 * In-flight registry for MANAGED agent restarts (stop -> start as one unit).
 *
 * WHY THIS EXISTS. stopAgentProcess() sends `tmux kill-session` and then waits
 * ~2s for the teardown (plus a channel-orphan reap) before it returns. For that
 * whole window isAgentRunning(name) already reports FALSE while the restarter is
 * still mid-operation. Every other supervisor in the process polls exactly that
 * predicate and "helpfully" starts the agent it believes crashed -- with ITS
 * OWN options, not the restarter's.
 *
 * Measured on levente, 2026-08-31 (dashboard.log, two identical occurrences):
 *
 *   19:10:21.428  context-guard: acting  action=restart  reason="pane saturated
 *                 (100% context) for 2 sweeps -- unrecoverable without restart"
 *   19:10:22.761  WARN Desired agent not running -- auto-starting (reconcile)
 *   19:10:22.862  Agent tmux session started      <- the RECONCILE's start
 *   19:10:23.478  Agent tmux session stopped      <- the guard's stop returning
 *   19:15:30.691  WARN dispatch: refusing prompt -- session shows context
 *                 saturation (100% context)
 *   19:41:14.936  context-guard: acting  action=restart  (same reason -- loop)
 *
 * The guard asks for { fresh: true } precisely because a --continue resume
 * reloads the context that saturated the pane; the reconcile path calls
 * startAgentProcess(name) with no options, so a channel-less agent comes back
 * up on `--continue` and is saturated again the moment it boots. The guard's
 * own start then hits the "Agent is already running" early return, whose result
 * every caller was discarding: a rescue that reported success and rescued
 * nothing.
 *
 * The collision is NOT bad luck. The guard sweep runs at 270_000 + 300_000*k ms
 * and the channel monitor at 30_000 + 60_000*m ms; 300_000 % 60_000 === 0 and
 * both offsets are 30s past the minute, so the two loops are phase-locked and
 * EVERY guard restart lands inside a reconcile tick.
 *
 * Kept in its own IO-free module so the invariants are testable without the
 * tmux/filesystem machinery of agent-process.ts, and so a supervisor can import
 * the predicate without importing the restart implementation.
 */

const inFlight = new Set<string>()

/** True while a managed restart of `name` is between its stop and its start. */
export function isRestartInFlight(name: string): boolean {
  return inFlight.has(name)
}

/**
 * Claim the restart slot for `name`. Returns false when one is already in
 * flight, so a second restarter backs off instead of interleaving its own
 * stop/start with the first one's.
 */
export function beginRestart(name: string): boolean {
  if (inFlight.has(name)) return false
  inFlight.add(name)
  return true
}

/** Release the slot. MUST run in a finally: a leaked slot silently disables
 *  every liveness-driven auto-start for that agent for the life of the process. */
export function endRestart(name: string): void {
  inFlight.delete(name)
}

/** Test-only: drop all slots so one test's leak cannot fail the next. */
export function __resetRestartLock(): void {
  inFlight.clear()
}
