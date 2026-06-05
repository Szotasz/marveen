// Contract tests for shouldAbandon: router never drops a report to a
// busy-but-alive session.
//
// Root cause: the pre-fix startMessageRouter() checked `ageMs > window`
// BEFORE the session-existence check (message-router.ts:59-67). So a
// message sent to the main session, which stays alive but busy (dense
// heartbeats or a long turn), was marked "failed" at the 1h abandon mark
// even though the session never actually went away. Two completion reports
// were silently discarded in the incident that exposed this.
//
// Fix: abandon ONLY when the session is ABSENT for the full window.
// shouldAbandon(sessionExists, ageMs, windowMs) is the pure decision
// function extracted from the loop body; the contract tests pin it.

import { describe, it, expect } from 'vitest'
import { shouldAbandon } from '../web/message-router.js'

const WINDOW_MS = 60 * 60 * 1000 // 1 hour, same as MESSAGE_ABANDON_WINDOW_MS

describe('shouldAbandon: abandon only when session is absent past the window', () => {
  it('returns false when session exists regardless of age', () => {
    // The core invariant: a session that is alive (even if busy for days)
    // must NEVER be abandoned. This was the bug -- the old code abandoned
    // at 1h without checking existence first.
    expect(shouldAbandon(true, WINDOW_MS + 1, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(true, WINDOW_MS * 10, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(true, 0, WINDOW_MS)).toBe(false)
  })

  it('returns false when session is absent but within the window', () => {
    // Session is gone but not yet past the retry window -- keep retrying.
    expect(shouldAbandon(false, WINDOW_MS - 1, WINDOW_MS)).toBe(false)
    expect(shouldAbandon(false, 0, WINDOW_MS)).toBe(false)
  })

  it('returns true when session is absent AND past the window', () => {
    // Only case where abandon is justified: session is truly gone AND the
    // full retry window has elapsed with no delivery.
    expect(shouldAbandon(false, WINDOW_MS + 1, WINDOW_MS)).toBe(true)
    expect(shouldAbandon(false, WINDOW_MS * 2, WINDOW_MS)).toBe(true)
  })

  it('returns false at the exact window boundary (strict greater-than)', () => {
    // Boundary: ageMs === windowMs is NOT yet abandoned (strict >).
    expect(shouldAbandon(false, WINDOW_MS, WINDOW_MS)).toBe(false)
  })
})
