import { describe, it, expect } from 'vitest'
import { computeBlackboardSignal, type BlackboardSignal } from '../web/routes/blackboard.js'
import type { BlackboardRow } from '../db.js'

// Fixed reference time for deterministic arithmetic.
const NOW = 1_000_000

function row(overrides: Partial<BlackboardRow> = {}): BlackboardRow {
  return {
    id: 'test-id',
    agent_id: 'agent-a',
    status: 'active',
    summary: 'test task',
    task_ref: null,
    updated_at: NOW - 5 * 3600, // 5 hours old by default
    ...overrides,
  }
}

const THRESHOLDS = { msgHours: 2, bbHours: 4, activeHours: 24 }

// Helper: run the function and return the signal.
// lastChangedAt defaults to row.updated_at (simulates "no history entry exists").
function sig(
  r: BlackboardRow,
  lastMsgAt: number | null,
  lastChangedAt = r.updated_at,
  nowSec = NOW,
  thresholds = THRESHOLDS,
): BlackboardSignal {
  return computeBlackboardSignal(r, lastMsgAt, lastChangedAt, nowSec, thresholds)
}

describe('computeBlackboardSignal: signal A (forgot to update)', () => {
  it('returns null when agent sent no recent message', () => {
    // bb is 5h old (> bbHours=4), but no recent message -> no A signal.
    expect(sig(row(), null)).toBeNull()
  })

  it('returns null when agent sent message but bb row is fresh', () => {
    // bb is 2h old (< bbHours=4) -> no A signal even with recent message.
    const freshRow = row({ updated_at: NOW - 2 * 3600 })
    const recentMsg = NOW - 1 * 3600  // 1h ago (within msgHours=2)
    expect(sig(freshRow, recentMsg)).toBeNull()
  })

  it('returns null when last message is older than msgHours', () => {
    // message is 3h ago (> msgHours=2) -> agent not "recently active"
    const oldMsg = NOW - 3 * 3600
    expect(sig(row(), oldMsg)).toBeNull()
  })

  it('returns "a" when agent sent recent message but bb row is stale', () => {
    // bb is 5h old (> bbHours=4), message 1h ago (< msgHours=2) -> signal A.
    const recentMsg = NOW - 1 * 3600
    expect(sig(row(), recentMsg)).toBe('a')
  })
})

describe('computeBlackboardSignal: signal B (stuck / lost completion)', () => {
  it('returns null for active row that is fresh', () => {
    const freshRow = row({ updated_at: NOW - 1 * 3600 })
    expect(sig(freshRow, null)).toBeNull()
  })

  it('returns null for done row that is old', () => {
    // B signal only fires on active rows.
    const doneRow = row({ status: 'done', updated_at: NOW - 25 * 3600 })
    expect(sig(doneRow, null)).toBeNull()
  })

  it('returns null for blocked row that is old', () => {
    const blockedRow = row({ status: 'blocked', updated_at: NOW - 25 * 3600 })
    expect(sig(blockedRow, null)).toBeNull()
  })

  it('returns "b" for active row older than activeHours', () => {
    const staleRow = row({ updated_at: NOW - 25 * 3600 })  // 25h > activeHours=24
    expect(sig(staleRow, null)).toBe('b')
  })
})

describe('computeBlackboardSignal: combined signals', () => {
  it('returns "ab" when both signals fire', () => {
    // bb is 25h old (triggers B), agent sent message 1h ago (triggers A).
    const staleRow = row({ updated_at: NOW - 25 * 3600 })
    const recentMsg = NOW - 1 * 3600
    expect(sig(staleRow, recentMsg)).toBe('ab')
  })

  it('returns null when row is fresh and no recent message', () => {
    const freshRow = row({ updated_at: NOW - 1 * 3600 })
    expect(sig(freshRow, null)).toBeNull()
  })
})

describe('computeBlackboardSignal: signal B uses lastChangedAt, not updated_at', () => {
  it('returns "b" when lastChangedAt is old even if updated_at is recent (no-op write masking)', () => {
    // Simulates schedule-runner writing the same active row every 15 minutes:
    // updated_at is 10 minutes ago (looks fresh), but the row hasn't actually changed in 25 hours.
    // With updated_at as source, Signal B would NOT fire (updated_at is fresh).
    // With lastChangedAt from history, Signal B MUST fire.
    const recentWriteRow = row({ updated_at: NOW - 10 * 60 })  // 10 min ago
    const lastChangedAt = NOW - 25 * 3600                       // 25h ago (old actual change)
    expect(sig(recentWriteRow, null, lastChangedAt)).toBe('b')
  })

  it('returns null when lastChangedAt is recent, even if updated_at is old (inverse sanity check)', () => {
    // A row that looks stale by updated_at but actually changed recently should NOT fire B.
    const staleWriteRow = row({ updated_at: NOW - 25 * 3600 })
    const lastChangedAt = NOW - 1 * 3600  // changed 1h ago
    expect(sig(staleWriteRow, null, lastChangedAt)).toBeNull()
  })

  it('falls back to updated_at when no history exists (lastChangedAt === updated_at)', () => {
    // When there is no history entry, lastChangedAt equals updated_at by convention.
    // Signal B should still fire if updated_at itself is old.
    const staleRow = row({ updated_at: NOW - 25 * 3600 })
    expect(sig(staleRow, null, staleRow.updated_at)).toBe('b')
  })
})

describe('computeBlackboardSignal: threshold boundary precision', () => {
  it('signal A fires at exactly bbHours + 1 second old row', () => {
    const bbBoundaryRow = row({ updated_at: NOW - (4 * 3600 + 1) })
    const recentMsg = NOW - 3600  // 1h ago
    expect(sig(bbBoundaryRow, recentMsg)).toBe('a')
  })

  it('signal A does NOT fire when bb row is exactly bbHours old (not strictly older)', () => {
    const exactRow = row({ updated_at: NOW - 4 * 3600 })
    const recentMsg = NOW - 3600
    // updated_at < nowSec - bbHours*3600 => strict less-than => equal is NOT stale
    expect(sig(exactRow, recentMsg)).toBeNull()
  })

  it('signal B fires at exactly activeHours + 1 second', () => {
    const staleRow = row({ updated_at: NOW - (24 * 3600 + 1) })
    expect(sig(staleRow, null)).toBe('b')
  })

  it('signal B does NOT fire when row is exactly activeHours old', () => {
    const exactRow = row({ updated_at: NOW - 24 * 3600 })
    expect(sig(exactRow, null)).toBeNull()
  })
})
