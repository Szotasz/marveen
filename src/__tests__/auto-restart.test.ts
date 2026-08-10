import { describe, it, expect } from 'vitest'
import {
  parseHHMM,
  normalizeAutoRestartConfig,
  restartDue,
  dailyDueAtMs,
  DEFAULT_AUTO_RESTART,
} from '../auto-restart.js'

describe('parseHHMM', () => {
  it('parses valid times to minutes since midnight', () => {
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('03:00')).toBe(180)
    expect(parseHHMM('23:59')).toBe(23 * 60 + 59)
    expect(parseHHMM('9:30')).toBe(570)
  })
  it('rejects malformed or out-of-range values', () => {
    for (const bad of ['', '3', '24:00', '12:60', '-1:00', 'aa:bb', '12:5', 12 as unknown, null]) {
      expect(parseHHMM(bad as unknown)).toBeNull()
    }
  })
})

describe('normalizeAutoRestartConfig', () => {
  it('returns safe defaults for junk input', () => {
    expect(normalizeAutoRestartConfig(null)).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig('nope')).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig({})).toEqual(DEFAULT_AUTO_RESTART)
  })
  it('keeps a valid daily config and clears interval (daily wins)', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 6, handoff: true })
    expect(c).toEqual({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true })
  })
  it('keeps a valid interval config when no daily time', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'continue', intervalHours: 8 })
    expect(c).toEqual({ enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, handoff: false })
  })
  it('drops an invalid dailyTime and non-positive interval', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, dailyTime: '99:99', intervalHours: 0 })
    expect(c.dailyTime).toBeNull()
    expect(c.intervalHours).toBeNull()
  })
  it('defaults mode to continue for an unknown mode', () => {
    expect(normalizeAutoRestartConfig({ mode: 'wild' }).mode).toBe('continue')
  })
})

describe('restartDue', () => {
  const DUE = 1_000_000

  it('is not due before the scheduled time', () => {
    expect(restartDue(null, DUE - 1, DUE)).toBe(false)
  })
  it('is due at/after the scheduled time when never restarted', () => {
    expect(restartDue(null, DUE, DUE)).toBe(true)
    expect(restartDue(null, DUE + 5_000, DUE)).toBe(true)
  })
  it('does not re-fire once restarted at/after the due point', () => {
    expect(restartDue(DUE, DUE + 5_000, DUE)).toBe(false)
    expect(restartDue(DUE + 1, DUE + 5_000, DUE)).toBe(false)
  })
  it('fires again for a later due point even if restarted at an earlier one', () => {
    const earlier = DUE - 86_400_000 // yesterday's restart
    expect(restartDue(earlier, DUE + 1, DUE)).toBe(true)
  })
  it('is never due for a non-finite dueAt', () => {
    expect(restartDue(null, DUE, Number.NaN)).toBe(false)
    expect(restartDue(null, DUE, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('dailyDueAtMs', () => {
  it('adds the minutes-since-midnight offset to local midnight', () => {
    const midnight = 1_700_000_000_000
    expect(dailyDueAtMs(midnight, 0)).toBe(midnight)
    expect(dailyDueAtMs(midnight, 180)).toBe(midnight + 180 * 60_000) // 03:00
  })
})
