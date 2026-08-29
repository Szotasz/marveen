import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, listAgentMessages, getAgentConversation, getPendingMessages, searchMemories } from '../db.js'
import type { Memory } from '../db.js'

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

describe('tenant memory search pagination (q-only branch)', () => {
  beforeAll(() => {
    initDatabase(':memory:')
    const db = getDb()
    // 4 memories for tenant-a with searchable content, 4 for tenant-b
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        "INSERT INTO memories (chat_id, agent_id, category, sector, content, created_at, accessed_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('test-chat', 'test-agent', 'warm', 'semantic', `uniquetoken alpha content ${i}`, i, i, 'tenant-a')
      db.prepare(
        "INSERT INTO memories (chat_id, agent_id, category, sector, content, created_at, accessed_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run('test-chat', 'test-agent', 'warm', 'semantic', `uniquetoken beta content ${i}`, i + 100, i + 100, 'tenant-b')
    }
  })

  it('searchMemories with tenantId=tenant-a returns only tenant-a rows', () => {
    const rows = searchMemories('uniquetoken', 'test-chat', 10, 'tenant-a')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(m => (m as Memory & { tenant_id?: string }).tenant_id === 'tenant-a')).toBe(true)
  })

  it('searchMemories with tenantId=tenant-b returns only tenant-b rows', () => {
    const rows = searchMemories('uniquetoken', 'test-chat', 10, 'tenant-b')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(m => (m as Memory & { tenant_id?: string }).tenant_id === 'tenant-b')).toBe(true)
  })

  it('LIKE fallback: tenant filter in SQL before LIMIT returns only correct tenant rows', () => {
    // Directly exercise the tcFallback SQL pattern used in the q-only LIKE fallback branch.
    const db = getDb()
    const tcFallback = ' AND tenant_id = ?'
    const tpFallback = ['tenant-a']
    const rows = db.prepare(`SELECT * FROM memories WHERE content LIKE ?${tcFallback} ORDER BY accessed_at DESC LIMIT ?`)
      .all('%uniquetoken%', ...tpFallback, 10) as (Memory & { tenant_id?: string })[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(m => m.tenant_id === 'tenant-a')).toBe(true)
  })
})

