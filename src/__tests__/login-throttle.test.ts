import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  isGlobalLimited,
  runDummyVerify,
  _resetThrottleForTest,
} from '../web/login-throttle.js'

beforeEach(() => {
  _resetThrottleForTest()
})

describe('per-username lockout', () => {
  it('is unlocked before the 5th consecutive failure', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 4; i++) recordFailure('alice', t0)
    expect(checkThrottle('alice', t0).locked).toBe(false)
  })

  it('locks for 30s at the 5th failure', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) recordFailure('alice', t0)
    const s = checkThrottle('alice', t0)
    expect(s.locked).toBe(true)
    expect(s.retryAfterS).toBe(30)
  })

  it('doubles the lock per further failure, capped at 15 min', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) recordFailure('alice', t0)
    expect(checkThrottle('alice', t0).retryAfterS).toBe(30)
    recordFailure('alice', t0) // 6th
    expect(checkThrottle('alice', t0).retryAfterS).toBe(60)
    recordFailure('alice', t0) // 7th
    expect(checkThrottle('alice', t0).retryAfterS).toBe(120)
    for (let i = 0; i < 10; i++) recordFailure('alice', t0) // way past the cap
    expect(checkThrottle('alice', t0).retryAfterS).toBe(15 * 60)
  })

  it('unlocks once the lock window elapses', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) recordFailure('alice', t0)
    expect(checkThrottle('alice', t0 + 31_000).locked).toBe(false)
  })

  it('a success clears the counter', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) recordFailure('alice', t0)
    expect(checkThrottle('alice', t0).locked).toBe(true)
    recordSuccess('alice')
    expect(checkThrottle('alice', t0).locked).toBe(false)
  })
})

describe('known vs unknown username indistinguishability', () => {
  it('locks an unknown username exactly like a known one', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) recordFailure('ghost-user', t0)
    const s = checkThrottle('ghost-user', t0)
    expect(s.locked).toBe(true)
    expect(s.retryAfterS).toBe(30)
  })

  it('runDummyVerify resolves without throwing (timing equalizer path)', async () => {
    await expect(runDummyVerify('any-password')).resolves.toBeUndefined()
  })
})

describe('global cap', () => {
  it('trips 429 for ALL logins after 50 failures in the window', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 50; i++) recordFailure(`user${i}`, t0)
    expect(isGlobalLimited(t0)).toBe(true)
    // A previously-clean username is now globally throttled too.
    const s = checkThrottle('innocent', t0)
    expect(s.locked).toBe(true)
    expect(s.global).toBe(true)
  })

  it('drains after the rolling hour', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 50; i++) recordFailure(`user${i}`, t0)
    expect(isGlobalLimited(t0 + 61 * 60 * 1000)).toBe(false)
  })
})
