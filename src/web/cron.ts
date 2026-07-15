import { CronExpressionParser } from 'cron-parser'
import { APP_TZ } from '../config.js'

// All scheduled-task cron expressions (SKILL.md/task-config.json, the
// dashboard schedule editor) are authored in the operator's own wall-clock
// time -- "30 7 * * *" means 7:30 for the operator, not 7:30 on whatever
// timezone the host happens to boot in. cron-parser defaults to the PROCESS
// timezone when no `tz` is given, which silently diverges from the
// operator's zone whenever the host runs in a different one (e.g. a UTC
// server for a Budapest operator misfires cron by 1-2h). SCHEDULER_TZ lets
// each install pin its own IANA zone; unset falls back to the host's zone
// (Intl reflects the OS/TZ env at process start), matching the pre-fix
// behaviour for installs where host tz already equals the operator's.
//
// The trap that bit us 2026-07-13..15: when NEITHER SCHEDULER_TZ nor TZ is set
// in the process env, Intl resolves to UTC. Under a wrong zone a fixed-time
// cron ("30 7 * * *") has its prev() shifted by the UTC offset, so at the
// operator's 07:30 the previous occurrence is ~a day away and it never lands
// in the one-minute match window -- while interval crons ("*/15 * * * *")
// constrain only the minute field, stay tz-invariant, and keep firing. The
// result is a SILENT partial outage: heartbeats run, daily tasks never do.
// resolveCronTz reports which source won so the scheduler can log it loudly at
// startup instead of failing invisibly (see startScheduleRunner).
export type CronTzSource = 'SCHEDULER_TZ' | 'TZ' | 'system-default'

export function resolveCronTz(env: NodeJS.ProcessEnv = process.env): { tz: string; source: CronTzSource } {
  if (env.SCHEDULER_TZ) return { tz: env.SCHEDULER_TZ, source: 'SCHEDULER_TZ' }
  if (env.TZ) return { tz: env.TZ, source: 'TZ' }
  return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, source: 'system-default' }
}

// The effective zone is config.APP_TZ (SCHEDULER_TZ via config-overrides.json >
// .env > host zone), so a dashboard-set zone is honored and cron/display never
// diverge; resolveCronTz() above stays as the startup source-reporter (see
// startScheduleRunner) so the operator sees which layer won.
const CRON_TZ = APP_TZ

export function computeNextRun(cronExpression: string, tz: string = CRON_TZ): number {
  const expr = CronExpressionParser.parse(cronExpression, { tz })
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

// True if a scheduled occurrence of `cron` falls in the half-open window
// (fromMs, toMs]. Driven by the ACTUAL elapsed time between scheduler ticks
// rather than a fixed 60s window: Node timers only ever fire late (never
// early), so a fixed-width window equal to the nominal tick interval drifts
// until a sparse cron's single occurrence lands in a gap no tick's window
// covers -- silently missed for the day, while a "*/15" cron with 96 daily
// occurrences survives (the 2026-07-13..15 outage). Feeding the real
// (previous-tick, now] interval makes the windows contiguous and
// non-overlapping: every occurrence is covered by exactly one tick, so even a
// multi-minute tick gap cannot swallow a daily task. prev() returns only the
// most recent occurrence, so a long outage yields at most one catch-up fire,
// never a burst.
export function cronDueBetween(cron: string, fromMs: number, toMs: number, tz: string = CRON_TZ): boolean {
  try {
    // `toMs + 1`: cron-parser's prev() returns the last occurrence STRICTLY
    // before currentDate, so an occurrence landing exactly on the tick boundary
    // (O === toMs) would be excluded here AND excluded next tick (O === fromMs,
    // the `> fromMs` is strict) -- a rare "silently lost" occurrence. Nudging
    // currentDate one ms past toMs makes the window a true half-open (fromMs,
    // toMs], so a boundary occurrence fires exactly once, never twice.
    const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) })
    return expr.prev().getTime() > fromMs
  } catch {
    return false
  }
}

// Back-compat shim faithful to the old fixed-window semantics -- "did an
// occurrence happen in the last catchUpMs". Kept for callers/tests that ask
// the question that way; the scheduler loop itself uses cronDueBetween with
// the real inter-tick interval.
export function cronMatchesNow(cron: string, catchUpMs: number = 60000, tz: string = CRON_TZ): boolean {
  const now = Date.now()
  return cronDueBetween(cron, now - catchUpMs, now, tz)
}
