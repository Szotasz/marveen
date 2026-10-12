import { describe, it, expect } from 'vitest'
import { decideRoutineAlert, routineAlertSuffix, ROUTINE_ALERT_COOLDOWN_MS } from '../web/routine-alert.js'

const COOLDOWN = ROUTINE_ALERT_COOLDOWN_MS

describe('decideRoutineAlert', () => {
  it('sends the first occurrence with no repeat counter', () => {
    expect(decideRoutineAlert(undefined, 1_000, COOLDOWN)).toEqual({ send: true, repeats: 0 })
  })

  it('stays silent while inside the cooldown', () => {
    const prev = { lastSentAt: 1_000, suppressed: 0 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN - 1, COOLDOWN)).toEqual({ send: false })
  })

  it('speaks again once the cooldown elapsed, carrying the suppressed count', () => {
    const prev = { lastSentAt: 1_000, suppressed: 4 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN, COOLDOWN)).toEqual({ send: true, repeats: 4 })
  })

  it('a quiet cooldown produces a clean report, not a repeat warning', () => {
    const prev = { lastSentAt: 1_000, suppressed: 0 }
    expect(decideRoutineAlert(prev, 1_000 + COOLDOWN * 3, COOLDOWN)).toEqual({ send: true, repeats: 0 })
  })
})

describe('routineAlertSuffix', () => {
  it('adds nothing to a first report', () => {
    expect(routineAlertSuffix(0, COOLDOWN)).toBe('')
  })

  it('reports the total occurrences, not just the suppressed ones', () => {
    expect(routineAlertSuffix(4, COOLDOWN)).toContain('5 ilyen volt')
    expect(routineAlertSuffix(4, COOLDOWN)).toContain('30 perc')
  })
})
