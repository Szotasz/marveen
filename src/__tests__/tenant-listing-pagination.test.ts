import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, listAgentMessages, getAgentConversation, getPendingMessages } from '../db.js'

describe('tenant listing pagination', () => {
  beforeAll(() => {
    initDatabase(':memory:')
    const db = getDb()
    // 6 messages for tenant-a, 6 for tenant-b, LIMIT=5 in tests
    for (let i = 1; i <= 6; i++) {
      db.prepare(
        "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, 'pending', ?, ?)"
      ).run('alpha', 'beta', `msg-a-${i}`, i, 'tenant-a')
      db.prepare(
        "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, 'pending', ?, ?)"
      ).run('gamma', 'delta', `msg-b-${i}`, i + 100, 'tenant-b')
    }
  })

  it('listAgentMessages(5) returns 5 rows for admin (no tenant filter)', () => {
    const rows = listAgentMessages(5)
    expect(rows).toHaveLength(5)
  })

  it('listAgentMessages(5, tenant-a) returns 5 rows all from tenant-a (SQL filters before LIMIT)', () => {
    // Critical: with SQL push-down, LIMIT applies AFTER the WHERE tenant_id=? clause.
    // Without push-down, LIMIT=5 from 12 total would include tenant-b rows, then the
    // JS filter would return fewer than 5 -- starving the tenant-scoped caller.
    const rows = listAgentMessages(5, 'tenant-a')
    expect(rows).toHaveLength(5)
    expect(rows.every(m => m.tenant_id === 'tenant-a')).toBe(true)
  })

  it('listAgentMessages(10, tenant-a) returns exactly 6 rows (all of tenant-a)', () => {
    const rows = listAgentMessages(10, 'tenant-a')
    expect(rows).toHaveLength(6)
    expect(rows.every(m => m.tenant_id === 'tenant-a')).toBe(true)
  })

  it('listAgentMessages(10, tenant-b) returns exactly 6 rows (all of tenant-b)', () => {
    const rows = listAgentMessages(10, 'tenant-b')
    expect(rows).toHaveLength(6)
    expect(rows.every(m => m.tenant_id === 'tenant-b')).toBe(true)
  })

  it('getAgentConversation(alpha, 10, undefined, tenant-a) returns only tenant-a rows', () => {
    const rows = getAgentConversation('alpha', 10, undefined, 'tenant-a')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(m => m.tenant_id === 'tenant-a')).toBe(true)
  })

  it('getPendingMessages(undefined, tenant-a) returns only tenant-a pending rows', () => {
    const rows = getPendingMessages(undefined, 'tenant-a')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(m => m.tenant_id === 'tenant-a')).toBe(true)
  })
})
