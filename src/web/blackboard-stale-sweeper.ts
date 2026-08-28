import { getActiveBlackboardAgentIds, getAgentTier, markBlackboardStale } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'

// Sweep runs every 5 minutes. Most thresholds are 60+ minutes so this gives
// at least 12 checks before the first possible mark -- acceptable precision.
const SWEEP_INTERVAL_MS = 5 * 60_000

const TIER_CONFIG_KEY: Record<string, string> = {
  orchestrator:    'BB_STALE_ORCHESTRATOR_MIN',
  interactive:     'BB_STALE_INTERACTIVE_MIN',
  'short-running': 'BB_STALE_SHORT_RUNNING_MIN',
  default:         'BB_STALE_DEFAULT_MIN',
}

function resolveThresholdSec(agentId: string): number {
  const tier = getAgentTier(agentId)
  const key = TIER_CONFIG_KEY[tier] ?? 'BB_STALE_DEFAULT_MIN'
  return (getEffectiveSettingValue(key) as number) * 60
}

export function startBlackboardStaleSweeper(): NodeJS.Timeout {
  const sweep = () => {
    try {
      const activeIds = getActiveBlackboardAgentIds()
      const thresholdsByAgent: Record<string, number> = {}
      for (const id of activeIds) {
        thresholdsByAgent[id] = resolveThresholdSec(id)
      }
      const defaultSec = resolveThresholdSec('__nonexistent__')
      const marked = markBlackboardStale(thresholdsByAgent, defaultSec)
      if (marked > 0) {
        logger.info({ marked }, 'blackboard-stale-sweeper: marked stale rows')
      }
    } catch (err) {
      logger.error({ err }, 'blackboard-stale-sweeper: sweep failed')
    }
  }
  return setInterval(sweep, SWEEP_INTERVAL_MS)
}
