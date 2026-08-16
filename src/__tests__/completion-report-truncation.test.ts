// A completion report carries at most 500 characters of the close's `result`.
// The cap is fine -- that field is a status summary, not a channel. What was
// not fine is that it cut SILENTLY: the receiver got a sentence that stopped
// mid-word and read as carelessness, and the sender learned nothing at all.
//
// Measured 2026-08-16: 24 completion reports in one evening, every one of them
// exactly 535 characters in the database, and the instructions written into
// them never arrived. An agent noticed the cut-off sentence; the sender spent
// the evening suspecting the agents instead.
import { describe, it, expect } from 'vitest'
import { buildCompletionSummary } from '../web/routes/messages.js'

const CAP = 500

describe('buildCompletionSummary', () => {
  it('passes a short result through untouched and reports no loss', () => {
    const r = buildCompletionSummary('done, nothing to add')
    expect(r.summary).toBe('done, nothing to add')
    expect(r.dropped).toBe(0)
  })

  it('keeps the placeholder when there is no result', () => {
    expect(buildCompletionSummary(undefined)).toEqual({ summary: '(nincs eredmény)', dropped: 0 })
    expect(buildCompletionSummary('')).toEqual({ summary: '(nincs eredmény)', dropped: 0 })
  })

  it('does not touch a result sitting exactly on the cap', () => {
    const exact = 'x'.repeat(CAP)
    const r = buildCompletionSummary(exact)
    expect(r.summary).toBe(exact)
    expect(r.dropped).toBe(0)
  })

  // The regression this exists for: one character over the cap must already
  // announce itself, not wait for a suspiciously round number.
  it('announces the loss one character over the cap', () => {
    const r = buildCompletionSummary('x'.repeat(CAP + 1))
    expect(r.dropped).toBe(1)
    expect(r.summary).toContain('levágva')
  })

  it('keeps the first CAP characters and states exactly how many were dropped', () => {
    const body = 'A'.repeat(CAP) + 'B'.repeat(140)
    const r = buildCompletionSummary(body)
    expect(r.dropped).toBe(140)
    expect(r.summary.startsWith('A'.repeat(CAP))).toBe(true)
    expect(r.summary).not.toContain('B')
    expect(r.summary).toContain('még 140 karakter')
  })

  // The marker has to be findable by a reader who does not know the cap, so it
  // names the number rather than gesturing at "some text was removed".
  it('names the cap in the marker so the reader can act on it', () => {
    const r = buildCompletionSummary('y'.repeat(CAP + 50))
    expect(r.summary).toContain(String(CAP))
    expect(r.summary).toContain('külön üzenetbe')
  })
})
