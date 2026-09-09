import { describe, it, expect } from 'vitest'
import {
  isNightLocked,
  schedulerLocalHour,
  NIGHT_LOCK_START_HOUR,
  NIGHT_LOCK_END_HOUR,
} from '../web/schedule-runner.js'

describe('night lock (idozar 22-05)', () => {
  it('locks the whole window, boundaries included as asked', () => {
    expect(isNightLocked(22)).toBe(true)
    expect(isNightLocked(23)).toBe(true)
    expect(isNightLocked(0)).toBe(true)
    expect(isNightLocked(4)).toBe(true)
  })

  it('opens at 05:00 and stays open all day', () => {
    expect(isNightLocked(5)).toBe(false)
    expect(isNightLocked(12)).toBe(false)
    expect(isNightLocked(21)).toBe(false)
  })

  it('keeps the configured bounds', () => {
    expect(NIGHT_LOCK_START_HOUR).toBe(22)
    expect(NIGHT_LOCK_END_HOUR).toBe(5)
  })

  it('reads the hour in the scheduler zone, not the host default', () => {
    // 2026-09-09T21:30:00Z is 23:30 in Budapest (CEST) but 21:30 in UTC:
    // the same instant is locked on one clock and open on the other.
    const ms = Date.parse('2026-09-09T21:30:00Z')
    expect(schedulerLocalHour(ms, 'Europe/Budapest')).toBe(23)
    expect(schedulerLocalHour(ms, 'UTC')).toBe(21)
    expect(isNightLocked(schedulerLocalHour(ms, 'Europe/Budapest'))).toBe(true)
    expect(isNightLocked(schedulerLocalHour(ms, 'UTC'))).toBe(false)
  })

  it('midnight maps to 0, not 24', () => {
    const ms = Date.parse('2026-09-09T22:10:00Z') // 00:10 Budapest
    expect(schedulerLocalHour(ms, 'Europe/Budapest')).toBe(0)
  })

  it('falls back to the host clock on an unusable zone instead of locking blindly', () => {
    const ms = Date.parse('2026-09-09T12:00:00Z')
    expect(schedulerLocalHour(ms, 'Nem/Letezik')).toBe(new Date(ms).getHours())
  })
})
