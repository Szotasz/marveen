import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  BUSY_OVERDUE_REASON_PREFIX,
  USAGE_LIMIT_REASON_PREFIX,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'

// A busy pane is never restarted by the guard: both await-handoff deferrals
// (hard threshold, handoff timeout) wait for the turn to end, with no upper
// bound (product decision on #2102). An agent whose turn never ends therefore
// sits past its handoff deadline indefinitely, and the none-branch says
// nothing. The guard still does not restart it; it now says so ONCE per
// handoff sequence, a whole handoffTimeoutMinutes after the deadline, as a
// warning in the dashboard log.

const RUNNER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../web/context-guard-runner.ts'),
  'utf-8',
)

const CFG = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
const NOW = 1_000_000_000
const DEADLINE = NOW + 60_000
const OVERDUE_AT = DEADLINE + CFG.handoffTimeoutMinutes * 60_000

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
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
const busy = (nowMs: number, extra: Partial<GuardInputs> = {}) =>
  inputs({ nowMs, paneBusy: true, paneIdle: false, handoffMtime: 100, ...extra })

describe('decideGuard: a busy pane far past the handoff deadline', () => {
  it('just past the deadline: the plain deferral, unchanged, no flag', () => {
    const d = decideGuard(awaiting, busy(DEADLINE + 1_000), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('handoff timeout but agent mid-turn -- deferring restart')
    expect(d.nextState).toEqual(awaiting)
  })

  it('one millisecond before the overdue edge: still the plain deferral', () => {
    const d = decideGuard(awaiting, busy(OVERDUE_AT - 1), CFG)
    expect(d.action).toBe('none')
    expect(d.reason.startsWith(BUSY_OVERDUE_REASON_PREFIX)).toBe(false)
    expect(d.nextState.busyOverdueWarned).toBeFalsy()
  })

  it('at the overdue edge: still no restart, the reason carries the prefix once, the flag is set', () => {
    const d = decideGuard(awaiting, busy(OVERDUE_AT), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe(
      `${BUSY_OVERDUE_REASON_PREFIX}: handoff timeout but agent mid-turn -- deferring restart ` +
      `(${CFG.handoffTimeoutMinutes}m past the handoff deadline)`,
    )
    expect(d.nextState).toEqual({ ...awaiting, busyOverdueWarned: true })
  })

  it('after the warning: later busy sweeps defer silently again (once per sequence)', () => {
    const warned: GuardState = { ...awaiting, busyOverdueWarned: true }
    const d = decideGuard(warned, busy(OVERDUE_AT + 5 * 60_000), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('handoff timeout but agent mid-turn -- deferring restart')
    expect(d.nextState).toEqual(warned)
  })

  it('after the warning: the first not-busy sweep still restarts', () => {
    const warned: GuardState = { ...awaiting, busyOverdueWarned: true }
    const d = decideGuard(warned, inputs({ nowMs: OVERDUE_AT + 5 * 60_000, handoffMtime: 100 }), CFG)
    expect(d.action).toBe('restart')
    // the restart ends the sequence: the next one may warn again
    expect(d.nextState.busyOverdueWarned).toBeUndefined()
  })

  it('a usage-limit park keeps the flag: it is the same handoff sequence', () => {
    const warned: GuardState = { ...awaiting, busyOverdueWarned: true }
    const d = decideGuard(warned, busy(OVERDUE_AT + 5 * 60_000, { usageLimited: true }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason.startsWith(USAGE_LIMIT_REASON_PREFIX)).toBe(true)
    expect(d.nextState.busyOverdueWarned).toBe(true)
  })

  it('the hard-threshold deferral warns the same way', () => {
    const d = decideGuard(awaiting, busy(OVERDUE_AT, { pct: 0.99 }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe(
      `${BUSY_OVERDUE_REASON_PREFIX}: hard threshold during await-handoff but agent mid-turn -- deferring restart ` +
      `(${CFG.handoffTimeoutMinutes}m past the handoff deadline)`,
    )
    expect(d.nextState.busyOverdueWarned).toBe(true)
  })

  it('the hard-threshold deferral before the deadline does not warn', () => {
    const d = decideGuard(awaiting, busy(NOW, { pct: 0.99 }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('hard threshold during await-handoff but agent mid-turn -- deferring restart')
    expect(d.nextState.busyOverdueWarned).toBeFalsy()
  })

  it('a new handoff sequence starts without the flag', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.91, handoffMtime: 123 }), CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.nextState.busyOverdueWarned).toBeUndefined()
  })

  it('the idle-phase hard-tier deferral never warns (it has no handoff deadline)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ nowMs: OVERDUE_AT * 10, pct: 0.99, paneBusy: true, paneIdle: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason.startsWith(BUSY_OVERDUE_REASON_PREFIX)).toBe(false)
  })
})

describe('the runner logs the overdue busy pane', () => {
  it('checkAgent warns from its none-branch, before that branch returns', () => {
    const start = RUNNER_SRC.indexOf('async function checkAgent(')
    const end = RUNNER_SRC.indexOf('export function getContextGuardStatus(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = RUNNER_SRC.slice(start, end)
    const noneBranch = body.indexOf("if (decision.action === 'none') {")
    expect(noneBranch).toBeGreaterThan(-1)
    const wiring = body.indexOf(
      'if (decision.reason.startsWith(BUSY_OVERDUE_REASON_PREFIX)) ' +
      "logger.warn({ name, reason: decision.reason }, 'context-guard: pane still busy far past the handoff deadline -- restart stays deferred')",
    )
    expect(wiring).toBeGreaterThan(noneBranch)
    expect(wiring).toBeLessThan(body.indexOf('return', noneBranch))
  })
})
