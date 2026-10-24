import { describe, it, expect } from 'vitest'
import {
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  BUSY_OVERDUE_REASON_PREFIX,
  type GuardInputs,
} from '../context-guard.js'

// The idle-phase hard tier and a POSITIVELY busy pane. A busy pane is never
// restarted (2026-07-27; product decision on #2102), and that stays. What
// changes is what the guard does while it waits. It used to defer silently in
// the idle phase, and the restart that ended the wait came with no handoff
// written. Measured on one agent (limit 500k, act 0.90, hard 0.97): a parallel
// tool batch can take the context from below the act band past hardPct between
// two sweeps, so the act tier never asks, and three hard restarts in one day
// fired 15-27 minutes after the hard line, at 117-137%, with no handoff.
// Now the hard tier asks the busy pane for the handoff and lets await-handoff
// do the waiting: no restart while the turn runs, a restart on the first sweep
// that finds the pane no longer busy, and one warning (#2129) if the turn runs
// far past the deadline.

const CFG = { ...DEFAULT_CONTEXT_GUARD, enabled: true, saturationRestart: true }
const NOW = 1_000_000_000
const PCT = 0.99
const HARD_LINE = `${Math.round(PCT * 100)}% >= ${Math.round(CFG.hardPct * 100)}%`

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: PCT,
    running: true,
    paneIdle: true,
    paneBusy: false,
    sessionReady: false,
    handoffMtime: 123,
    paneSaturated: false,
    dailyHandoffDue: false,
    contextTokens: null,
    idleMs: null,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}
const busy = (overrides: Partial<GuardInputs> = {}) => inputs({ paneBusy: true, paneIdle: false, ...overrides })

describe('decideGuard: idle-phase hard tier, busy pane', () => {
  it('requests a handoff instead of deferring silently, and does not restart', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, busy(), CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.reason).toBe(`hard threshold (${HARD_LINE}) but agent mid-turn -- requesting handoff, the restart waits for the turn`)
    expect(d.nextState.phase).toBe('await-handoff')
    expect(d.nextState.handoffMtimeAtRequest).toBe(123)
    expect(d.nextState.deadlineMs).toBe(NOW + CFG.handoffTimeoutMinutes * 60_000)
    expect(d.nextState.handoffRequestReason).toBe(d.reason)
    expect(d.nextState.idleFlushSequence).toBe(false)
  })

  it('a pane that is not busy still restarts at once (it may be wedged behind a modal)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs(), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toBe(`hard threshold (${HARD_LINE})`)
  })

  it('the saturation net still comes first', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, busy({ paneSaturated: true }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.saturatedStreak).toBe(1)
  })

  it('a usage limit still parks every tier', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, busy({ usageLimited: true }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('idle')
  })

  it('below hardPct nothing changes: the act tier asks, busy or not', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, busy({ pct: 0.93 }), CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith('act threshold')).toBe(true)
  })
})

describe('the sequence it starts never cuts the turn', () => {
  const started = decideGuard(INITIAL_GUARD_STATE, busy(), CFG).nextState
  const LATER = NOW + 5 * 60_000

  it('still busy on the next sweep: deferred, no restart', () => {
    const d = decideGuard(started, busy({ nowMs: LATER }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('hard threshold during await-handoff but agent mid-turn -- deferring restart')
  })

  it('turn over, handoff written: the restart ships it', () => {
    const d = decideGuard(started, inputs({ nowMs: LATER, handoffMtime: 456 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toBe('handoff written')
  })

  it('turn over, no handoff: the first idle sweep restarts, as before', () => {
    const d = decideGuard(started, inputs({ nowMs: LATER }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toBe('hard threshold during await-handoff')
  })

  it('a turn that never ends is reported once, far past the deadline (the idle phase never reported it)', () => {
    const at = started.deadlineMs + CFG.handoffTimeoutMinutes * 60_000
    const d = decideGuard(started, busy({ nowMs: at }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason.startsWith(BUSY_OVERDUE_REASON_PREFIX)).toBe(true)
    expect(d.nextState.busyOverdueWarned).toBe(true)
  })
})
