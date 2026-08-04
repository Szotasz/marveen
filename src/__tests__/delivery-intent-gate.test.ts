/**
 * Tests for the delivery-intent gate wired into decideStuckInputAction.
 *
 * Covers:
 *  - deliveryMatched=true  -> reinject-plain proceeds as before
 *  - deliveryMatched=false -> hold (phantom-inject prevented)
 *  - deliveryMatched=undefined -> open gate (backward-compat / untracked session)
 *  - blockComplete exempt from gate (structural chat_id verification)
 *  - MAIN session unchanged (allowPlainReinject=false, no plain re-inject path)
 *
 * Privacy: no real agent names in fixtures. Neutral identifiers only.
 */

import { describe, it, expect } from 'vitest'
import { decideStuckInputAction, type StuckInputActionFacts } from '../pane-state.js'

function facts(over: Partial<StuckInputActionFacts>): StuckInputActionFacts {
  return {
    escalate: false,
    rowCount: 1,
    blockComplete: false,
    blockTruncated: false,
    truncatedPreamble: false,
    allowPlainReinject: false,
    hasPlainText: false,
    scheduledTaskBlock: false,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// deliveryMatched gate on reinject-plain
// ---------------------------------------------------------------------------

describe('delivery-intent gate -- reinject-plain path', () => {
  it('reinjects when deliveryMatched=true (verified delivery)', () => {
    // Escalated so we reach reinject-plain (not just enter).
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: true,
      deliveryMatched: true,
    }))
    expect(result).toBe('reinject-plain')
  })

  it('holds when deliveryMatched=false (unattributed content)', () => {
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: true,
      deliveryMatched: false,
    }))
    expect(result).toBe('hold')
  })

  it('holds when deliveryMatched=false even without escalation', () => {
    // The gate must fire regardless of escalation state to prevent any re-inject
    // of unattributed content, not just escalated ones.
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: false,
      deliveryMatched: false,
    }))
    expect(result).toBe('hold')
  })

  it('keeps legacy behavior when deliveryMatched=undefined (open gate)', () => {
    // Omitted deliveryMatched = untracked session, fall through to normal path.
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: true,
      deliveryMatched: undefined,
    }))
    expect(result).toBe('reinject-plain')
  })

  it('single-row unescalated verified delivery: enters first (not reinject)', () => {
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: false,
      rowCount: 1,
      deliveryMatched: true,
    }))
    expect(result).toBe('enter')
  })

  it('multi-row verified delivery escalates to reinject-plain', () => {
    const result = decideStuckInputAction(facts({
      allowPlainReinject: true,
      hasPlainText: true,
      escalate: false,
      rowCount: 2,
      deliveryMatched: true,
    }))
    expect(result).toBe('reinject-plain')
  })
})

// ---------------------------------------------------------------------------
// blockComplete is EXEMPT from the delivery gate
// ---------------------------------------------------------------------------

describe('delivery-intent gate -- blockComplete exempt', () => {
  it('reinjects a complete <channel> block even when deliveryMatched=false', () => {
    // Structural chat_id verification makes blockComplete safe regardless of
    // delivery registry state. The gate must NOT apply here.
    const result = decideStuckInputAction(facts({
      blockComplete: true,
      escalate: true,
      deliveryMatched: false,
    }))
    expect(result).toBe('reinject-block')
  })

  it('reinjects a complete block when deliveryMatched=undefined', () => {
    const result = decideStuckInputAction(facts({
      blockComplete: true,
      escalate: true,
      deliveryMatched: undefined,
    }))
    expect(result).toBe('reinject-block')
  })
})

// ---------------------------------------------------------------------------
// MAIN session: allowPlainReinject=false, gate irrelevant
// ---------------------------------------------------------------------------

describe('delivery-intent gate -- MAIN session unchanged', () => {
  it('MAIN stray plain text: hold regardless of deliveryMatched (allowPlainReinject=false)', () => {
    // On MAIN, allowPlainReinject is always false, so the plain-text path is
    // never reached; deliveryMatched has no effect.
    const withMatch = decideStuckInputAction(facts({
      allowPlainReinject: false,
      hasPlainText: true,
      escalate: true,
      deliveryMatched: true,
    }))
    const withoutMatch = decideStuckInputAction(facts({
      allowPlainReinject: false,
      hasPlainText: true,
      escalate: true,
      deliveryMatched: false,
    }))
    // Neither reaches reinject-plain; both fall through to hold/enter depending
    // on rowCount and other facts. With single-row default the exit is 'enter'.
    expect(withMatch).toBe('enter')
    expect(withoutMatch).toBe('enter')
  })
})

// ---------------------------------------------------------------------------
// Signature lockstep: parkedInputText normalisation must round-trip
// through the delivery content for a match to succeed.
//
// This test guards against the "silent recovery failure" regression described
// in the upstream PR comments: if parkedInputText() and the content recorded
// at delivery time diverge (e.g. different whitespace collapsing), no delivery
// will ever match and the recovery silently holds all re-injects.
//
// The registry's matchDelivery trims both sides, so as long as leading/trailing
// whitespace is the only difference, the round-trip holds.
// ---------------------------------------------------------------------------

describe('signature lockstep -- parkedInputText normalisation', () => {
  it('matches when delivery has extra surrounding whitespace vs box content', async () => {
    const { recordDelivery, matchDelivery, clearDeliveries } = await import('../web/delivery-intent.js')
    const SESSION = 'lockstep-session'
    clearDeliveries(SESSION)

    // Delivery recorded with surrounding whitespace (as injected by the router).
    const delivered = '\n  the scheduled task content\n\n'
    recordDelivery(SESSION, delivered)

    // parkedInputText() returns the collapsed text without surrounding whitespace.
    const boxContent = 'the scheduled task content'
    expect(matchDelivery(SESSION, boxContent)).toBe(true)

    clearDeliveries(SESSION)
  })

  it('does NOT match when core content differs (not just whitespace)', async () => {
    const { recordDelivery, matchDelivery, clearDeliveries } = await import('../web/delivery-intent.js')
    const SESSION = 'lockstep-session-2'
    clearDeliveries(SESSION)

    recordDelivery(SESSION, 'original task content')
    expect(matchDelivery(SESSION, 'modified task content')).toBe(false)

    clearDeliveries(SESSION)
  })
})
