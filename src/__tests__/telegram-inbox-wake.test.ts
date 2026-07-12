// Tests for the sub-agent Telegram inbox wake-nudge.
//
// The pure gate decision (shouldWakeForTelegramInbox) is tested exhaustively
// with no filesystem or tmux, mirroring shouldWakeMainAgent. All five conditions
// (hasPending + age + debounce + session-exists + session-idle) are exercised.

import { describe, it, expect } from 'vitest'
import { shouldWakeForTelegramInbox } from '../web/telegram-inbox-wake.js'

const BASE = {
  inboxAgeMs: 60_000,
  hasPending: true,
  now: 1_000_000_000,
  lastWakeAt: 0,
  sessionExists: true,
  sessionIdle: true,
  minAgeMs: 25_000,
  debounceMs: 60_000,
}

describe('shouldWakeForTelegramInbox (pure gate decision)', () => {
  it('wakes when inbox has pending content, is old enough, session idle, debounce elapsed', () => {
    expect(shouldWakeForTelegramInbox(BASE)).toBe(true)
  })

  it('does NOT wake when there is nothing pending', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, hasPending: false })).toBe(false)
  })

  it('does NOT wake for a fresh inbox (age gate, strict >)', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 10_000 })).toBe(false)
    // exactly at the threshold is still not old enough
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_000 })).toBe(false)
    expect(shouldWakeForTelegramInbox({ ...BASE, inboxAgeMs: 25_001 })).toBe(true)
  })

  it('does NOT wake within the debounce window of the last nudge', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 30_000 })).toBe(false)
    // exactly at the debounce boundary is allowed
    expect(shouldWakeForTelegramInbox({ ...BASE, lastWakeAt: BASE.now - 60_000 })).toBe(true)
  })

  it('does NOT wake when the sub-agent session is absent', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionExists: false })).toBe(false)
  })

  it('does NOT wake when the session is busy/mid-turn -- avoids the inject race', () => {
    expect(shouldWakeForTelegramInbox({ ...BASE, sessionIdle: false })).toBe(false)
  })
})
