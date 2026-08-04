import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  recordDelivery,
  matchDelivery,
  clearDeliveries,
  _registrySize,
} from '../web/delivery-intent.js'

// Use neutral session names -- no real agent IDs.
const SESSION_A = 'agent-a-session'
const SESSION_B = 'agent-b-session'

beforeEach(() => {
  clearDeliveries(SESSION_A)
  clearDeliveries(SESSION_B)
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe('matchDelivery -- exact match', () => {
  it('matches a recorded delivery (short content, exact)', () => {
    recordDelivery(SESSION_A, 'hello world')
    expect(matchDelivery(SESSION_A, 'hello world')).toBe(true)
  })

  it('ignores leading/trailing whitespace on both sides', () => {
    recordDelivery(SESSION_A, '  hello world  ')
    expect(matchDelivery(SESSION_A, 'hello world')).toBe(true)
  })

  it('does not match a different short string', () => {
    recordDelivery(SESSION_A, 'hello world')
    expect(matchDelivery(SESSION_A, 'goodbye world')).toBe(false)
  })

  it('does not match when nothing was recorded', () => {
    expect(matchDelivery(SESSION_A, 'anything')).toBe(false)
  })

  it('returns false for empty boxContent', () => {
    recordDelivery(SESSION_A, 'something')
    expect(matchDelivery(SESSION_A, '')).toBe(false)
    expect(matchDelivery(SESSION_A, '   ')).toBe(false)
  })

  it('does not cross-contaminate sessions', () => {
    recordDelivery(SESSION_A, 'hello world')
    expect(matchDelivery(SESSION_B, 'hello world')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Truncation-tolerant matching (long content)
// ---------------------------------------------------------------------------

describe('matchDelivery -- truncation-tolerant (long content)', () => {
  // A delivery long enough to exceed the EXACT_MATCH_THRESHOLD (40 chars).
  const LONG_DELIVERY = 'A'.repeat(20) + ' middle content here ' + 'B'.repeat(20)

  it('matches when box shows only a leading prefix of a long delivery', () => {
    recordDelivery(SESSION_A, LONG_DELIVERY)
    // Box shows first 44 chars (> threshold)
    const prefix = LONG_DELIVERY.slice(0, 44)
    expect(matchDelivery(SESSION_A, prefix)).toBe(true)
  })

  it('matches when box shows the full long delivery', () => {
    recordDelivery(SESSION_A, LONG_DELIVERY)
    expect(matchDelivery(SESSION_A, LONG_DELIVERY)).toBe(true)
  })

  it('does NOT match a short coincidental substring of a long delivery', () => {
    recordDelivery(SESSION_A, LONG_DELIVERY)
    // 'middle' is inside the delivery but too short for prefix-match and not exact
    expect(matchDelivery(SESSION_A, 'middle content here')).toBe(false)
  })

  it('does NOT match a long non-prefix of a long delivery', () => {
    recordDelivery(SESSION_A, LONG_DELIVERY)
    // Same length as a valid prefix but different content
    const wrongPrefix = 'Z'.repeat(44)
    expect(matchDelivery(SESSION_A, wrongPrefix)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Freshness window
// ---------------------------------------------------------------------------

describe('matchDelivery -- freshness window', () => {
  it('returns false for a delivery older than 5 minutes', () => {
    vi.useFakeTimers()
    recordDelivery(SESSION_A, 'old content')
    // Advance time past the 5-minute freshness window
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(matchDelivery(SESSION_A, 'old content')).toBe(false)
  })

  it('still matches within the 5-minute window', () => {
    vi.useFakeTimers()
    recordDelivery(SESSION_A, 'recent content')
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(matchDelivery(SESSION_A, 'recent content')).toBe(true)
  })

  it('matches fresh delivery even when an older one expired', () => {
    vi.useFakeTimers()
    recordDelivery(SESSION_A, 'old')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    recordDelivery(SESSION_A, 'fresh')
    expect(matchDelivery(SESSION_A, 'fresh')).toBe(true)
    expect(matchDelivery(SESSION_A, 'old')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ring buffer cap
// ---------------------------------------------------------------------------

describe('ring buffer cap', () => {
  it('evicts the oldest record when RING_CAP (10) is exceeded', () => {
    for (let i = 0; i < 10; i++) {
      recordDelivery(SESSION_A, `entry-${i}`)
    }
    expect(_registrySize(SESSION_A)).toBe(10)

    // The 11th push should evict entry-0
    recordDelivery(SESSION_A, 'entry-10')
    expect(_registrySize(SESSION_A)).toBe(10)
    expect(matchDelivery(SESSION_A, 'entry-0')).toBe(false)
    expect(matchDelivery(SESSION_A, 'entry-10')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clearDeliveries
// ---------------------------------------------------------------------------

describe('clearDeliveries', () => {
  it('removes all records for the session', () => {
    recordDelivery(SESSION_A, 'something')
    clearDeliveries(SESSION_A)
    expect(matchDelivery(SESSION_A, 'something')).toBe(false)
    expect(_registrySize(SESSION_A)).toBe(0)
  })

  it('does not affect other sessions', () => {
    recordDelivery(SESSION_A, 'for-a')
    recordDelivery(SESSION_B, 'for-b')
    clearDeliveries(SESSION_A)
    expect(matchDelivery(SESSION_B, 'for-b')).toBe(true)
  })
})
