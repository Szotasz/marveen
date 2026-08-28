import { markBlackboardStale } from '../db.js'
import { logger } from '../logger.js'

// Per-agent stale thresholds (seconds). Agents not listed use DEFAULT_THRESHOLD_SEC.
//
// Three classes per Rick's plan:
//   short-running (heartbeat / scheduled, done in minutes): 15 min
//   interactive   (multi-step, long sessions):               90 min
//   orchestrator  (Jarvis, coordinates the fleet):          120 min
//   default       (unknown agent, conservative):             60 min
const AGENT_THRESHOLDS: Record<string, number> = {
  // orchestrator
  jarvis: 120 * 60,
  // interactive
  rick:   90 * 60,
  zack:   90 * 60,
  boo:    90 * 60,
  dave:   90 * 60,
  // short-running: fetches data and produces a report, done in minutes
  peter:  15 * 60,
}
const DEFAULT_THRESHOLD_SEC = 60 * 60

// Sweep runs every 5 minutes. Most thresholds are 60+ minutes so this gives
// at least 12 checks before the first possible mark -- acceptable precision.
const SWEEP_INTERVAL_MS = 5 * 60_000

export function startBlackboardStaleSweeper(): NodeJS.Timeout {
  const sweep = () => {
    try {
      const marked = markBlackboardStale(AGENT_THRESHOLDS, DEFAULT_THRESHOLD_SEC)
      if (marked > 0) {
        logger.info({ marked }, 'blackboard-stale-sweeper: marked stale rows')
      }
    } catch (err) {
      logger.error({ err }, 'blackboard-stale-sweeper: sweep failed')
    }
  }
  return setInterval(sweep, SWEEP_INTERVAL_MS)
}
