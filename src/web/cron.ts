import { CronExpressionParser } from 'cron-parser'
import { APP_TZ, SCHEDULER_TZ_CONFIGURED, usableHostTz } from '../config.js'

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
    // The host zone APP_TZ actually uses (UTC when the raw one is unusable),
    // so the startup report names the zone in effect, not one config.ts refused.
    usableHostTz(),
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
    // Fast path (every ordinary day): no UTC-offset change within 3h before the
    // window or inside it, so wall-clock time and real time agree and the plain
    // prev() below is exact. 3h covers the longest repeated hour plus margin,
    // see dstCronPrevOccurrence.
    if (tzOffsetMs(fromMs - DST_LOOKBACK_MS, tz) !== tzOffsetMs(toMs, tz)) {
      const dst = dstCronPrevOccurrence(cron, fromMs, toMs, tz)
      if (dst !== undefined) return dst
    }
    return plainPrevOccurrence(cron, fromMs, toMs, tz)
  } catch {
    return null
  }
}

function plainPrevOccurrence(cron: string, fromMs: number, toMs: number, tz: string): number | null {
  // `toMs + 1`: cron-parser's prev() returns the last occurrence STRICTLY
  // before currentDate, so an occurrence landing exactly on the tick boundary
  // (O === toMs) would be excluded here AND excluded next tick (O === fromMs,
  // the `> fromMs` is strict) -- a rare "silently lost" occurrence. Nudging
  // currentDate one ms past toMs makes the window a true half-open (fromMs,
  // toMs], so a boundary occurrence fires exactly once, never twice.
  const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) })
  const prev = expr.prev().getTime()
  return prev > fromMs ? prev : null
}

// ---- DST handling (card 59458fb6) ------------------------------------------
//
// cron-parser matches wall-clock time but hands back UTC instants, and prev()
// (the direction the runner uses) does not collapse the autumn repeated hour
// (CronExpression.js: `isDstEnd && !reverse`). Measured 2026-10-25, Budapest:
//  - autumn: "7 2 * * *" has two instants (00:07Z = 02:07 CEST and 01:07Z =
//    02:07 CET), each in its own tick window, so the task fired twice;
//  - spring: "30 2 * * *" has NO instant on 2027-03-28 (02:30 does not exist),
//    so the task was skipped for the day while next() promised 03:30.
//
// Policy, only for wall-clock-anchored crons (the hour field does not cover all
// 24 hours: "7 2 * * *", "*/30 2 * * *"; see isWallClockAnchored):
//  - autumn: a slot fires once, at its FIRST occurrence; the repeated second
//    occurrence maps back onto the first and is dropped if that already passed;
//  - spring: a slot that falls into the skipped local interval fires once, at
//    the transition instant (03:00 CEST), the first valid moment afterwards.
// Interval crons ("*/30 * * * *", "0 * * * *") keep plain elapsed-time
// semantics: both real passes of the repeated hour fire, nothing is made up in
// spring. Tip, not verified offline: cronie/Vixie cron makes the same
// anchored/interval split (it looks at a leading `*` in the minute/hour fields).
//
// Stateless on purpose: slot identity comes from the zone data, so a restart
// cannot lose or double a slot. Accepted limit: on a cold start (no tick state)
// inside the repeated hour, if the first pass was missed the second pass does
// not fire either -- a skipped run beats a doubled non-idempotent one.

const DST_LOOKBACK_MS = 3 * 60 * 60 * 1000
// Bound of the candidate walk: a "* 2 * * *" cron has up to 120 candidates in
// the repeated hour and its neighbours; this keeps the loop finite regardless.
const DST_MAX_CANDIDATES = 400

const tzFormatters = new Map<string, Intl.DateTimeFormat>()

// Wall-clock reading of `ms` in `tz`, expressed as if it were UTC ("naive"
// time). Seconds resolution: sub-second ms are truncated.
export function naiveWallMs(ms: number, tz: string): number {
  let fmt = tzFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    tzFormatters.set(tz, fmt)
  }
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
}

function tzOffsetMs(ms: number, tz: string): number {
  return naiveWallMs(ms, tz) - Math.floor(ms / 1000) * 1000
}

// UTC offset of `tz` at `ms`, in minutes (+120 for Budapest in summer).
export function tzOffsetMinutes(ms: number, tz: string): number {
  return tzOffsetMs(ms, tz) / 60000
}

// A cron is wall-clock anchored when its hour field leaves some hours out, so
// it names fixed times of day. Read off the parsed value set, not the text, so
// 6-field and @alias forms behave (`@daily` -> anchored, `@hourly` -> not).
export function isWallClockAnchored(cron: string): boolean {
  try {
    return CronExpressionParser.parse(cron).fields.hour.values.length < 24
  } catch {
    return false
  }
}

// If `candidateMs` is the second pass of a repeated local hour, the instant of
// the first pass with the same wall-clock reading; otherwise `candidateMs`.
function firstPassOf(candidateMs: number, tz: string): number {
  const offNow = tzOffsetMs(candidateMs, tz)
  const back = tzOffsetMs(candidateMs - DST_LOOKBACK_MS, tz) - offNow
  if (back <= 0) return candidateMs
  const earlier = candidateMs - back
  return naiveWallMs(earlier, tz) === naiveWallMs(candidateMs, tz) ? earlier : candidateMs
}

// Smallest instant in (fromMs, toMs] whose offset equals the offset at toMs,
// given that the offset at fromMs is different (a single transition inside).
function transitionInstant(fromMs: number, toMs: number, tz: string): number {
  const target = tzOffsetMs(toMs, tz)
  let lo = fromMs
  let hi = toMs
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (tzOffsetMs(mid, tz) === target) hi = mid
    else lo = mid
  }
  return hi
}

// Spring: the transition instant T inside (fromMs, toMs] when the cron has a
// slot in the local interval the jump skipped, else null. The check runs on the
// naive time axis (tz 'UTC'), where the skipped interval exists and the local
// date/day-of-week fields apply as the operator wrote them.
function springCatchUp(cron: string, fromMs: number, toMs: number, tz: string): number | null {
  const offFrom = tzOffsetMs(fromMs, tz)
  const offTo = tzOffsetMs(toMs, tz)
  if (offTo <= offFrom) return null
  const t = transitionInstant(fromMs, toMs, tz)
  const naiveT = naiveWallMs(t, tz)
  try {
    const slot = CronExpressionParser.parse(cron, { tz: 'UTC', currentDate: new Date(naiveT) }).prev().getTime()
    return slot >= naiveT - (offTo - offFrom) ? t : null
  } catch {
    // No earlier occurrence at all (e.g. a one-off year-bound cron): no slot to make up.
    return null
  }
}

// The DST-aware answer for a window that has an offset change in or just before
// it. undefined = not applicable (interval cron): the caller uses plain prev().
function dstCronPrevOccurrence(cron: string, fromMs: number, toMs: number, tz: string): number | null | undefined {
  if (!isWallClockAnchored(cron)) return undefined

  // Autumn: walk prev() candidates newest-first; the first whose first-pass
  // instant is still inside the window wins. A dropped candidate (its first pass
  // fired in an earlier window) does not end the search: an older candidate may
  // still be a valid slot inside the window.
  let best: number | null = null
  const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) })
  for (let i = 0; i < DST_MAX_CANDIDATES; i++) {
    let candidate: number
    try {
      candidate = expr.prev().getTime()
    } catch {
      break
    }
    if (candidate <= fromMs) break
    const first = firstPassOf(candidate, tz)
    if (first > fromMs) {
      best = first
      break
    }
  }

  const spring = springCatchUp(cron, fromMs, toMs, tz)
  if (spring != null && (best == null || spring > best)) best = spring
  return best
}

// The tightest gap between consecutive occurrences of a schedule, sampled over
// the next `samples` occurrences after `fromMs`: "how soon can the next one
// come at best". The minimum, not the next gap, because a schedule like
// `0 8,12,16,20 * * *` alternates 4 h and 12 h gaps and an answer that depends
// on the time of day would make every consumer flap. null when the expression
// does not parse or yields fewer than two occurrences.
export function cronMinGapMs(cron: string, fromMs: number, samples: number = 8, tz: string = CRON_TZ): number | null {
  try {
    const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(fromMs) })
    let prev = expr.next().getTime()
    let min: number | null = null
    for (let i = 1; i < Math.max(2, samples); i++) {
      const next = expr.next().getTime()
      const gap = next - prev
      if (gap > 0 && (min == null || gap < min)) min = gap
      prev = next
    }
    return min
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
