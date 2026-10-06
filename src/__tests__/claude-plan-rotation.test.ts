import { describe, it, expect } from 'vitest'
import {
  estimateWindowFree,
  pickRotationTarget,
  decideRotationAction,
  isQuotaExceededError,
  candidateFromObservation,
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

// Weekly (7d) window: every real outage on the fleet was the weekly limit,
// so the decision has to see it on both sides -- the active plan's pressure
// and the candidates' headroom.
describe('decideRotationAction: 7-day window', () => {
  const candidates: RotationCandidate[] = [{ planId: 'other', freeFivePct: 100, freeSevenDayPct: 100 }]
  const calm5h = { usedPercent: 10, resetsAt: NOW_S + 3600 }

  it('rotates on 7d pressure even when the 5h window is calm', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: calm5h,
      activeSevenDay: { usedPercent: 93, resetsAt: NOW_S + 3 * 24 * 3600 },
      candidates,
      nowMs: NOW,
    })
    expect(result).toEqual(expect.objectContaining({ action: 'rotate', targetPlanId: 'other', trigger: '7d' }))
    expect(result.reason).toContain('7d=93%')
  })

  it('treats a 7d status "rejected" as 100% used, whatever the percentage', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: calm5h,
      activeSevenDay: { usedPercent: 40, resetsAt: NOW_S + 24 * 3600, status: 'rejected' },
      candidates,
      nowMs: NOW,
    })
    expect(result).toEqual(expect.objectContaining({ action: 'rotate', trigger: '7d' }))
    expect(result.reason).toContain('7d=100%')
  })

  it('stays put just under the 7d threshold', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: calm5h,
      activeSevenDay: { usedPercent: 89.9, resetsAt: NOW_S + 3 * 24 * 3600 },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).toBe('no-pressure')
  })

  it('a 7d reset days away is not "near": 5h near-reset does not suppress a 7d rotation', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: { usedPercent: 95, resetsAt: NOW_S + 10 * 60 },
      activeSevenDay: { usedPercent: 95, resetsAt: NOW_S + 3 * 24 * 3600 },
      candidates,
      nowMs: NOW,
    })
    expect(result).toEqual(expect.objectContaining({ action: 'rotate', trigger: '7d' }))
  })

  it('a 7d window resetting within 30 min is near-reset, same rule as 5h', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: calm5h,
      activeSevenDay: { usedPercent: 99, resetsAt: NOW_S + 20 * 60 },
      candidates,
      nowMs: NOW,
    })
    expect(result.action).toBe('near-reset')
  })

  it('reports no-alternative with the 7d trigger when nothing is left', () => {
    const result = decideRotationAction({
      activePlanId: 'active',
      activeFiveHour: calm5h,
      activeSevenDay: { usedPercent: 100, resetsAt: NOW_S + 24 * 3600 },
      candidates: [],
      nowMs: NOW,
    })
    expect(result).toEqual(expect.objectContaining({ action: 'no-alternative', trigger: '7d' }))
  })

  it('an absent 7d window is never pressure (fail open)', () => {
    const result = decideRotationAction({ activePlanId: 'active', activeFiveHour: calm5h, candidates, nowMs: NOW })
    expect(result.action).toBe('no-pressure')
  })
})

describe('candidateFromObservation', () => {
  it('no observation -> full-headroom candidate (fail open)', () => {
    expect(candidateFromObservation('p', undefined, NOW)).toEqual({ planId: 'p', freeFivePct: 100, freeSevenDayPct: 100 })
  })

  it('excludes a plan whose 7d is over threshold and not yet reset', () => {
    const obs = { observedAt: NOW - 1000, windows: { seven_day: { usedPercent: 92, resetsAt: NOW_S + 2 * 24 * 3600 } } }
    expect(candidateFromObservation('p', obs, NOW)).toBeNull()
  })

  it('excludes a plan whose 7d status is rejected even at a low percentage', () => {
    const obs = { observedAt: NOW - 1000, windows: { seven_day: { usedPercent: 12, resetsAt: NOW_S + 3600, status: 'rejected' } } }
    expect(candidateFromObservation('p', obs, NOW)).toBeNull()
  })

  it('re-includes a 7d-exhausted plan once its reset has passed', () => {
    const obs = { observedAt: NOW - 8 * 24 * 3600_000, windows: { seven_day: { usedPercent: 100, resetsAt: NOW_S - 60, status: 'rejected' } } }
    expect(candidateFromObservation('p', obs, NOW)).toEqual({ planId: 'p', freeFivePct: 100, freeSevenDayPct: 100 })
  })

  it('excludes a plan whose last probe failed with invalid_token', () => {
    const obs = { observedAt: NOW - 3600_000, windows: {}, lastProbe: { at: NOW - 1000, ok: false, error: 'invalid_token' } }
    expect(candidateFromObservation('p', obs, NOW)).toBeNull()
  })

  it('keeps a plan whose failed probe was a network error, not a bad token', () => {
    const obs = { observedAt: NOW - 3600_000, windows: {}, lastProbe: { at: NOW - 1000, ok: false, error: 'network' } }
    expect(candidateFromObservation('p', obs, NOW)).not.toBeNull()
  })

  it('an invalid_token probe older than a later good observation no longer excludes', () => {
    const obs = { observedAt: NOW - 1000, windows: {}, lastProbe: { at: NOW - 3600_000, ok: false, error: 'invalid_token' } }
    expect(candidateFromObservation('p', obs, NOW)).not.toBeNull()
  })

  it('excludes a 5h-exhausted plan, but keeps a merely busy one (92%)', () => {
    const spent = { observedAt: NOW, windows: { five_hour: { usedPercent: 100, resetsAt: NOW_S + 3600 } } }
    const busy = { observedAt: NOW, windows: { five_hour: { usedPercent: 92, resetsAt: NOW_S + 3600 } } }
    expect(candidateFromObservation('p', spent, NOW)).toBeNull()
    expect(candidateFromObservation('p', busy, NOW)).toEqual({ planId: 'p', freeFivePct: 8, freeSevenDayPct: 100 })
  })
})

describe('pickRotationTarget: ranks by the tighter of the two windows', () => {
  it('prefers moderate-both over fresh-5h-but-nearly-spent-week', () => {
    const candidates: RotationCandidate[] = [
      { planId: 'a', freeFivePct: 100, freeSevenDayPct: 20 },
      { planId: 'b', freeFivePct: 50, freeSevenDayPct: 95 },
    ]
    expect(pickRotationTarget(candidates, 'active')).toBe('b')
  })
})
