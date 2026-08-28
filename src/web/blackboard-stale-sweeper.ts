import { markBlackboardStale } from '../db.js'
import { logger } from '../logger.js'

// Per-agent stale thresholds (seconds). Agents not listed use DEFAULT_THRESHOLD_SEC.
// Heartbeat/scheduled tasks update their rows every 15 minutes, so 15 min is
// tight -- use a 2x buffer. Interactive agents (90 min) and the orchestrator
// (120 min) have longer work cycles.
const AGENT_THRESHOLDS: Record<string, number> = {
  jarvis: 120 * 60,
  rick:   90 * 60,
  zack:   90 * 60,
  boo:    90 * 60,
  carmen: 90 * 60,
  dave:   90 * 60,
  peter:  90 * 60,
  poly:   90 * 60,
  vera:   90 * 60,
  zoe:    90 * 60,
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
