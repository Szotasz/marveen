// Tests for the sub-agent Telegram inbox wake-nudge.
//
// The pure gate decision (shouldWakeForTelegramInbox) is tested exhaustively
// with no filesystem or tmux, mirroring shouldWakeMainAgent. All five conditions
// (hasPending + age + debounce + session-exists + session-idle) are exercised.

import { describe, it, expect } from 'vitest'
import { shouldWakeForTelegramInbox, wakeBackoffMs } from '../web/telegram-inbox-wake.js'

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

  it('stops nudging once the per-agent attempt budget is exhausted', () => {
    // debounce elapsed and everything else ready, but attempts >= maxAttempts
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 5, maxAttempts: 5,
    })).toBe(false)
    // one under the budget still wakes (backoff window permitting)
    expect(shouldWakeForTelegramInbox({
      ...BASE, lastWakeAt: 0, attempts: 4, maxAttempts: 5,
    })).toBe(true)
  })

  it('applies exponential backoff: a higher attempt count needs a longer gap', () => {
    const commonDebounce = { ...BASE, debounceMs: 60_000, maxDebounceMs: 30 * 60_000 }
    // attempt 2 -> effective gap 60s * 2^2 = 240s. 200s since last nudge: too soon.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 200_000,
    })).toBe(false)
    // 240s since last nudge: exactly at the backed-off boundary -> allowed.
    expect(shouldWakeForTelegramInbox({
      ...commonDebounce, attempts: 2, lastWakeAt: BASE.now - 240_000,
    })).toBe(true)
  })
})

describe('wakeBackoffMs (exponential gap with cap)', () => {
  it('is the base gap at attempt 0 (unchanged first-retry behaviour)', () => {
    expect(wakeBackoffMs(0, 60_000, 30 * 60_000)).toBe(60_000)
  })
  it('doubles per attempt', () => {
    expect(wakeBackoffMs(1, 60_000, 30 * 60_000)).toBe(120_000)
    expect(wakeBackoffMs(3, 60_000, 30 * 60_000)).toBe(480_000)
  })
  it('never exceeds the cap', () => {
    expect(wakeBackoffMs(10, 60_000, 30 * 60_000)).toBe(30 * 60_000)
  })
})
