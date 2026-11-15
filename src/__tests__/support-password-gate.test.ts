import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSupportPasswordGate,
  normaliseSupportPasswordState,
  SUPPORT_PASSWORD_STATE_EMPTY,
  type SupportPasswordState,
} from '../support-password-gate.js'

const MIN = 60 * 1000

describe('the support password bucket (Dani 78357, Q4)', () => {
  let state: SupportPasswordState
  let t: number
  let alerts: number
  const gate = () =>
    createSupportPasswordGate({
      store: { load: () => state, save: (s) => (state = s) },
      now: () => t,
      alertHardLock: () => {
        alerts += 1
      },
    })
  const fail = (n: number): void => {
    for (let i = 0; i < n; i++) gate().recordFailure()
  }

  beforeEach(() => {
    state = SUPPORT_PASSWORD_STATE_EMPTY
    t = Date.UTC(2026, 10, 15, 8, 0, 0)
    alerts = 0
  })

  it('four wrong passwords do not lock; the fifth within 15 minutes locks for 15 minutes', () => {
    fail(4)
    expect(gate().check()).toEqual({ locked: false })
    t += 14 * MIN
    fail(1)
    expect(gate().check()).toEqual({ locked: true, retryAfterS: 15 * 60 })
    t += 15 * MIN - 1000
    expect(gate().check()).toEqual({ locked: true, retryAfterS: 1 })
    t += 1000
    expect(gate().check()).toEqual({ locked: false })
  })

  it('a wrong password older than 15 minutes no longer counts', () => {
    fail(4)
    t += 15 * MIN
    fail(1)
    expect(gate().check()).toEqual({ locked: false })
    fail(3)
    expect(gate().check()).toEqual({ locked: false })
    fail(1)
    expect(gate().check()).toMatchObject({ locked: true })
  })

  // Dani's review of #2781, N2: a burst under a lock must not build the next lock.
  it('wrong passwords while it is locked do not count, towards a lock or the hard lock', () => {
    fail(5)
    fail(20)
    expect(state.locks).toHaveLength(1)
    t += 15 * MIN
    fail(4)
    expect(gate().check()).toEqual({ locked: false })
    fail(1)
    fail(20)
    expect(state.locks).toHaveLength(2)
    expect(alerts).toBe(0)
  })

  it('a right password clears the wrong ones before it', () => {
    fail(4)
    gate().recordSuccess()
    fail(4)
    expect(gate().check()).toEqual({ locked: false })
  })

  it('the third lock within 24 hours holds until the owner logs in, alerts once, and does not end by itself', () => {
    for (let lock = 1; lock <= 2; lock++) {
      fail(5)
      expect(alerts).toBe(0)
      t += 16 * MIN
    }
    fail(5)
    expect(alerts).toBe(1)
    expect(gate().check()).toEqual({ locked: true, retryAfterS: null })
    t += 48 * 60 * MIN
    expect(gate().check()).toEqual({ locked: true, retryAfterS: null })
    fail(10)
    expect(alerts).toBe(1)
    gate().recordSuccess()
    expect(gate().check()).toEqual({ locked: true, retryAfterS: null })
    gate().ownerLoggedIn()
    expect(gate().check()).toEqual({ locked: false })
    expect(state).toEqual(SUPPORT_PASSWORD_STATE_EMPTY)
  })

  it('a lock older than 24 hours does not count towards the hard lock', () => {
    fail(5)
    t += 16 * MIN
    fail(5)
    t += 24 * 60 * MIN
    fail(5)
    expect(alerts).toBe(0)
    expect(gate().check()).toMatchObject({ locked: true, retryAfterS: 15 * 60 })
  })

  it('an owner login also ends a short lock and the counted wrong passwords', () => {
    fail(5)
    gate().ownerLoggedIn()
    expect(gate().check()).toEqual({ locked: false })
    fail(4)
    expect(gate().check()).toEqual({ locked: false })
  })

  it('a stored state that is not exactly the shape counts as the hard lock (fail closed)', () => {
    expect(normaliseSupportPasswordState(null).hardLocked).toBe(true)
    expect(normaliseSupportPasswordState('x').hardLocked).toBe(true)
    expect(normaliseSupportPasswordState({ ...SUPPORT_PASSWORD_STATE_EMPTY, failures: ['1'] }).hardLocked).toBe(true)
    expect(normaliseSupportPasswordState({ ...SUPPORT_PASSWORD_STATE_EMPTY, lockedUntil: 1.5 }).hardLocked).toBe(true)
    expect(normaliseSupportPasswordState({ ...SUPPORT_PASSWORD_STATE_EMPTY, hardLocked: 'no' }).hardLocked).toBe(true)
    expect(normaliseSupportPasswordState({ ...SUPPORT_PASSWORD_STATE_EMPTY, locks: Array(65).fill(1) }).hardLocked).toBe(true)
    const good = { failures: [1, 2], lockedUntil: 3, locks: [4], hardLocked: false }
    expect(normaliseSupportPasswordState(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })
})
