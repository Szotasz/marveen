import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideScheduledResubmitAction } from '../web/schedule-runner.js'

// A scheduled prompt's closing Enter is occasionally swallowed by the Claude
// TUI in raw mode, leaving the prompt parked in the input box. A parked box
// reads 'typing' (not idle), so isSessionReadyForPrompt() stays false and every
// subsequent scheduled task is deferred -- the session pins itself busy for
// hours on one stranded prompt (2026-07-01: 3223 deferrals, 0/96 heartbeats
// fired in 24h). The old resubmit only pressed bare Enter and gave up after 5;
// a persistently swallowed Enter never recovered. The escalation ladder now
// escalates to a real clear + re-inject.

describe('decideScheduledResubmitAction: post-send resubmit escalation ladder', () => {
  it('does nothing when the prompt is not parked (already submitted)', () => {
    expect(decideScheduledResubmitAction(0, false)).toBe('none')
    expect(decideScheduledResubmitAction(3, false)).toBe('none')
  })

  it('tries a cheap bare Enter for the first two attempts', () => {
    expect(decideScheduledResubmitAction(0, true)).toBe('enter')
    expect(decideScheduledResubmitAction(1, true)).toBe('enter')
  })

  it('escalates to clear + re-inject once bare Enter keeps failing', () => {
    expect(decideScheduledResubmitAction(2, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(3, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(5, true)).toBe('reinject')
  })

  it('gives up at the hard cap so a truly wedged box does not spin forever', () => {
    expect(decideScheduledResubmitAction(6, true)).toBe('giveup')
    expect(decideScheduledResubmitAction(10, true)).toBe('giveup')
  })

  it('never gives up while the box is empty, regardless of attempt count', () => {
    expect(decideScheduledResubmitAction(6, false)).toBe('none')
  })
})

describe('schedule-runner: resubmit wiring uses the real clear + re-inject', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it('imports the verified parked-input clear routine', () => {
    expect(SRC).toMatch(/clearStaleParkedInput/)
  })

  it('re-injects the full prompt with the idle gate off and the lane already held', () => {
    // lockMode 'held' is load-bearing: the re-inject runs INSIDE the recover
    // critical section below; re-acquiring the promise-chain mutex would
    // deadlock the lane.
    expect(SRC).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: false, lockMode: 'held' \}\)/)
  })

  it('routes the resubmit action through the pure decision function', () => {
    expect(SRC).toMatch(/decideScheduledResubmitAction\(attempt, stuck\)/)
  })
})

describe('schedule-runner: resubmit probe+act is a recover-mode critical section (TASKTAIL805)', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it('takes the pane send lane in recover mode around the whole probe+act step', () => {
    // recover, not deliver: acting on a pane mid-delivery is exactly the
    // truncation+duplication bug this exists to prevent, so fail-closed.
    expect(SRC).toMatch(/withSessionSendLock\(session, host, 'recover'/)
  })

  it('skips fail-closed when the lane is busy and retries the SAME attempt', () => {
    // A skip is not an escalation: the pane was never measured, so the attempt
    // counter must not advance (else a busy lane walks the ladder to giveup
    // without a single real probe).
    expect(SRC).toMatch(/resubmit\(attempt, laneBusySkips \+ 1\)/)
  })

  it('bounds the lane-busy skip chain and logs both the skip and the give-up', () => {
    expect(SRC).toMatch(/RESUBMIT_LANE_BUSY_MAX_SKIPS/)
    expect(SRC).toMatch(/resubmit skipped: a delivery is in flight/)
    expect(SRC).toMatch(/lane stayed busy past the skip budget/)
  })

  it('captures the pane INSIDE the critical section, not before it', () => {
    // The measurement must be atomic with the keystroke: a pane sampled outside
    // the lock can change before the Enter/clear lands.
    const lockIdx = SRC.indexOf("withSessionSendLock(session, host, 'recover'")
    const captureIdx = SRC.indexOf('const pane = capturePane(session, host)', SRC.indexOf('const resubmit'))
    expect(lockIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(lockIdx)
  })
})

describe('schedule-runner: resubmit dead ends are compensated, never silent', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it("the 'giveup' exit enqueues a pending retry (the run-log already says 'fired')", () => {
    // attemptFireTask records 'fired' + stamps scheduleLastRun BEFORE the
    // detached resubmit chain runs; a giveup without compensation is a run-log
    // row that says 'fired' for a task that never ran.
    const giveupIdx = SRC.indexOf('still stuck after Enter + re-inject retries -- giving up')
    expect(giveupIdx).toBeGreaterThan(-1)
    const after = SRC.slice(giveupIdx, giveupIdx + 1200)
    expect(after).toMatch(/insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'giveup'\)/)
  })

  it('the lane-busy-exhausted exit enqueues a pending retry too', () => {
    // Exhausting the skip budget exits with NO measurement ever taken -- the
    // prompt may be parked and nothing would ever look again.
    const busyIdx = SRC.indexOf('lane stayed busy past the skip budget')
    expect(busyIdx).toBeGreaterThan(-1)
    const after = SRC.slice(busyIdx, busyIdx + 800)
    expect(after).toMatch(/insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'lane-busy'\)/)
  })
})
