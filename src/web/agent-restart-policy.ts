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
}

// Returns true only when a down-reporting agent should actually be restarted.
export function shouldAutoRestartDownAgent(input: AgentRestartDecisionInput): boolean {
  const { processAgeMs, msSinceLastRestart, startupGraceMs, restartGraceMs } = input
  // Unknown process age: the age probe failed. Be conservative and do not
  // restart -- a false "down" must never kill a healthy agent.
  if (!Number.isFinite(processAgeMs) || processAgeMs < 0) return false
  // Freshly started: the channel plugin may still be spawning.
  if (processAgeMs < startupGraceMs) return false
  // Recently restarted by the watchdog: give the new process time to come up.
  if (msSinceLastRestart !== null && msSinceLastRestart < restartGraceMs) return false
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
