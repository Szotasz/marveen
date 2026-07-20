import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  parseCodexRateLimit,
  forecastCodexLimitExhaustion,
  syncCodexRateLimit,
  type RateLimitSnapshotRow,
} from '../costops/collectors/codex.js'

// The real app-server account/rateLimits/read result shape (proven live 2026-07-15).
const REAL = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1784721994 },
    secondary: null,
    planType: 'plus',
  },
}

describe('parseCodexRateLimit', () => {
  it('parses the app-server rateLimits result', () => {
    const s = parseCodexRateLimit(REAL)
    expect(s).not.toBeNull()
    expect(s?.usedPercent).toBe(9)
    expect(s?.windowDurationMins).toBe(10080)
    expect(s?.resetsAt).toBe(1784721994)
    expect(s?.planType).toBe('plus')
    expect(s?.limitId).toBe('codex')
  })
  it('clamps usedPercent to 0..100', () => {
    expect(parseCodexRateLimit({ rateLimits: { primary: { usedPercent: 150 } } })?.usedPercent).toBe(100)
    expect(parseCodexRateLimit({ rateLimits: { primary: { usedPercent: -5 } } })?.usedPercent).toBe(0)
  })
  it('returns null for malformed input (never a guess)', () => {
    expect(parseCodexRateLimit(null)).toBeNull()
    expect(parseCodexRateLimit({})).toBeNull()
    expect(parseCodexRateLimit({ rateLimits: {} })).toBeNull()               // no primary
    expect(parseCodexRateLimit({ rateLimits: { primary: {} } })).toBeNull()   // no usedPercent
    expect(parseCodexRateLimit('garbage')).toBeNull()
  })
})

describe('forecastCodexLimitExhaustion', () => {
  const day = 86400
  it('returns null with fewer than 2 snapshots', () => {
    expect(forecastCodexLimitExhaustion([{ used_percent: 10, resets_at: null, captured_at: 0 }], day)).toBeNull()
  })
  it('returns null when history span < 1h (too noisy)', () => {
    const snaps: RateLimitSnapshotRow[] = [
      { used_percent: 10, resets_at: null, captured_at: 0 },
      { used_percent: 20, resets_at: null, captured_at: 1800 },
    ]
    expect(forecastCodexLimitExhaustion(snaps, 1800)).toBeNull()
  })
  it('projects reaching 100% from a steady rise', () => {
    // 10% -> 30% over 2 days = 10%/day; remaining 70% -> +7 days from the last snapshot
    const snaps: RateLimitSnapshotRow[] = [
      { used_percent: 10, resets_at: null, captured_at: 0 },
      { used_percent: 30, resets_at: null, captured_at: 2 * day },
    ]
    const at = forecastCodexLimitExhaustion(snaps, 2 * day)
    expect(at).not.toBeNull()
    expect(Math.round(((at as number) - 2 * day) / day)).toBe(7)
  })
  it('ignores a reset (drop) and returns null when net-flat', () => {
    const snaps: RateLimitSnapshotRow[] = [
      { used_percent: 90, resets_at: null, captured_at: 0 },
      { used_percent: 5, resets_at: null, captured_at: 2 * day },
    ]
    expect(forecastCodexLimitExhaustion(snaps, 2 * day)).toBeNull()
  })
})
