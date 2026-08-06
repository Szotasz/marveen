import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeCatchUpWindow,
  NORMAL_CATCH_UP_MS,
  QUIET_BAND_END_HOUR,
  QUIET_BAND_START_HOUR,
  TICK_GAP_THRESHOLD_MS,
} from '../web/cron.js'

// Tests for the tick-gap catch-up window (host-suspend replay).
//
// Reference scenario (laptop/WSL-class host): the machine sleeps 06:00-09:05
// while the dashboard process -- the schedule runner's host -- stays alive the
// whole time. No restart, so the persisted-stamp cold-start path never arms;
// the scan window is contiguous with the previous tick, so on resume the
// runner scans three hours of schedule in one go. Nothing is lost, but
// everything comes back at once -- and the same shape shifted into the night
// would push every occurrence still inside its staleness budget, plus a
// missed-slot report for the rest, into a sleeping operator's chat at 03:00.
//
// Everything time-dependent is injected, so nothing here depends on the clock
// or the timezone of the machine running the suite.

const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

const TZ = 'Europe/Budapest'
const MIN = 60_000
const HOUR = 60 * MIN

// Europe/Budapest is UTC+2 in July (CEST). Local wall-clock is written in the
// helper names; the ISO strings stay UTC so the fixtures are unambiguous.
const at = (iso: string): number => Date.parse(iso)

const SUMMER_RESUME_0905 = at('2026-07-31T07:05:00.000Z') // 09:05 local
const SUMMER_LASTTICK_0600 = at('2026-07-31T04:00:00.000Z') // 06:00 local
const SUMMER_GAP_MS = SUMMER_RESUME_0905 - SUMMER_LASTTICK_0600 // 3h05m

describe('computeCatchUpWindow: gap detection', () => {
  it('(d) a sub-threshold gap keeps the normal one-tick window', () => {
    const now = at('2026-07-31T12:00:00.000Z') // 14:00 local
    const w = computeCatchUpWindow(now, now - 4 * MIN, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(false)
    expect(w.gapMs).toBe(4 * MIN)
  })

  it('a gap of EXACTLY the threshold is still ordinary jitter, one ms more is a gap', () => {
    const now = at('2026-07-31T12:00:00.000Z') // 14:00 local
    expect(computeCatchUpWindow(now, now - TICK_GAP_THRESHOLD_MS, TZ).gapResume).toBe(false)
    expect(computeCatchUpWindow(now, now - TICK_GAP_THRESHOLD_MS - 1, TZ).gapResume).toBe(true)
  })

  it('(a) a daytime gap between two daytime ticks yields exactly the gap', () => {
    const lastTick = at('2026-07-31T11:00:00.000Z') // 13:00 local
    const now = at('2026-07-31T12:30:00.000Z') // 14:30 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.gapResume).toBe(true)
    expect(w.quietSkipped).toBe(false)
    expect(w.gapMs).toBe(90 * MIN)
    // The whole gap is outside the band, so the runner's window is unchanged.
    expect(w.catchUpMs).toBe(90 * MIN)
  })

  it('daytime suspend: a 06:00 -> 09:05 resume gets a 3h05m window', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, SUMMER_LASTTICK_0600, TZ)
    expect(w.gapResume).toBe(true)
    expect(w.gapMs).toBe(SUMMER_GAP_MS)
    expect(w.catchUpMs).toBe(SUMMER_GAP_MS)
  })

  it('no previous tick (first tick of the process) means no gap window', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, null, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.gapMs).toBe(0)
  })
})

describe('computeCatchUpWindow: quiet band', () => {
  it('(b) a gap spanning the night is clipped at the local band end, not replayed whole', () => {
    const lastTick = at('2026-07-30T21:00:00.000Z') // 23:00 local, previous day
    const now = at('2026-07-31T07:00:00.000Z') // 09:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.gapMs).toBe(10 * HOUR)
    // Reaches back to 06:00 local only -- the 23:00-06:00 slots stay missed.
    expect(w.catchUpMs).toBe(3 * HOUR)
    expect(w.gapResume).toBe(true)
    expect(w.quietSkipped).toBe(false)
  })

  it('(c) waking INSIDE the quiet band performs no catch-up at all', () => {
    const lastTick = at('2026-07-30T20:30:00.000Z') // 22:30 local
    const now = at('2026-07-31T01:00:00.000Z') // 03:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(true)
    expect(w.gapMs).toBe(4.5 * HOUR)
  })

  it('the band closes at 22:00 local and opens at 06:00 local', () => {
    const gap = (nowIso: string) =>
      computeCatchUpWindow(at(nowIso), at(nowIso) - 2 * HOUR, TZ)
    expect(QUIET_BAND_START_HOUR).toBe(22)
    expect(QUIET_BAND_END_HOUR).toBe(6)
    // 21:59 local -- still a working hour, catch-up allowed.
    expect(gap('2026-07-31T19:59:00.000Z').quietSkipped).toBe(false)
    // 22:00 local sharp -- quiet.
    expect(gap('2026-07-31T20:00:00.000Z').quietSkipped).toBe(true)
    // 05:59 local -- quiet.
    expect(gap('2026-07-31T03:59:00.000Z').quietSkipped).toBe(true)
    // 06:00 local sharp -- open again (though the window is clipped to ~0).
    expect(gap('2026-07-31T04:00:00.000Z').quietSkipped).toBe(false)
  })

  it('waking just past 06:00 collapses back to the normal window, not a catch-up tick', () => {
    const now = at('2026-07-31T04:00:30.000Z') // 06:00:30 local
    const lastTick = at('2026-07-31T03:00:00.000Z') // 05:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    // Only 30s of the gap is outside the quiet band -> nothing was enlarged.
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(false)
  })

  it('the band end is derived from local wall-clock, so CET and CEST behave alike', () => {
    // Same 06:00 -> 09:05 shape in January (Europe/Budapest is UTC+1 then).
    const now = at('2026-01-15T08:05:00.000Z') // 09:05 local
    const lastTick = at('2026-01-15T05:00:00.000Z') // 06:00 local
    const w = computeCatchUpWindow(now, lastTick, TZ)
    expect(w.catchUpMs).toBe(SUMMER_GAP_MS)
    expect(w.gapResume).toBe(true)
  })

  it('an unusable timezone fails SAFE (no catch-up) instead of throwing', () => {
    const w = computeCatchUpWindow(SUMMER_RESUME_0905, SUMMER_LASTTICK_0600, 'Not/AZone')
    expect(w.catchUpMs).toBe(NORMAL_CATCH_UP_MS)
    expect(w.gapResume).toBe(false)
    expect(w.quietSkipped).toBe(true)
  })
})

// The two invariants the band-clipped window rests on. Verified against the
// real cron matcher rather than assumed, because both are the difference
// between "catch up once" and "replay three hours".
describe('a gap window fires ONCE and never reaches behind the band edge', () => {
  let cron: typeof import('../web/cron.js')

  beforeAll(async () => {
    // cron.ts freezes CRON_TZ at import from SCHEDULER_TZ (or the host zone),
    // so pin the zone and re-import to keep this suite host-independent.
    vi.stubEnv('SCHEDULER_TZ', TZ)
    vi.resetModules()
    cron = await import('../web/cron.js')
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  beforeEach(() => {
    vi.useFakeTimers()
    // 09:07:31 local, deliberately OFF the */5 boundary: the contiguous
    // half-open (from, now] window (#621 + boundary nudge) makes a
    // boundary-exact occurrence match the NORMAL window too -- that fire is
    // on-time, not swallowed, so probing there would test the wrong premise.
    vi.setSystemTime(new Date(SUMMER_RESUME_0905 + 151_000))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cronMatchesNow is a boolean "was the last occurrence inside the window", not an enumeration', () => {
    // A 5-minute heartbeat had 37 of its slots inside the 3h05m sleep. The
    // matcher still answers with a single boolean, and the runner does one
    // attemptFireTask per matching task per tick -- so 37 missed slots become
    // exactly one fire, never 37 prompts dumped into the session.
    const match = cron.cronMatchesNow('*/5 6-21 * * *', SUMMER_GAP_MS)
    expect(typeof match).toBe('boolean')
    expect(match).toBe(true)
  })

  it('slots swallowed by the sleep match the gap window but not the normal one', () => {
    for (const schedule of [
      '*/5 6-21 * * *', // short-cadence heartbeat
      '*/15 6-21 * * *', // quarter-hourly heartbeat
      '30 7 * * *', // morning briefing
      '0 8 * * *', // daily audit
      '15 8 * * *', // daily backup upload
      '0 9 * * *', // daily token health check
    ]) {
      expect(cron.cronMatchesNow(schedule, SUMMER_GAP_MS)).toBe(true)
      // Not matched by the normal window -> the runner stamps it 'fired_late'.
      expect(cron.cronMatchesNow(schedule, NORMAL_CATCH_UP_MS)).toBe(false)
    }
  })

  it('a slot the PREVIOUS tick already fired falls outside the new window', () => {
    // The window starts at the later of the previous tick and the band edge, so
    // any slot that tick could have matched is >= catchUpMs old and cannot match
    // again. This is what makes a false gap-resume harmless: if a slow tick
    // (rather than a real suspend) trips the threshold, the window still only
    // picks up slots that genuinely went unserved.
    expect(cron.cronMatchesNow('0 6 * * *', SUMMER_GAP_MS)).toBe(false) // slot AT the last tick
    expect(cron.cronMatchesNow('59 5 * * *', SUMMER_GAP_MS)).toBe(false) // slot just before it
  })

  it('slots behind the band edge are not resurrected', () => {
    // An evening job that fired at 20:15 the previous day -- far outside a
    // window that is clipped at 06:00 local.
    expect(cron.cronMatchesNow('15 20 * * *', SUMMER_GAP_MS)).toBe(false)
    // A weekly job whose day is not today.
    expect(cron.cronMatchesNow('30 6 * * 3', SUMMER_GAP_MS)).toBe(false)
  })
})

// The runner guards a double fire with `lastRun >= occurrenceMs` -- anchored to
// the OCCURRENCE the selection gate picked, not to the scan-window start. (The
// window-start form skipped a genuinely new occurrence on any long-gap tick
// whenever the task had fired on the last healthy tick: fromMs IS that tick's
// timestamp, so `lastRun >= fromMs` held for a slot that had never run.) The
// boundary arithmetic is pinned here with the same expression the runner uses.
describe('the lastRun guard neither double-fires nor swallows a catch-up', () => {
  const OCC_0800 = at('2026-07-31T06:00:00.000Z') // 08:00 local, swallowed by the sleep
  const skippedByGuard = (lastRun: number, occurrenceMs: number): boolean =>
    lastRun >= occurrenceMs

  it('does not swallow a task whose last run was the last healthy tick', () => {
    // Worst case: the task fired on the very last tick before the host slept
    // (06:00). The swallowed 08:00 occurrence is NEWER, so the guard passes.
    expect(skippedByGuard(SUMMER_LASTTICK_0600, OCC_0800)).toBe(false)
  })

  it('cannot swallow anything that last ran before the gap started', () => {
    // Nothing fires while the host is asleep, so every lastRun is at or before
    // the gap start -- always older than an occurrence inside the sleep.
    for (const minutesBeforeGap of [0, 1, 30, 24 * 60]) {
      const lastRun = SUMMER_LASTTICK_0600 - minutesBeforeGap * MIN
      expect(skippedByGuard(lastRun, OCC_0800)).toBe(false)
    }
  })

  it('still blocks a later tick from re-firing the caught-up occurrence', () => {
    // The catch-up fire stamps lastRun with the resume tick time, which is at
    // or after the swallowed occurrence -- so re-scanning it cannot re-fire.
    expect(skippedByGuard(SUMMER_RESUME_0905, OCC_0800)).toBe(true)
  })

  it('yet the NEXT genuine occurrence still fires on its own tick', () => {
    // The property the old window-start guard could not express: a fresh
    // occurrence after the catch-up is newer than lastRun, so it passes.
    const OCC_0910 = at('2026-07-31T07:10:00.000Z') // 09:10 local
    expect(skippedByGuard(SUMMER_RESUME_0905, OCC_0910)).toBe(false)
  })

  it('the runner still uses that exact guard expression', () => {
    // If this drifts, the arithmetic above stops describing production.
    expect(RUNNER_SRC).toMatch(/if \(lastRun >= occurrenceMs\) continue/)
  })
})

describe('schedule-runner wiring', () => {
  it('keeps the previous tick time in the runner closure (in-memory by design)', () => {
    expect(RUNNER_SRC).toMatch(/let lastTickAt: number \| null = null/)
    // Stamped from the tick's own start time, immediately after the decision.
    expect(RUNNER_SRC).toMatch(/computeCatchUpWindow\(now, lastTickAt\)/)
    expect(RUNNER_SRC).toMatch(/lastTickAt = now/)
    // NOT persisted: the last-run map is the only runner state written to disk.
    expect(RUNNER_SRC).not.toMatch(/lastTickAt[\s\S]{0,80}atomicWriteFileSync/)
  })

  it('clamps the scan window only on a gap tick, never on the cold-start one', () => {
    // The cold-start window comes from the persisted tick stamp and is capped
    // there; clamping it here would silently shrink a legitimate downtime scan.
    expect(RUNNER_SRC).toMatch(
      /const fromMs = \(gap\.gapResume \|\| gap\.quietSkipped\)\s*\n\s*\? Math\.max\(lastCheckMs, now - catchUp\)\s*\n\s*: lastCheckMs/,
    )
  })

  it('marks gap-resume fires late too, not just cold-start ones', () => {
    // Lateness is occurrence-based (decideCatchUp over the same occurrence the
    // selection gate used), so any fire whose decision is 'catch-up' is recorded
    // late regardless of WHICH kind of tick (cold-start, gap-resume, dropped
    // tick) scanned it.
    const idx = RUNNER_SRC.indexOf('const lateCatchUpMs =')
    expect(idx).toBeGreaterThan(0)
    const expr = RUNNER_SRC.slice(idx, idx + 200)
    expect(expr).toMatch(/decision === 'catch-up'/)
  })

  it('logs the gap, the effective window and the catch-up fire count', () => {
    const idx = RUNNER_SRC.indexOf('if (gap.gapResume) {')
    expect(idx).toBeGreaterThan(0)
    const block = RUNNER_SRC.slice(idx, idx + 900)
    expect(block).toMatch(/logger\.info/)
    expect(block).toMatch(/gapMinutes/)
    expect(block).toMatch(/catchUpMinutes/)
    expect(block).toMatch(/catchUpFires/)
    // The quiet-band suppression is logged too -- a silent no-op is what made
    // the original incident invisible.
    expect(block).toMatch(/gap\.quietSkipped/)
  })
})
