import { logger } from './logger.js'

// The first sweep is deferred because prune/checkpoint/VACUUM is synchronous
// database work and startup must not wait for it; a minute is enough for agents
// and the UI to reconnect first. The 24 h cadence starts from the first sweep.
export const DECAY_FIRST_SWEEP_DELAY_MS = 60_000

export function scheduleDecaySweep(
  run: () => void,
  intervalMs: number,
  firstDelayMs: number = DECAY_FIRST_SWEEP_DELAY_MS,
): () => void {
  let interval: NodeJS.Timeout | null = null
  let stopped = false
  const safeRun = () => {
    try { run() } catch (err) { logger.error({ err }, 'memory decay sweep failed') }
  }
  const first = setTimeout(() => {
    if (stopped) return
    safeRun()
    if (!stopped) interval = setInterval(safeRun, intervalMs)
  }, firstDelayMs)
  return () => {
    stopped = true
    clearTimeout(first)
    if (interval) clearInterval(interval)
    interval = null
  }
}
