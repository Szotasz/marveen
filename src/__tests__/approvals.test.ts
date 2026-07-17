import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initDatabase,
  createApproval,
  getApproval,
  resolveApproval,
  listApprovals,
  expireTimedOutApprovals,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
// createApproval
// ---------------------------------------------------------------------------

describe('createApproval', () => {
  it('creates a pending approval with the given fields', () => {
    const a = createApproval({
      id: 'ap-001',
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Send weekly summary',
    })
    expect(a.id).toBe('ap-001')
    expect(a.agent_id).toBe('agent-a')
    expect(a.category).toBe('email_send')
    expect(a.action_description).toBe('Send weekly summary')
    expect(a.status).toBe('pending')
    expect(a.resolved_at).toBeNull()
    expect(a.resolved_by).toBeNull()
    expect(a.telegram_message_id).toBeNull()
  })

  it('stores timeout_at when provided', () => {
    const timeout_at = Math.floor(Date.now() / 1000) + 1800
    const a = createApproval({
      id: 'ap-002',
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'Send report',
      timeout_at,
    })
    expect(a.timeout_at).toBe(timeout_at)
  })

  it('stores null timeout_at when not provided', () => {
    const a = createApproval({
      id: 'ap-003',
      agent_id: 'agent-a',
      category: 'data_delete',
      action_description: 'Delete old logs',
    })
    expect(a.timeout_at).toBeNull()
  })

  it('stores optional action_payload', () => {
    const payload = JSON.stringify({ target: 'logs', older_than_days: 90 })
    const a = createApproval({
      id: 'ap-004',
      agent_id: 'agent-a',
      category: 'data_delete',
      action_description: 'Delete old logs',
      action_payload: payload,
    })
    expect(a.action_payload).toBe(payload)
  })

  it('persists to DB (getApproval returns it)', () => {
    createApproval({ id: 'ap-005', agent_id: 'agent-a', category: 'email_send', action_description: 'x' })
    const fetched = getApproval('ap-005')
    expect(fetched).toBeDefined()
    expect(fetched?.status).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// getApproval
// ---------------------------------------------------------------------------

describe('getApproval', () => {
  it('returns undefined for an unknown id', () => {
    expect(getApproval('nonexistent')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveApproval
// ---------------------------------------------------------------------------

describe('resolveApproval', () => {
  beforeEach(() => {
    createApproval({ id: 'ap-r1', agent_id: 'agent-b', category: 'email_send', action_description: 'Send mail' })
  })

  it('approves a pending approval and returns true', () => {
    const ok = resolveApproval('ap-r1', 'approved', 'telegram_callback')
    expect(ok).toBe(true)
    expect(getApproval('ap-r1')?.status).toBe('approved')
  })

  it('rejects a pending approval and returns true', () => {
    const ok = resolveApproval('ap-r1', 'rejected', 'telegram_callback')
    expect(ok).toBe(true)
    expect(getApproval('ap-r1')?.status).toBe('rejected')
  })

  it('sets resolved_at and resolved_by', () => {
    resolveApproval('ap-r1', 'approved', 'telegram_callback')
    const a = getApproval('ap-r1')
    expect(a?.resolved_at).toBeGreaterThan(0)
    expect(a?.resolved_by).toBe('telegram_callback')
  })

  it('stores telegram_message_id when provided', () => {
    resolveApproval('ap-r1', 'approved', 'telegram_callback', 42001)
    expect(getApproval('ap-r1')?.telegram_message_id).toBe(42001)
  })

  it('returns false for an unknown id', () => {
    expect(resolveApproval('nonexistent', 'approved', 'telegram_callback')).toBe(false)
  })

  it('is idempotent-safe: double-resolve returns false on second call', () => {
    resolveApproval('ap-r1', 'approved', 'telegram_callback')
    // Second call must not overwrite the first decision
    const second = resolveApproval('ap-r1', 'rejected', 'telegram_callback')
    expect(second).toBe(false)
    expect(getApproval('ap-r1')?.status).toBe('approved')
  })
})

// ---------------------------------------------------------------------------
// listApprovals
// ---------------------------------------------------------------------------

describe('listApprovals', () => {
  beforeEach(() => {
    createApproval({ id: 'l-1', agent_id: 'agent-a', category: 'email_send', action_description: 'A' })
    createApproval({ id: 'l-2', agent_id: 'agent-b', category: 'email_send', action_description: 'B' })
    createApproval({ id: 'l-3', agent_id: 'agent-a', category: 'data_delete', action_description: 'C' })
    resolveApproval('l-1', 'approved', 'telegram_callback')
  })

  it('returns all approvals without filter', () => {
    expect(listApprovals({})).toHaveLength(3)
  })

  it('filters by agent_id', () => {
    const result = listApprovals({ agent_id: 'agent-a' })
    expect(result).toHaveLength(2)
    expect(result.every(a => a.agent_id === 'agent-a')).toBe(true)
  })

  it('filters by category', () => {
    const result = listApprovals({ category: 'email_send' })
    expect(result).toHaveLength(2)
    expect(result.every(a => a.category === 'email_send')).toBe(true)
  })

  it('filters by status', () => {
    const pending = listApprovals({ status: 'pending' })
    expect(pending).toHaveLength(2)
    const approved = listApprovals({ status: 'approved' })
    expect(approved).toHaveLength(1)
    expect(approved[0].id).toBe('l-1')
  })

  it('respects limit', () => {
    expect(listApprovals({ limit: 2 })).toHaveLength(2)
  })

  it('returns all items (order is by requested_at DESC, stable in production)', () => {
    // In-memory tests run within the same second so requested_at may be equal;
    // we verify all IDs are present rather than their order.
    const ids = listApprovals({}).map(a => a.id).sort()
    expect(ids).toEqual(['l-1', 'l-2', 'l-3'].sort())
  })
})

// ---------------------------------------------------------------------------
// expireTimedOutApprovals
// ---------------------------------------------------------------------------

describe('expireTimedOutApprovals', () => {
  it('returns 0 when there are no timed-out pending approvals', () => {
    createApproval({
      id: 'e-1',
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'X',
      timeout_at: Math.floor(Date.now() / 1000) + 3600, // 1h in the future
    })
    expect(expireTimedOutApprovals()).toBe(0)
  })

  it('expires approvals whose timeout_at is in the past', () => {
    createApproval({
      id: 'e-2',
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'X',
      timeout_at: Math.floor(Date.now() / 1000) - 1, // 1s in the past
    })
    const expired = expireTimedOutApprovals()
    expect(expired).toBe(1)
    expect(getApproval('e-2')?.status).toBe('timeout')
  })

  it('does not expire approvals without a timeout_at', () => {
    createApproval({ id: 'e-3', agent_id: 'agent-a', category: 'data_delete', action_description: 'X' })
    expect(expireTimedOutApprovals()).toBe(0)
    expect(getApproval('e-3')?.status).toBe('pending')
  })

  it('does not re-expire already-resolved approvals', () => {
    createApproval({
      id: 'e-4',
      agent_id: 'agent-a',
      category: 'email_send',
      action_description: 'X',
      timeout_at: Math.floor(Date.now() / 1000) - 1,
    })
    resolveApproval('e-4', 'approved', 'telegram_callback')
    // Already approved -- expirer must not change it to timeout
    expect(expireTimedOutApprovals()).toBe(0)
    expect(getApproval('e-4')?.status).toBe('approved')
  })
})

// ---------------------------------------------------------------------------
// Fix-revert regression guard
// The resolveApproval idempotency and expiry tests above serve as the
// regression guard: if resolveApproval's WHERE clause loses `AND status = 'pending'`,
// the double-resolve test fails; if expireTimedOutApprovals loses the status
// check, the already-resolved test fails.
// ---------------------------------------------------------------------------
