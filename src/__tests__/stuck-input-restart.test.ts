import { describe, it, expect } from 'vitest'
import { decideStuckInputRestart } from '../web/channel-monitor.js'

// The reliable backstop: when soft stuck-input recovery (Enter + clear+re-inject)
// is exhausted but the main channel input is STILL parked, escalate to a hard
// restart (respawn-pane). decideStuckInputRestart is the pure gate -- rate
// limited and capped so a wedge a restart cannot clear never loops forever.

const MAX_ATTEMPTS = 4
const MIN_INTERVAL = 5 * 60 * 1000 // 5 min
const MAX_CONSEC = 3
const NOW = 10_000_000

const decide = (over: Partial<{ parked: boolean; attempts: number; last: number; count: number }> = {}) =>
  decideStuckInputRestart(
    over.parked ?? true,
    over.attempts ?? MAX_ATTEMPTS,
    MAX_ATTEMPTS,
    NOW,
    over.last ?? 0,
    over.count ?? 0,
    MIN_INTERVAL,
    MAX_CONSEC,
  )

describe('decideStuckInputRestart', () => {
  it('restarts when soft recovery is exhausted and input is still parked', () => {
    expect(decide()).toBe('restart')
  })

  it('skips when the input is not parked (nothing wedged)', () => {
    expect(decide({ parked: false })).toBe('skip')
  })

  it('skips while soft recovery is still in progress (attempts < max)', () => {
    expect(decide({ attempts: MAX_ATTEMPTS - 1 })).toBe('skip')
  })

  it('skips when rate-limited (a restart fired within the interval)', () => {
    expect(decide({ last: NOW - (MIN_INTERVAL - 1) })).toBe('skip')
    // ...but allows it once the interval has passed
    expect(decide({ last: NOW - MIN_INTERVAL })).toBe('restart')
  })

  it('alerts exactly once when restarts cannot clear the wedge (cap reached)', () => {
    expect(decide({ count: MAX_CONSEC })).toBe('alert')
    // already alerted (counter ticked past the cap) -> stop acting
    expect(decide({ count: MAX_CONSEC + 1 })).toBe('skip')
  })

  it('keeps restarting up to the cap', () => {
    expect(decide({ count: 1 })).toBe('restart')
    expect(decide({ count: MAX_CONSEC - 1 })).toBe('restart')
  })
})
