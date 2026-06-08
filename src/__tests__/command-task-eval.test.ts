import { describe, expect, it } from 'vitest'
import { evaluateCommandResult, type CommandHealth } from '../web/command-task.js'

// Unit tests for the command-task failure/recovery policy. This is the
// decision core behind type='command' scheduled tasks (raw shell health
// checks). The rules under test:
//   - a success zeroes the consecutive-failure streak
//   - an alert fires exactly ONCE, when the streak first hits failThreshold
//   - while still failing past the threshold, no repeat alerts
//   - a recover fires exactly ONCE, when a previously-alerted task succeeds
const T = 1_000

describe('evaluateCommandResult', () => {
  it('returns no action on the first failure below threshold', () => {
    const { next, action } = evaluateCommandResult(undefined, false, 2, T)
    expect(action).toBe('none')
    expect(next.fails).toBe(1)
    expect(next.alerted).toBe(false)
    expect(next.lastStatus).toBe('fail')
  })

  it('alerts exactly when the streak first reaches the threshold', () => {
    const prev: CommandHealth = { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, false, 2, T)
    expect(action).toBe('alert')
    expect(next.fails).toBe(2)
    expect(next.alerted).toBe(true)
  })

  it('does not re-alert while already alerted and still failing', () => {
    const prev: CommandHealth = { fails: 2, alerted: true, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, false, 2, T)
    expect(action).toBe('none')
    expect(next.fails).toBe(3)
    expect(next.alerted).toBe(true)
  })

  it('recovers exactly once when a previously-alerted task succeeds', () => {
    const prev: CommandHealth = { fails: 3, alerted: true, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, true, 2, T)
    expect(action).toBe('recover')
    expect(next.fails).toBe(0)
    expect(next.alerted).toBe(false)
    expect(next.lastStatus).toBe('ok')
  })

  it('stays silent on success when not previously alerted', () => {
    const prev: CommandHealth = { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, true, 2, T)
    expect(action).toBe('none')
    expect(next.fails).toBe(0)
  })

  it('respects a custom failThreshold greater than 2', () => {
    let prev: CommandHealth | undefined
    const actions: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = evaluateCommandResult(prev, false, 3, T)
      prev = r.next
      actions.push(r.action)
    }
    expect(actions).toEqual(['none', 'none', 'alert'])
  })
})
