import { describe, it, expect } from 'vitest'
import {
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  READY_TIMEOUT_MS,
  type ContextGuardConfig,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'

// In await-handoff a busy pane defers the restart, so a live turn is not cut.
// Without a bound, an agent that never goes idle (back-to-back turns, a long
// tool loop) postpones its own restart for as long as it keeps working, while
// its context keeps growing past the threshold that started the handoff. The
// deferral now lasts one more handoffTimeoutMinutes past the deadline; after
// that the restart fires even on a busy pane.

const CFG: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
const NOW = 1_000_000_000
const DEADLINE = NOW + 60_000
const GRACE_MS = CFG.handoffTimeoutMinutes * 60_000

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: false,
    paneBusy: true,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    dailyHandoffDue: false,
    contextTokens: null,
    idleMs: null,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}

const awaiting: GuardState = {
  phase: 'await-handoff',
  handoffMtimeAtRequest: 100,
  deadlineMs: DEADLINE,
  cooldownUntilMs: 0,
  saturatedStreak: 0,
  staleRefreshCount: 0,
  handoffStaleMinutes: null,
}

describe('await-handoff: the mid-turn deferral is bounded', () => {
  it('past the deadline, a busy pane still defers within the grace window', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: DEADLINE + GRACE_MS - 1 }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
    expect(d.nextState).toEqual(awaiting)
  })

  it('once the grace window is over, the timeout restarts a busy pane', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: DEADLINE + GRACE_MS }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('timeout')
    expect(d.nextState.phase).toBe('await-ready')
    expect(d.nextState.deadlineMs).toBe(DEADLINE + GRACE_MS + READY_TIMEOUT_MS)
  })

  it('a pane that stays busy sweep after sweep is restarted at the bound, not later', () => {
    let state = awaiting
    let restartedAt: number | null = null
    for (let t = NOW; t <= DEADLINE + 2 * GRACE_MS; t += 60_000) {
      const d = decideGuard(state, inputs({ nowMs: t }), CFG)
      state = d.nextState
      if (d.action === 'restart') { restartedAt = t; break }
    }
    expect(restartedAt).not.toBeNull()
    expect(restartedAt as number).toBeGreaterThanOrEqual(DEADLINE + GRACE_MS)
    expect(restartedAt as number).toBeLessThan(DEADLINE + GRACE_MS + 60_000)
  })

  it('at hardPct, before the deadline, a busy pane is not cut', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, nowMs: DEADLINE - 1 }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
  })

  it('at hardPct the same bound applies: within the grace window it defers', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, nowMs: DEADLINE + GRACE_MS - 1 }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
  })

  it('at hardPct the same bound applies: after the grace window it restarts', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, nowMs: DEADLINE + GRACE_MS }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('the grace window follows handoffTimeoutMinutes', () => {
    const cfg = { ...CFG, handoffTimeoutMinutes: 5 }
    expect(decideGuard(awaiting, inputs({ nowMs: DEADLINE + 5 * 60_000 - 1 }), cfg).action).toBe('none')
    expect(decideGuard(awaiting, inputs({ nowMs: DEADLINE + 5 * 60_000 }), cfg).action).toBe('restart')
  })

  it('an idle pane past the deadline is restarted at once, as before', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: DEADLINE, paneBusy: false, paneIdle: true }), CFG)
    expect(d.action).toBe('restart')
  })
})
