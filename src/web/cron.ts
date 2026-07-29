import { CronExpressionParser } from 'cron-parser'
import { APP_TZ, SCHEDULER_TZ_CONFIGURED } from '../config.js'

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

// The reporter MUST resolve over the same layers APP_TZ does, or it lies about
// the very thing it exists to surface. The earlier env-only version read
// process.env directly and so diverged in both directions:
//
//  - FALSE ALARM: SCHEDULER_TZ set in .env (or config-overrides.json) never
//    reaches process.env, so it reported system-default/UTC and fired the
//    "fell back to UTC" warning while CRON_TZ was already the operator zone.
//    An operator who had correctly configured the install was told, on every
//    boot, that scheduling was broken.
//  - MISSED ALARM: SCHEDULER_TZ exported into process.env is NOT read by
//    cfg() (which layers config-overrides.json over .env), so APP_TZ stayed on
//    the host zone -- yet the reporter announced 'SCHEDULER_TZ' and suppressed
//    the warning, hiding a real misconfiguration.
//
// Hence `configuredTz` comes from the config layer (config.SCHEDULER_TZ_CONFIGURED)
// and the host zone is passed in, mirroring `APP_TZ = cfg('SCHEDULER_TZ') || Intl`
// branch for branch. Kept pure so both directions are testable without env
// mutation; effectiveCronTz() below binds the real values.
export function resolveCronTz(
  configuredTz: string | undefined,
  env: NodeJS.ProcessEnv,
  systemTz: string,
): { tz: string; source: CronTzSource } {
  if (configuredTz) return { tz: configuredTz, source: 'SCHEDULER_TZ' }
  // Below this point APP_TZ is the host zone either way; env.TZ only explains
  // WHY the host zone is what it is, so the tz reported stays `systemTz`.
  if (env.TZ) return { tz: systemTz, source: 'TZ' }
  return { tz: systemTz, source: 'system-default' }
}

// The effective zone is config.APP_TZ (SCHEDULER_TZ via config-overrides.json >
// .env > host zone), so a dashboard-set zone is honored and cron/display never
// diverge; effectiveCronTz() below is the startup source-reporter (see
// startScheduleRunner) so the operator sees which layer won.
const CRON_TZ = APP_TZ

export function effectiveCronTz(): { tz: string; source: CronTzSource } {
  return resolveCronTz(
    SCHEDULER_TZ_CONFIGURED,
    process.env,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
}

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
  return cronPrevOccurrence(cron, fromMs, toMs, tz) != null
}

// The occurrence time itself, or null when none falls in (fromMs, toMs]. The
// boolean form above answers "is it due"; the catch-up path additionally needs
// "HOW LATE is it" -- an occurrence missed 4 minutes ago (a dropped tick) and
// one missed 9 hours ago (the host was powered off) are the same `true` but
// call for opposite decisions, see decideCatchUp in schedule-runner.
export function cronPrevOccurrence(cron: string, fromMs: number, toMs: number, tz: string = CRON_TZ): number | null {
  try {
    // `toMs + 1`: cron-parser's prev() returns the last occurrence STRICTLY
    // before currentDate, so an occurrence landing exactly on the tick boundary
    // (O === toMs) would be excluded here AND excluded next tick (O === fromMs,
    // the `> fromMs` is strict) -- a rare "silently lost" occurrence. Nudging
    // currentDate one ms past toMs makes the window a true half-open (fromMs,
    // toMs], so a boundary occurrence fires exactly once, never twice.
    const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) })
    const prev = expr.prev().getTime()
    return prev > fromMs ? prev : null
  } catch {
    return null
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
