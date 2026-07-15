import { describe, it, expect, vi, afterEach } from 'vitest'
import { cronMatchesNow, computeNextRun, resolveCronTz } from '../web/cron.js'

// Regression for the 2026-07-13..15 silent scheduler outage: fixed-time cron
// tasks (reggeli-napindito "30 7 * * *", dream-engine "7 2 * * *") stopped
// firing for days while the "*/15 * * * *" heartbeat kept running. Root cause:
// the process resolved its cron timezone to UTC (neither SCHEDULER_TZ nor TZ
// set), which shifts a fixed hour:minute cron's previous occurrence by the UTC
// offset so it never lands in cronMatchesNow's one-minute window at the
// operator's local time. Interval crons constrain only the minute field and
// are timezone-invariant, so they were unaffected -- exactly the observed
// "interval fires, fixed-time never" asymmetry.

describe('resolveCronTz source precedence', () => {
  it('prefers SCHEDULER_TZ over TZ', () => {
    expect(resolveCronTz({ SCHEDULER_TZ: 'Europe/Budapest', TZ: 'UTC' })).toEqual({
      tz: 'Europe/Budapest',
      source: 'SCHEDULER_TZ',
    })
  })

  it('falls back to TZ when SCHEDULER_TZ is absent', () => {
    expect(resolveCronTz({ TZ: 'Europe/Budapest' })).toEqual({
      tz: 'Europe/Budapest',
      source: 'TZ',
    })
  })

  it('falls back to the system default when neither SCHEDULER_TZ nor TZ is set', () => {
    const r = resolveCronTz({})
    expect(r.source).toBe('system-default')
    expect(typeof r.tz).toBe('string')
    expect(r.tz.length).toBeGreaterThan(0)
  })
})

describe('cronMatchesNow timezone handling', () => {
  afterEach(() => vi.useRealTimers())

  // 2026-07-15 07:30:20 in Europe/Budapest (CEST, UTC+2) == 05:30:20 UTC.
  const at0730Cest = new Date('2026-07-15T05:30:20Z')

  it('fires a fixed-time cron at its scheduled minute in the operator zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at0730Cest)
    expect(cronMatchesNow('30 7 * * *', 60000, 'Europe/Budapest')).toBe(true)
  })

  it('does NOT fire the same fixed-time cron under UTC -- the shift bug, locked as a regression', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at0730Cest)
    // Under UTC, "30 7 * * *" means 07:30 UTC (= 09:30 CEST); at 05:30 UTC the
    // previous occurrence is the day before, ~22h away, so it never matches the
    // operator's 07:30. This asymmetry IS the incident.
    expect(cronMatchesNow('30 7 * * *', 60000, 'UTC')).toBe(false)
  })

  it('fires an interval cron regardless of timezone (why heartbeats survived)', () => {
    vi.useFakeTimers()
    // 14:00:20 CEST == 12:00:20 UTC -- a :00 minute boundary in both zones.
    vi.setSystemTime(new Date('2026-07-15T12:00:20Z'))
    expect(cronMatchesNow('*/15 * * * *', 60000, 'Europe/Budapest')).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', 60000, 'UTC')).toBe(true)
  })

  it('does not match a fixed-time cron outside its one-minute catch-up window', () => {
    vi.useFakeTimers()
    // 07:32:00 CEST -- two minutes past 07:30, beyond the 60s window.
    vi.setSystemTime(new Date('2026-07-15T05:32:00Z'))
    expect(cronMatchesNow('30 7 * * *', 60000, 'Europe/Budapest')).toBe(false)
  })
})

describe('computeNextRun honours the passed timezone', () => {
  afterEach(() => vi.useRealTimers())

  it('computes the next fixed-time occurrence in the given zone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z')) // 07:30:20 CEST
    // Next "30 7" after 07:30:20 CEST is tomorrow 07:30 CEST == 2026-07-16 05:30 UTC.
    const next = computeNextRun('30 7 * * *', 'Europe/Budapest')
    expect(next).toBe(Math.floor(Date.parse('2026-07-16T05:30:00Z') / 1000))
  })
})
