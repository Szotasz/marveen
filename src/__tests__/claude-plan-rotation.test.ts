import { describe, it, expect } from 'vitest'
import {
  estimateWindowFree,
  pickRotationTarget,
  decideRotationAction,
  isQuotaExceededError,
  ROTATION_GATE,
  type ObservedWindow,
  type RotationCandidate,
} from '../claude-plan-rotation.js'

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0) // 2026-09-12T12:00:00Z
const NOW_S = NOW / 1000

describe('estimateWindowFree', () => {
  it('fails open to 100 when there is no prior observation', () => {
    expect(estimateWindowFree(undefined, NOW)).toBe(100)
  })

  it('returns 100 minus used percent when the reset has not arrived yet', () => {
    const observed: ObservedWindow = { usedPercent: 63, resetsAt: NOW_S + 1 / 1000 } // 1ms from now
    // now is exactly 1ms before resetsAtMs
    expect(estimateWindowFree(observed, NOW)).toBe(37)
  })

  it('returns 100 when the reset lands exactly now', () => {
    const observed: ObservedWindow = { usedPercent: 80, resetsAt: NOW_S }
    expect(estimateWindowFree(observed, NOW)).toBe(100)
  })

  it('returns 100 when the reset is long past (inactive for multiple windows)', () => {
    const observed: ObservedWindow = { usedPercent: 95, resetsAt: NOW_S - 7 * 24 * 3600 }
    expect(estimateWindowFree(observed, NOW)).toBe(100)
  })
})

describe('pickRotationTarget', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickRotationTarget([], 'active')).toBeNull()
  })

  it('returns null when the only candidate is the active plan itself', () => {
    const candidates: RotationCandidate[] = [{ planId: 'active', freeFivePct: 100 }]
    expect(pickRotationTarget(candidates, 'active')).toBeNull()
  })

  it('picks the candidate with the most free headroom', () => {
    const candidates: RotationCandidate[] = [
      { planId: 'a', freeFivePct: 40 },
      { planId: 'b', freeFivePct: 90 },
      { planId: 'active', freeFivePct: 100 },
    ]
    expect(pickRotationTarget(candidates, 'active')).toBe('b')
  })

  it('breaks ties on planId ascending, regardless of array order', () => {
    const ascending: RotationCandidate[] = [
      { planId: 'zed', freeFivePct: 50 },
      { planId: 'alpha', freeFivePct: 50 },
      { planId: 'mid', freeFivePct: 50 },
    ]
    expect(pickRotationTarget(ascending, 'active')).toBe('alpha')

    const reversed = [...ascending].reverse()
    expect(pickRotationTarget(reversed, 'active')).toBe('alpha')
  })
})

describe('decideRotationAction', () => {
  const candidates: RotationCandidate[] = [{ planId: 'other', freeFivePct: 100 }]

  it('stays put just under the switch threshold (89.99%)', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: { usedPercent: 89.99, resetsAt: NOW_S + 3600 },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).toBe('no-pressure')
  })

  it('proceeds past the gate at exactly 90.0%', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: { usedPercent: 90.0, resetsAt: NOW_S + 3600 },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).not.toBe('no-pressure')
  })

  it('defers to the reset when it is closer than the near-reset window', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: { usedPercent: 95, resetsAt: NOW_S + 29 * 60 },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).toBe('near-reset')
  })

  it('rotates when the reset is exactly at the near-reset boundary (30 min)', () => {
    // untilResetMs === ROTATION_GATE.nearResetMs -- the pseudocode uses <=,
    // so exactly 30 minutes out still counts as "near reset" (stay).
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: {
        usedPercent: 95,
        resetsAt: NOW_S + ROTATION_GATE.nearResetMs / 1000,
      },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).toBe('near-reset')
  })

  it('rotates to a target just past the near-reset boundary', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: {
        usedPercent: 95,
        resetsAt: NOW_S + ROTATION_GATE.nearResetMs / 1000 + 1,
      },
      candidates,
      nowMs: NOW,
    })
    expect(result).toEqual(
      expect.objectContaining({ action: 'rotate', targetPlanId: 'other' }),
    )
  })

  it('reports no-alternative when every other plan is excluded or absent', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: { usedPercent: 95, resetsAt: NOW_S + 3600 },
      candidates: [],
      nowMs: NOW,
    })
    expect(result.action).toBe('no-alternative')
  })
})

describe('isQuotaExceededError', () => {
  it.each([
    'HTTP 429 Too Many Requests',
    'Error: quota exceeded for this window',
    'quota_exceeded',
    'Usage limit reached for your plan',
    'rate limit exceeded, retry later',
  ])('matches a real quota-exhaustion signal: %s', (text) => {
    expect(isQuotaExceededError(text)).toBe(true)
  })

  it.each([
    '',
    'connection refused',
    'the file limit for this directory was 42 entries',
    'a random 4295 in some unrelated log line',
  ])('does not match unrelated text: %s', (text) => {
    expect(isQuotaExceededError(text)).toBe(false)
  })
})
