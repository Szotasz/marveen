import { describe, it, expect } from 'vitest'
import {
  shouldClearStaleHold,
  staleHoldEnterSubmitted,
  decideStuckInputAction,
  STALE_HOLD_CLEAR_MS,
  STALE_HOLD_CLEAR_COOLDOWN_MS,
  type StuckInputActionFacts,
  type StaleHoldFacts,
} from '../pane-state.js'

// The wedge this closes (measured 2026-08-12 on the live install): 100
// `multi-row plain re-inject SUPPRESSED ... holding` lines in dashboard.log,
// across every sub-agent. decideStuckInputAction correctly refuses to submit
// (multi-row) or re-inject (lossy scrape) such a box, but 'hold' was TERMINAL:
// the attempts budget ran out, the watcher alerted "probably needs a manual
// restart", and the pane stayed full until a human pressed Ctrl-C. Aura sat
// wedged for hours and missed its own scheduled restart.

const BASE: StaleHoldFacts = {
  action: 'hold',
  isSubAgent: true,
  parkedForMs: STALE_HOLD_CLEAR_MS,
  sinceLastClearMs: null,
}

describe('stale no-remedy hold -> dump + clear', () => {
  it('clears a sub-agent box wedged in hold past the stale window', () => {
    expect(shouldClearStaleHold(BASE)).toBe(true)
  })

  it('never clears the MAIN session (its box can hold a human draft)', () => {
    expect(shouldClearStaleHold({ ...BASE, isSubAgent: false })).toBe(false)
  })

  it('waits out the stale window -- one tick short does not clear', () => {
    expect(shouldClearStaleHold({ ...BASE, parkedForMs: STALE_HOLD_CLEAR_MS - 1 })).toBe(false)
  })

  it('leaves every action that still has a real move alone', () => {
    for (const action of ['enter', 'reinject-block', 'reinject-plain', 'clear-preamble', 'clear-scheduled'] as const) {
      expect(shouldClearStaleHold({ ...BASE, action })).toBe(false)
    }
  })

  it('honours the cooldown so an unclearable box is not a Ctrl-C storm', () => {
    expect(shouldClearStaleHold({ ...BASE, sinceLastClearMs: STALE_HOLD_CLEAR_COOLDOWN_MS - 1 })).toBe(false)
    expect(shouldClearStaleHold({ ...BASE, sinceLastClearMs: STALE_HOLD_CLEAR_COOLDOWN_MS })).toBe(true)
  })
})

// The gate is only useful if the branch it targets is REACHABLE -- i.e. the
// facts of the real wedge really do decide 'hold'. This pins the shape that
// produced the 100 log lines: a sub-agent, multi-row, machine-injected but
// head-lost parked text (no surviving wrapper marker -> machineOrigin false).
describe('the wedge shape actually reaches hold', () => {
  const HEAD_LOST_SUBAGENT_PARK: StuckInputActionFacts = {
    escalate: true,
    rowCount: 7,
    blockComplete: false,
    blockTruncated: false,
    truncatedPreamble: false,
    allowPlainReinject: true,
    hasPlainText: true,
    scheduledTaskBlock: false,
    machineOrigin: false,
  }

  it('a head-lost multi-row sub-agent park decides hold', () => {
    expect(decideStuckInputAction(HEAD_LOST_SUBAGENT_PARK)).toBe('hold')
  })

  it('and that hold is what the stale gate then clears', () => {
    expect(shouldClearStaleHold({
      action: decideStuckInputAction(HEAD_LOST_SUBAGENT_PARK),
      isSubAgent: true,
      parkedForMs: STALE_HOLD_CLEAR_MS,
      sinceLastClearMs: null,
    })).toBe(true)
  })

  it('a RECOGNISED machine-origin park still re-injects -- unchanged', () => {
    expect(decideStuckInputAction({ ...HEAD_LOST_SUBAGENT_PARK, machineOrigin: true })).toBe('reinject-plain')
  })
})

// ============================================================================
// The bare Enter that runs BEFORE the destructive clear (2026-08-13)
// ============================================================================
//
// The clear was built on the premise that a head-lost park is unrecoverable.
// It is not: sendPromptToSession flattens every prompt to one logical line, and
// the TUI *buffer* keeps the whole payload even when the box renders only its
// tail -- measured on agent-kiddo at 14:07, where a single Enter released a
// 1087-char message whose visible tail was ~360 chars, and the receiving agent
// acted on a paragraph from the message's first third.
//
// The check is OUTCOME-based on purpose: "is this one logical line?" is not
// decidable from the pane (the TUI word-wraps with real newlines, so
// `capture-pane -J` cannot tell a wrap from a typed newline -- measured the
// same day). So we look at what the Enter DID.
describe('bare Enter before the clear -- did it submit?', () => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const box = (...rows: string[]): string => ['', SEP, ...rows, SEP, FOOTER].join('\n')

  const STILL_PARKED = box(
    '❯ [Uzenet @marveen-tol] a hosszu uzenet feje mar lecsuszott a kepernyorol,',
    '  ez csak a farka, tobb sorban tordelve a TUI sajat tordelesevel.',
  )

  it('a box that is still typing means the Enter did NOT submit', () => {
    expect(staleHoldEnterSubmitted(STILL_PARKED)).toBe(false)
  })

  it('an emptied box means the parked text left -- no clear needed', () => {
    expect(staleHoldEnterSubmitted(box('❯ '))).toBe(true)
  })

  it('a busy pane also means it left (the agent is processing it)', () => {
    expect(staleHoldEnterSubmitted(['', '✻ Cogitated for 4s (esc to interrupt)', SEP, '❯ ', SEP, FOOTER].join('\n')))
      .toBe(true)
  })

  // The case that decides the whole design: if the Enter inserted a NEWLINE
  // instead of submitting, the text is still in the box -- just reshaped. A
  // signature comparison (submitLanded) would call that a landed submit,
  // because the signature changed. This must report false so the caller falls
  // back to the dump+clear it would have done anyway.
  it('an inserted newline is NOT a submit, even though the text changed shape', () => {
    const before = STILL_PARKED
    const afterNewline = box(
      '❯ [Uzenet @marveen-tol] a hosszu uzenet feje mar lecsuszott a kepernyorol,',
      '  ez csak a farka, tobb sorban tordelve a TUI sajat tordelesevel.',
      '  ',
    )
    expect(afterNewline).not.toBe(before)
    expect(staleHoldEnterSubmitted(afterNewline)).toBe(false)
  })

  it('a failed capture is never read as success', () => {
    expect(staleHoldEnterSubmitted(null)).toBe(false)
  })
})
