import { CronExpressionParser } from 'cron-parser'

export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression)
  return Math.floor(expr.next().getTime() / 1000)
}

// Accept 5-field (standard) and 6-field (with seconds) cron expressions;
// cron-parser supports both. Anything else -- oversized strings, random
// punctuation, empty fields -- gets rejected at the API boundary instead
// of reaching the parser deep inside the scheduler loop.
export const CRON_SHAPE_RX = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/

export function isValidCronShape(cron: unknown): cron is string {
  if (typeof cron !== 'string') return false
  const trimmed = cron.trim()
  if (!trimmed || trimmed.length > 100) return false
  if (!CRON_SHAPE_RX.test(trimmed)) return false
  try {
    const expr = CronExpressionParser.parse(trimmed)
    expr.next()
    return true
  } catch {
    return false
  }
}

export function cronMatchesNow(cron: string, catchUpMs: number = 60000): boolean {
  try {
    const expr = CronExpressionParser.parse(cron)
    const prev = expr.prev()
    const prevTime = prev.getTime()
    const now = Date.now()
    return (now - prevTime) < catchUpMs
  } catch {
    return false
  }
}
