import { describe, it, expect } from 'vitest'
import {
  decideStuckInputRecovery,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'

// Contract for the LOCAL FAST stuck-input recovery (stuck-input-watcher.ts):
// on the 15s tick the same parked signature must reach the clear+re-inject
// escalation (attempt > MAIN_STUCK_ENTER_ATTEMPTS=2, i.e. attempts 3..) WELL
// BEFORE the give-up cap, so a swallowed Enter gets the message actually
// re-injected within ~30-45s instead of waiting minutes for the slow
// channel-monitor backstop. These thresholds mirror LOCAL_FAST_THRESHOLDS,
// which the fast watcher applies to BOTH local sub-agents and the MAIN
// channels session (MAIN no longer bare-Enter-only).
const LOCAL_FAST_THRESHOLDS: StuckInputThresholds = {
  confirmMs: 12_000,
  dedupMs: 12_000,
  maxAttempts: 5,
}

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
const MAIN_STUCK_ENTER_ATTEMPTS = 2 // bare Enters before clear+re-inject escalation

// Drive a stable parked signature through the decision fn on a fixed tick,
// collecting the attempt number on every tick that recovers.
function runSpell(sig: string, tickMs: number, ticks: number): number[] {
  let state = NO_STATE
  let now = 0
  const recoveredAttempts: number[] = []
  for (let i = 0; i < ticks; i++) {
    now += tickMs
    const { recover, next } = decideStuckInputRecovery(sig, state, now, LOCAL_FAST_THRESHOLDS)
    if (recover) recoveredAttempts.push(next.attempts)
    state = next
  }
  return recoveredAttempts
}

describe('sub-agent fast stuck-input recovery contract', () => {
  it('reaches clear+re-inject escalation before the give-up cap', () => {
    // 15s tick (the watcher interval). First seen at t=15s, confirm window
    // 12s already elapsed by the next tick, then one action per tick.
    const attempts = runSpell('parked Németh Gábor ...', 15_000, 10)
    // Recovers exactly maxAttempts times, numbered 1..5.
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    // At least one escalation attempt (>2) happened -> clear + re-inject is
    // exercised, not just bare Enter.
    expect(attempts.some((a) => a > MAIN_STUCK_ENTER_ATTEMPTS)).toBe(true)
  })

  it('stops acting once the give-up cap is hit (no infinite recovery)', () => {
    const attempts = runSpell('still parked', 15_000, 40)
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    expect(attempts.length).toBe(LOCAL_FAST_THRESHOLDS.maxAttempts)
  })

  it('a changed signature restarts the spell (message still arriving / edited)', () => {
    let state = NO_STATE
    let now = 0
    // First signature parks and recovers once...
    now += 15_000
    let d = decideStuckInputRecovery('sig-a', state, now, LOCAL_FAST_THRESHOLDS)
    state = d.next // record only (new spell)
    now += 15_000
    d = decideStuckInputRecovery('sig-a', state, now, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    state = d.next
    // ...then the text changes: confirm window restarts, no immediate action.
    now += 15_000
    d = decideStuckInputRecovery('sig-b', state, now, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(0)
    expect(d.next.firstSeenAt).toBe(now)
  })

  it('clears state when nothing is parked', () => {
    const d = decideStuckInputRecovery(null, { parkedSig: 'x', firstSeenAt: 1, lastRecoverAt: 1, attempts: 2 }, 99_999, LOCAL_FAST_THRESHOLDS)
    expect(d.recover).toBe(false)
    expect(d.next.parkedSig).toBeNull()
  })
})
