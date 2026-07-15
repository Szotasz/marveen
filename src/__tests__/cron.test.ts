import { describe, it, expect, vi, afterEach } from 'vitest'
import { cronMatchesNow, cronDueBetween, computeNextRun, resolveCronTz } from '../web/cron.js'

// Regression for the 2026-07-13..15 silent scheduler outage: fixed-time cron
// tasks (reggeli-napindito "30 7 * * *", dream-engine "7 2 * * *") stopped
// firing for days while the "*/15 * * * *" heartbeat kept running.
//
// TWO defects, both locked here:
//  1. Timezone fragility: cron parsing fell back to the process zone, which is
//     UTC when neither SCHEDULER_TZ nor TZ is set. Under UTC a fixed hour:minute
//     cron's occurrence is shifted by the UTC offset; interval crons constrain
//     only the minute field and stay tz-invariant. resolveCronTz makes the
//     resolution testable + the winning source observable.
//  2. Sparse-cron starvation (the actual incident): the matcher used a fixed
//     60s window while timers only ever fire late, so a daily cron's single
//     occurrence eventually landed in a gap no tick's window covered and was
//     silently missed -- while a 96-occurrence/day interval cron survived.
//     cronDueBetween scans the REAL (previous-tick, now] interval instead.

const TZ = 'Europe/Budapest' // CEST (UTC+2) on 2026-07-15, no DST transition

// 2026-07-15 07:30:00 CEST == 05:30:00 UTC
const ms = (utc: string) => Date.parse(utc)

describe('resolveCronTz source precedence', () => {
  it('prefers SCHEDULER_TZ over TZ', () => {
    expect(resolveCronTz({ SCHEDULER_TZ: 'Europe/Budapest', TZ: 'UTC' })).toEqual({
      tz: 'Europe/Budapest',
      source: 'SCHEDULER_TZ',
    })
  })

  it('falls back to TZ when SCHEDULER_TZ is absent', () => {
    expect(resolveCronTz({ TZ: 'Europe/Budapest' })).toEqual({ tz: 'Europe/Budapest', source: 'TZ' })
  })

  it('falls back to the system default when neither SCHEDULER_TZ nor TZ is set', () => {
    const r = resolveCronTz({})
    expect(r.source).toBe('system-default')
    expect(typeof r.tz).toBe('string')
    expect(r.tz.length).toBeGreaterThan(0)
  })
})

describe('cronDueBetween window semantics', () => {
  it('fires when a fixed-time occurrence falls inside the (from, to] window', () => {
    // 07:30 CEST occurrence, window 07:29:30 -> 07:31:00.
    expect(cronDueBetween('30 7 * * *', ms('2026-07-15T05:29:30Z'), ms('2026-07-15T05:31:00Z'), TZ)).toBe(true)
  })

  it('does not fire when no occurrence falls inside the window', () => {
    // window 07:31:00 -> 07:35:00: the 07:30 occurrence is before `from`.
    expect(cronDueBetween('30 7 * * *', ms('2026-07-15T05:31:00Z'), ms('2026-07-15T05:35:00Z'), TZ)).toBe(false)
  })

  it('is half-open on `from` (occurrence exactly at from does not re-fire)', () => {
    // occurrence exactly at 07:30:00 == from -> excluded, so the tick that
    // already scanned up to 07:30:00 will not fire it again.
    expect(cronDueBetween('30 7 * * *', ms('2026-07-15T05:30:00Z'), ms('2026-07-15T05:31:00Z'), TZ)).toBe(false)
  })

  it('is inclusive on `to` (occurrence exactly on the tick boundary fires exactly once)', () => {
    // Occurrence at 07:30:00 landing exactly on a tick timestamp must be caught
    // by THAT tick (window ...->07:30:00], not silently lost to the next one.
    expect(cronDueBetween('30 7 * * *', ms('2026-07-15T05:29:00Z'), ms('2026-07-15T05:30:00Z'), TZ)).toBe(true)
    // ...and the following tick (from == that boundary) must NOT re-fire it.
    expect(cronDueBetween('30 7 * * *', ms('2026-07-15T05:30:00Z'), ms('2026-07-15T05:31:00Z'), TZ)).toBe(false)
  })

  it('THE FIX: a fixed 60s window drops a straddled occurrence that (from, now] catches', () => {
    // Ticks at 07:29:30 and 07:31:00 (a 90s gap -- a late/dropped tick).
    const tickA = ms('2026-07-15T05:29:30Z')
    const tickB = ms('2026-07-15T05:31:00Z')
    // Old fixed-60s window ending at tickB is (07:30:00, 07:31:00] -> the
    // 07:30:00 occurrence sits on the excluded edge -> MISSED.
    expect(cronDueBetween('30 7 * * *', tickB - 60000, tickB, TZ)).toBe(false)
    // The contiguous window since the previous tick (07:29:30, 07:31:00] -> caught.
    expect(cronDueBetween('30 7 * * *', tickA, tickB, TZ)).toBe(true)
  })

  it('is timezone-aware: the same instant fires under Budapest but not under UTC', () => {
    const from = ms('2026-07-15T05:29:30Z')
    const to = ms('2026-07-15T05:31:00Z')
    expect(cronDueBetween('30 7 * * *', from, to, 'Europe/Budapest')).toBe(true)
    // Under UTC "30 7" means 07:30 UTC (09:30 CEST); nothing is due at 05:30 UTC.
    expect(cronDueBetween('30 7 * * *', from, to, 'UTC')).toBe(false)
  })
})

describe('sparse-cron starvation is fixed under realistic tick drift', () => {
  // Drive contiguous (previous-tick, now] windows exactly like the runner, with
  // ticks 61s apart (timers fire late, never early) across a full day. A daily
  // cron must fire EXACTLY once (not zero -> starvation, not twice -> double
  // fire); a */15 cron fires on every one of its occurrences.
  function simulate(cron: string, startUtc: string, hours: number, tickMs: number): number {
    const start = ms(startUtc)
    const end = start + hours * 3600 * 1000
    let lastCheck = start
    let fires = 0
    for (let now = start + tickMs; now <= end; now += tickMs) {
      if (cronDueBetween(cron, lastCheck, now, TZ)) fires++
      lastCheck = now
    }
    return fires
  }

  it('fires a daily cron exactly once over 24h despite 61s tick drift', () => {
    // Start at 00:00:30 CEST so the 07:30 occurrence is strictly interior.
    expect(simulate('30 7 * * *', '2026-07-14T22:00:30Z', 24, 61000)).toBe(1)
  })

  it('fires a twice-daily cron exactly twice over 24h despite drift', () => {
    expect(simulate('0 2,14 * * *', '2026-07-14T22:00:30Z', 24, 61000)).toBe(2)
  })

  it('fires a */15 interval cron on essentially every occurrence (tz-invariant survivor)', () => {
    // ~96 occurrences/day; the only ones not counted are the boundary
    // occurrences on the excluded `from` edge / past the final tick. The point
    // is that it is NOT starved -- contrast the single daily occurrence.
    expect(simulate('*/15 * * * *', '2026-07-14T22:00:30Z', 24, 61000)).toBeGreaterThanOrEqual(95)
  })

  it('a 3-minute tick gap still catches a daily occurrence (exactly once)', () => {
    // One coarse 180s tick straddling 07:30 must not swallow it.
    expect(simulate('30 7 * * *', '2026-07-14T22:00:30Z', 24, 180000)).toBe(1)
  })
})

describe('restart double-fire guard (runner logic)', () => {
  it('does not re-fire an occurrence already recorded before a restart', () => {
    // Task fired at 07:30:05. After a restart the window is re-seeded 30 min
    // back (07:05), which re-covers the 07:30 occurrence -- the guard
    // `lastRun >= fromMs` must suppress the duplicate.
    const lastRun = ms('2026-07-15T05:30:05Z')
    const fromMs = ms('2026-07-15T05:05:00Z') // now(07:35) - 30min
    const now = ms('2026-07-15T05:35:00Z')
    // The occurrence IS in the re-seeded window...
    expect(cronDueBetween('30 7 * * *', fromMs, now, TZ)).toBe(true)
    // ...but the guard sees it already ran this window and skips.
    expect(lastRun >= fromMs).toBe(true)
  })
})

describe('cronMatchesNow back-compat shim', () => {
  afterEach(() => vi.useRealTimers())

  it('is equivalent to a (now - catchUpMs, now] cronDueBetween window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z')) // 07:30:20 CEST
    expect(cronMatchesNow('30 7 * * *', 60000, 'Europe/Budapest')).toBe(true)
    expect(cronMatchesNow('30 7 * * *', 60000, 'UTC')).toBe(false)
  })

  it('an interval cron is timezone-invariant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:20Z')) // 14:00:20 CEST / 12:00:20 UTC
    expect(cronMatchesNow('*/15 * * * *', 60000, 'Europe/Budapest')).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', 60000, 'UTC')).toBe(true)
  })
})

describe('computeNextRun honours the passed timezone', () => {
  afterEach(() => vi.useRealTimers())

  it('computes the next fixed-time occurrence in the given zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z')) // 07:30:20 CEST
    // Next "30 7" after 07:30:20 CEST is tomorrow 07:30 CEST == 2026-07-16 05:30 UTC.
    expect(computeNextRun('30 7 * * *', 'Europe/Budapest')).toBe(
      Math.floor(Date.parse('2026-07-16T05:30:00Z') / 1000),
    )
  })
})
