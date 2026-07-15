// Regression tests for the 2026-07-14 incident: the channel-plugin watchdog
// hard-restarted (FRESH session, context destroyed) any agent whose plugin read
// "down" on a SINGLE probe sample -- including agents that were mid-task, and
// including one whose plugin reported healthy a minute later without ever having
// been restarted. Ten such kills in one day; hours of in-flight work lost.
//
// The guards under test: a confirmation window (a lone down sample is not a
// verdict), and a busy-guard (never kill work in flight; escalate instead).
import { describe, it, expect } from 'vitest'
import { decideDownAgentAction } from '../web/agent-restart-policy.js'

const STARTUP = 180_000
const RESTART = 90_000
const CONFIRM = 150_000
const BUSY_CAP = 30 * 60_000
const MAX_ATTEMPTS = 5

// An agent well past every grace: without the new guards this always restarts.
const restartable = {
  processAgeMs: 60 * 60_000,
  msSinceLastRestart: null,
  startupGraceMs: STARTUP,
  restartGraceMs: RESTART,
  consecutiveFailures: 0,
}

describe('down-confirmation window', () => {
  it('does NOT restart on the first down sample (the 19:33 false positive)', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 0,
      downConfirmMs: CONFIRM,
    }, MAX_ATTEMPTS)).toBe('skip')
  })

  it('does NOT restart while the down-spell is shorter than the confirm window', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 60_000,
      downConfirmMs: CONFIRM,
    }, MAX_ATTEMPTS)).toBe('skip')
  })

  it('restarts once the down-spell is confirmed across sweeps', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: CONFIRM,
      downConfirmMs: CONFIRM,
    }, MAX_ATTEMPTS)).toBe('restart')
  })

  it('keeps the legacy single-sample behaviour when no window is configured', () => {
    expect(decideDownAgentAction({ ...restartable }, MAX_ATTEMPTS)).toBe('restart')
  })
})

describe('busy-guard', () => {
  it('defers the restart while the agent is generating', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 10 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: true,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('skip')
  })

  it('restarts a confirmed-down agent that is idle', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 10 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: false,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('restart')
  })

  it('escalates to the operator instead of killing a still-busy agent past the cap', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: BUSY_CAP,
      downConfirmMs: CONFIRM,
      agentBusy: true,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('alert-busy')
  })

  it('defers indefinitely while busy when no cap is configured', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 10 * 60 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: true,
    }, MAX_ATTEMPTS)).toBe('skip')
  })

  it('never restarts a busy agent that is still inside the confirm window', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msDown: 1_000,
      downConfirmMs: CONFIRM,
      agentBusy: true,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('skip')
  })
})

describe('guard interaction with the existing failure cap', () => {
  it('still alerts at the restart cap, even for a busy agent (cap wins)', () => {
    expect(decideDownAgentAction({
      ...restartable,
      consecutiveFailures: MAX_ATTEMPTS,
      msDown: 60 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: true,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('alert')
  })

  it('still honours the startup grace under the new guards', () => {
    expect(decideDownAgentAction({
      ...restartable,
      processAgeMs: 20_000,
      msDown: 60 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: false,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('skip')
  })

  it('still honours the restart back-off under the new guards', () => {
    expect(decideDownAgentAction({
      ...restartable,
      msSinceLastRestart: 30_000,
      msDown: 60 * 60_000,
      downConfirmMs: CONFIRM,
      agentBusy: false,
      busyDeferMaxMs: BUSY_CAP,
    }, MAX_ATTEMPTS)).toBe('skip')
  })
})
