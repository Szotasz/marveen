// Pure decision logic for the channel-plugin watchdog's agent auto-restart.
//
// Extracted from channel-monitor.ts so the restart guards are unit-testable
// without spawning processes or mocking the OS. The watchdog walks each
// agent's process tree to check whether the channel plugin (a `bun server.ts`
// grandchild) is alive; when it is not, it used to restart the agent
// immediately. That killed freshly-started agents whose plugin had simply not
// finished spawning yet -- a large-context model launched with --continue can
// take well over the 30s first-probe window to bring the plugin up, so the
// watchdog saw "down", restarted, and looped forever. The startup grace below
// gives a young process time to finish coming up before any restart.

export interface AgentRestartDecisionInput {
  // How long the agent's claude process has been running, in milliseconds.
  // Pass a negative value when the age could not be determined; the policy
  // then errs on the side of NOT restarting.
  processAgeMs: number
  // Milliseconds since the watchdog last restarted this agent, or null when
  // it has never restarted it (e.g. the process was started by boot or by an
  // operator action rather than the watchdog).
  msSinceLastRestart: number | null
  // A young process is still bringing its channel plugin up; do not restart
  // until it is at least this old.
  startupGraceMs: number
  // After the watchdog restarts an agent, give the new process at least this
  // long to come up before considering another restart.
  restartGraceMs: number
  // Consecutive watchdog restarts that did NOT bring the plugin back up. Each
  // failure doubles the effective restart grace (exponential back-off), so a
  // perpetually-failing plugin (e.g. a broken third-party channel plugin that
  // crashes on every launch) is retried ever less often instead of churning at
  // the fixed grace forever -- which restarts the WHOLE agent every few minutes
  // and renders it unusable. Reset to 0 by the caller once the plugin recovers.
  // 0 / omitted preserves the original fixed-grace behaviour.
  consecutiveFailures?: number
  // Upper bound on the backed-off restart grace, so the watchdog still retries a
  // long-down plugin occasionally (it may recover after an external fix) rather
  // than backing off unboundedly. Omitted = no cap beyond the exponent.
  maxRestartGraceMs?: number
  // True when the agent's TUI has SETTLED at the idle prompt -- i.e. it finished
  // cold-starting. A still-absent channel poller on a settled pane is a
  // definitive flaky-load miss (the bun poller attaches within ~10s when it
  // works), NOT a slow boot, so it is safe to relaunch without waiting out the
  // full startup grace. Omitted/false keeps the conservative startupGraceMs.
  paneSettled?: boolean
  // Shorter startup grace to apply when paneSettled is true. Must still exceed
  // the healthy plugin-attach window (~10s) so we never relaunch an agent that
  // was about to come up. Only ever SHORTENS the grace (min with startupGraceMs);
  // a value above startupGraceMs is ignored. Omitted = no fast path.
  fastRetryGraceMs?: number
  // Number of early failures that retry at the BASE restart grace before the
  // exponential back-off kicks in. The common flaky-load case converges in ~2-3
  // fresh relaunches, so doubling from the first failure needlessly slows it.
  // Omitted/0 = original behaviour (double from the first failure). The cap and
  // unbounded back-off for a genuinely-broken plugin are unchanged.
  freeFastRetries?: number
}

// The restart grace after applying exponential back-off for repeated failed
// restarts. Each consecutive failure doubles the base grace, capped (when a cap
// is given) so retries continue at a bounded floor frequency. Exported for unit
// tests and so the caller can log the effective interval.
export function effectiveRestartGraceMs(
  restartGraceMs: number,
  consecutiveFailures: number,
  maxRestartGraceMs?: number,
  freeFastRetries?: number,
): number {
  const failures = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
    ? Math.floor(consecutiveFailures)
    : 0
  const free = Number.isFinite(freeFastRetries) && (freeFastRetries as number) > 0
    ? Math.floor(freeFastRetries as number)
    : 0
  // The first `free` failures retry at the base grace (no doubling); the
  // exponent only grows once those are spent. Cap it well below the point
  // where 2^n overflows Number range.
  const exp = Math.min(Math.max(failures - free, 0), 30)
  let grace = restartGraceMs * 2 ** exp
  if (maxRestartGraceMs != null && Number.isFinite(maxRestartGraceMs)) {
    grace = Math.min(grace, maxRestartGraceMs)
  }
  return grace
}

// Returns true only when a down-reporting agent should actually be restarted.
export function shouldAutoRestartDownAgent(input: AgentRestartDecisionInput): boolean {
  const { processAgeMs, msSinceLastRestart, startupGraceMs, restartGraceMs } = input
  // Unknown process age: the age probe failed. Be conservative and do not
  // restart -- a false "down" must never kill a healthy agent.
  if (!Number.isFinite(processAgeMs) || processAgeMs < 0) return false
  // Freshly started: the channel plugin may still be spawning. A SETTLED pane
  // (idle prompt reached) proves the cold-start finished, so a still-absent
  // poller is a definitive flaky-load miss, not a slow boot -- use the shorter
  // fast-retry grace there instead of waiting out the full startup grace. The
  // fast grace can only SHORTEN the window (min), never lengthen it.
  const fastEligible =
    input.paneSettled === true && Number.isFinite(input.fastRetryGraceMs) && (input.fastRetryGraceMs as number) >= 0
  const effectiveStartupGrace = fastEligible
    ? Math.min(startupGraceMs, input.fastRetryGraceMs as number)
    : startupGraceMs
  if (processAgeMs < effectiveStartupGrace) return false
  // Recently restarted by the watchdog: give the new process time to come up,
  // backed off exponentially for repeated failed restarts so a plugin that can
  // never come up is not restarted on a fixed short cadence forever. The first
  // `freeFastRetries` failures stay at the base grace so the common flaky-load
  // case (converges in ~2-3 relaunches) is not slowed by doubling. On a SETTLED
  // pane the relaunch window itself shrinks to the fast grace too -- a booted,
  // deaf agent has already missed, so there is nothing to wait for between
  // relaunches either. The exponential back-off (and its cap) still apply once
  // the free retries are spent, so a genuinely-broken plugin cannot churn.
  const restartBase = fastEligible
    ? Math.min(restartGraceMs, input.fastRetryGraceMs as number)
    : restartGraceMs
  const grace = effectiveRestartGraceMs(
    restartBase,
    input.consecutiveFailures ?? 0,
    input.maxRestartGraceMs,
    input.freeFastRetries,
  )
  if (msSinceLastRestart !== null && msSinceLastRestart < grace) return false
  return true
}

// Parse the elapsed-time string from `ps -o etime=` into seconds.
// Format is `[[dd-]hh:]mm:ss` on both BSD (macOS) and procps (Linux):
//   "05:23"        -> 323
//   "01:05:23"     -> 3923
//   "2-03:04:05"   -> 183845
// Returns -1 for anything it cannot parse.
export function parseEtimeToSeconds(etime: string): number {
  // Match exactly the documented shapes and nothing else, so malformed input
  // (empty segments, a leading '-', stray colons) falls through to -1 instead
  // of coercing through Number('') === 0 into a bogus duration.
  // The day count only appears together with an hours field, so days and hours
  // share one optional group: this matches MM:SS, HH:MM:SS and DD-HH:MM:SS but
  // rejects shapes ps never emits (e.g. DD-MM:SS).
  const m = etime.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/)
  if (!m) return -1
  const days = m[1] ? Number(m[1]) : 0
  const hours = m[2] ? Number(m[2]) : 0
  const minutes = Number(m[3])
  const seconds = Number(m[4])
  if (minutes > 59 || seconds > 59) return -1
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}
