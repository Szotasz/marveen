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

  it('re-injects the full prompt with the idle gate off (box is typing, not idle)', () => {
    expect(SRC).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: false \}\)/)
  })

  it('routes the resubmit action through the pure decision function', () => {
    expect(SRC).toMatch(/decideScheduledResubmitAction\(attempt, stuck\)/)
  })
})
