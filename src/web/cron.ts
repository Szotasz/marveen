import { CronExpressionParser } from 'cron-parser'

// All scheduled-task cron expressions (SKILL.md/task-config.json, the
// dashboard schedule editor) are authored in Budapest wall-clock time -- "30
// 7 * * *" means 7:30 for Ricsi, not 7:30 on whatever timezone the host
// happens to boot in. cron-parser defaults to the PROCESS timezone when no
// `tz` is given; on this host that's UTC, so every schedule silently fired
// 2h late in summer (CEST, UTC+2) / 1h late in winter (CET, UTC+1) until this
// was pinned. Matches the 'Europe/Budapest' literal already used for display
// formatting elsewhere (db.ts, heartbeat.ts).
const CRON_TZ = 'Europe/Budapest'

export function computeNextRun(cronExpression: string): number {
  const expr = CronExpressionParser.parse(cronExpression, { tz: CRON_TZ })
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
    const expr = CronExpressionParser.parse(trimmed, { tz: CRON_TZ })
    expr.next()
    return true
  } catch {
    return false
  }
}

export function cronMatchesNow(cron: string, catchUpMs: number = 60000): boolean {
  try {
    const expr = CronExpressionParser.parse(cron, { tz: CRON_TZ })
    const prev = expr.prev()
    const prevTime = prev.getTime()
    const now = Date.now()
    return (now - prevTime) < catchUpMs
  } catch {
    return false
  }
}
