import { describe, it, expect } from 'vitest'
import {
  decideStuckInputAction,
  submitLanded,
  parkedInputRowCount,
  stuckInputSignature,
  type StuckInputActionFacts,
} from '../pane-state.js'

// Delivery-reliability deep-fix (BA56A500): the I/O submit-escalation + post-
// submit verification path. These cover the pure decision (decideStuckInputAction)
// and the two submit predicates (parkedInputRowCount, submitLanded). The pre-
// existing recovery-stack tests (decideStuckInputRecovery et al.) are untouched.

// Realistic `tmux capture-pane -p` fixtures (same box-drawing bytes as
// pane-state.test.ts: U+2500 ─, U+276F ❯).
const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// A single-row parked <channel> block (complete: header + chat_id + close tag).
const PARKED_CHANNEL_SINGLEROW = [
  '',
  SEP,
  '❯ <channel source="plugin:telegram" chat_id="123">rovid uzenet</channel>',
  SEP,
  FOOTER,
].join('\n')

// The same block wrapped across 3 visual rows of the live input box.
const PARKED_CHANNEL_MULTIROW = [
  '',
  SEP,
  '❯ <channel source="plugin:telegram" chat_id="123">Szia, ez egy jó',
  '  hosszú üzenet ami több sorba tördelődött a terminál szélén és',
  '  több vizuális sort foglal el a beviteli dobozban</channel>',
  SEP,
  FOOTER,
].join('\n')

// An idle pane: empty input box, nothing parked.
const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

function facts(over: Partial<StuckInputActionFacts>): StuckInputActionFacts {
  return {
    escalate: false,
    rowCount: 1,
    blockComplete: false,
    blockTruncated: false,
    truncatedPreamble: false,
    allowPlainReinject: false,
    hasPlainText: false,
    ...over,
  }
}

describe('decideStuckInputAction (recovery-decision unit)', () => {
  it('NEVER bare-Enters a multi-row box: complete block -> re-inject, not enter', () => {
    // The core of the fix: a plain Enter on a multi-row parked message inserts a
    // newline (corrupt). Multi-row escalates straight to the chat_id-safe
    // re-inject even before the Enter-first budget is spent.
    const a = decideStuckInputAction(facts({ rowCount: 3, blockComplete: true, escalate: false }))
    expect(a).toBe('reinject-block')
    expect(a).not.toBe('enter')
  })

  it('multi-row truncated <channel> block -> hold (no Enter, no wrong-chat_id re-inject)', () => {
    const a = decideStuckInputAction(facts({ rowCount: 2, blockTruncated: true, escalate: true }))
    expect(a).toBe('hold')
  })

  it('multi-row sub-agent plain text -> re-inject plain, never enter', () => {
    const a = decideStuckInputAction(
      facts({ rowCount: 2, allowPlainReinject: true, hasPlainText: true }),
    )
    expect(a).toBe('reinject-plain')
  })

  it('multi-row with nothing safely re-injectable -> hold (never corrupt via Enter)', () => {
    const a = decideStuckInputAction(facts({ rowCount: 4 }))
    expect(a).toBe('hold')
  })

  it('single-row complete block, pre-escalation -> bare Enter (may submit on its own)', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockComplete: true, escalate: false }))).toBe('enter')
  })

  it('single-row complete block, escalated -> clear + verbatim re-inject', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockComplete: true, escalate: true }))).toBe('reinject-block')
  })

  it('truncation-guard preserved: escalated truncated preamble -> clear only', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, truncatedPreamble: true, escalate: true }))).toBe('clear-preamble')
  })

  it('single-row truncated block keeps the harmless legacy Enter', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, blockTruncated: true, escalate: true }))).toBe('enter')
  })

  it('single-row default (swallowed Enter) -> bare Enter', () => {
    expect(decideStuckInputAction(facts({ rowCount: 1, escalate: true }))).toBe('enter')
  })
})

describe('submitLanded (post-submit verification)', () => {
  it('verified-landed -> stop: the parked signature cleared after submit', () => {
    const prev = stuckInputSignature(PARKED_CHANNEL_SINGLEROW)
    expect(prev).not.toBeNull()
    expect(submitLanded(prev!, IDLE)).toBe(true)
  })

  it('not-landed -> escalate: the same text is still parked after the attempt', () => {
    const prev = stuckInputSignature(PARKED_CHANNEL_SINGLEROW)
    expect(submitLanded(prev!, PARKED_CHANNEL_SINGLEROW)).toBe(false)
  })

  it('null capture after submit -> not landed (cannot confirm -> escalate)', () => {
    const prev = stuckInputSignature(PARKED_CHANNEL_SINGLEROW)
    expect(submitLanded(prev!, null)).toBe(false)
  })
})

describe('parkedInputRowCount', () => {
  it('single-row parked input -> 1', () => {
    expect(parkedInputRowCount(PARKED_CHANNEL_SINGLEROW)).toBe(1)
  })

  it('wrapped multi-row parked input -> >1', () => {
    expect(parkedInputRowCount(PARKED_CHANNEL_MULTIROW)).toBe(3)
  })

  it('idle / empty box -> 0', () => {
    expect(parkedInputRowCount(IDLE)).toBe(0)
  })
})
