import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, saveAgentMemory, updateMemory,
  recordMemoryRead, recordMemoryReadBatch,
  getStaleMemories, getMemoryVersions, getDb,
  runMemoryMaintenance, pruneMemoryVersions,
} from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

// Helper: insert a memory and return its id
function insertMem(content: string, category: string, agentId: string): number {
  saveAgentMemory(agentId, content, category, 'test keywords')
  const row = getDb()
    .prepare('SELECT id FROM memories WHERE agent_id = ? ORDER BY id DESC LIMIT 1')
    .get(agentId) as { id: number }
  return row.id
}

// ── recordMemoryRead ────────────────────────────────────────────────────────

describe('recordMemoryRead', () => {
  it('inserts a row into span_reads', () => {
    const id = insertMem('read-test content', 'warm', 'agent-a')
    recordMemoryRead('agent-a', id, 'direct')
    const row = getDb()
      .prepare('SELECT * FROM span_reads WHERE agent_id = ? AND memory_id = ?')
      .get('agent-a', id) as { context: string; read_at: number } | undefined
    expect(row).toBeDefined()
    expect(row!.context).toBe('direct')
    expect(row!.read_at).toBeGreaterThan(0)
  })

  it('inserts multiple rows for different contexts', () => {
    const id = insertMem('multi-context content', 'warm', 'agent-a')
    recordMemoryRead('agent-a', id, 'search')
    recordMemoryRead('agent-a', id, 'heartbeat')
    const rows = getDb()
      .prepare('SELECT context FROM span_reads WHERE memory_id = ? ORDER BY id DESC LIMIT 2')
      .all(id) as { context: string }[]
    expect(rows.map(r => r.context)).toEqual(expect.arrayContaining(['search', 'heartbeat']))
  })
})

// ── recordMemoryReadBatch ───────────────────────────────────────────────────

describe('recordMemoryReadBatch', () => {
  it('inserts rows for every id in the batch', () => {
    const idA = insertMem('batch-a', 'warm', 'agent-b')
    const idB = insertMem('batch-b', 'cold', 'agent-b')
    recordMemoryReadBatch('agent-b', [idA, idB], 'search')
    const rows = getDb()
      .prepare('SELECT memory_id FROM span_reads WHERE agent_id = ? AND context = ?')
      .all('agent-b', 'search') as { memory_id: number }[]
    const ids = rows.map(r => r.memory_id)
    expect(ids).toContain(idA)
    expect(ids).toContain(idB)
  })

  it('is a no-op for an empty array', () => {
    const before = (getDb().prepare('SELECT COUNT(*) as c FROM span_reads').get() as { c: number }).c
    recordMemoryReadBatch('agent-b', [], 'search')
    const after = (getDb().prepare('SELECT COUNT(*) as c FROM span_reads').get() as { c: number }).c
    expect(after).toBe(before)
  })
})

// ── getStaleMemories ────────────────────────────────────────────────────────

describe('getStaleMemories', () => {
  it('returns memory never read by the agent', () => {
    const id = insertMem('never-read content', 'warm', 'agent-c')
    // Ensure updated_at is set (migration backfill covers created rows)
    getDb().prepare('UPDATE memories SET updated_at = unixepoch() + 1 WHERE id = ?').run(id)
    const stale = getStaleMemories('agent-c')
    expect(stale.some(m => m.id === id)).toBe(true)
  })

  it('does not return memory read after its last update', () => {
    const id = insertMem('fresh-read content', 'warm', 'agent-d')
    getDb().prepare('UPDATE memories SET updated_at = unixepoch() - 100 WHERE id = ?').run(id)
    // Read it AFTER the update
    recordMemoryRead('agent-d', id, 'direct')
    const stale = getStaleMemories('agent-d')
    expect(stale.some(m => m.id === id)).toBe(false)
  })

  it('returns memory updated after the agent last read it', () => {
    const id = insertMem('stale-after-update', 'warm', 'agent-e')
    // Record a read first, then update the memory
    recordMemoryRead('agent-e', id, 'direct')
    getDb().prepare('UPDATE memories SET updated_at = unixepoch() + 9999, content = ? WHERE id = ?')
      .run('updated stale content', id)
    const stale = getStaleMemories('agent-e')
    expect(stale.some(m => m.id === id)).toBe(true)
  })

  it('includes shared memories for any agent', () => {
    const id = insertMem('shared-memory', 'shared', 'agent-f')
    getDb().prepare('UPDATE memories SET updated_at = unixepoch() + 1 WHERE id = ?').run(id)
    const stale = getStaleMemories('agent-g') // different agent
    expect(stale.some(m => m.id === id)).toBe(true)
  })
})

// ── getMemoryVersions ───────────────────────────────────────────────────────

describe('getMemoryVersions', () => {
  it('returns empty array when memory has never been updated', () => {
    const id = insertMem('virgin content', 'warm', 'agent-h')
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(0)
  })

  it('captures a version when content changes via updateMemory', () => {
    const id = insertMem('original content', 'warm', 'agent-h')
    updateMemory(id, 'updated content', 'warm', 'agent-h', 'keywords')
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(1)
    expect(versions[0].content).toBe('original content')
    expect(versions[0].change_type).toBe('update')
    expect(versions[0].changed_by).toBe('agent-h')
  })

  it('captures a version when category changes via updateMemory', () => {
    const id = insertMem('category-change content', 'warm', 'agent-h')
    updateMemory(id, 'category-change content', 'cold', 'agent-h', undefined)
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(1)
    expect(versions[0].category).toBe('warm')
    expect(versions[0].change_type).toBe('category_change')
  })

  it('accumulates multiple versions in reverse chronological order', () => {
    const id = insertMem('v1', 'warm', 'agent-h')
    updateMemory(id, 'v2', 'warm', 'agent-h', undefined)
    updateMemory(id, 'v3', 'cold', 'agent-h', undefined)
    const versions = getMemoryVersions(id)
    expect(versions.length).toBeGreaterThanOrEqual(2)
    // Most recent change first
    expect(versions[0].content).toBe('v2')
    expect(versions[1].content).toBe('v1')
  })

  it('does not create a version when only accessed_at changes', () => {
    const id = insertMem('access-only', 'warm', 'agent-h')
    getDb().prepare('UPDATE memories SET accessed_at = unixepoch() + 1 WHERE id = ?').run(id)
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(0)
  })

  it('modifiedBy sets changed_by but does NOT overwrite memory agent_id (ownership safety)', () => {
    // Shared memory owned by agent-x; agent-y edits it with modifiedBy
    const id = insertMem('shared content', 'shared', 'agent-x')
    updateMemory(id, 'updated by agent-y', 'shared', undefined, undefined, 'agent-y')

    // Ownership must remain agent-x
    const row = getDb()
      .prepare('SELECT agent_id FROM memories WHERE id = ?')
      .get(id) as { agent_id: string }
    expect(row.agent_id).toBe('agent-x')

    // Version record must attribute the change to agent-y
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(1)
    expect(versions[0].changed_by).toBe('agent-y')
  })
})

// ── runMemoryMaintenance ─────────────────────────────────────────────────────

describe('runMemoryMaintenance', () => {
  it('does NOT move a fresh warm memory to cold even with no reads (brand-new)', () => {
    // created_at = now by default; threshold is 30 days -> must stay warm
    const id = insertMem('brand-new warm content', 'warm', 'agent-i')
    runMemoryMaintenance({ warmToColdDays: 30 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('moves an old unread warm memory to cold (30+ days, no reads)', () => {
    const id = insertMem('old unread warm', 'warm', 'agent-i')
    // Backdate creation to 40 days ago so the age guard passes
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 40 * 86400, id)
    const result = runMemoryMaintenance({ warmToColdDays: 30 })
    expect(result.warmToCold).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('does NOT move an old warm memory to cold when recently read (within window)', () => {
    const id = insertMem('old but active warm', 'warm', 'agent-i')
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 40 * 86400, id)
    // Read 5 days ago -- within 30-day window
    const recentRead = Math.floor(Date.now() / 1000) - 5 * 86400
    getDb().prepare('INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)')
      .run('agent-i', id, recentRead, 'direct')
    runMemoryMaintenance({ warmToColdDays: 30 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('does NOT move hot memory to cold (hot is manually managed)', () => {
    const id = insertMem('idle hot content', 'hot', 'agent-i2')
    // Even with 0-day threshold and old creation date, hot is never in scope
    getDb().prepare('UPDATE memories SET created_at = 0 WHERE id = ?').run(id)
    runMemoryMaintenance({ warmToColdDays: 0 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('hot')
  })

  it('does NOT move shared memory to cold even if unread', () => {
    const id = insertMem('shared unread', 'shared', 'agent-i3')
    getDb().prepare('UPDATE memories SET created_at = 0 WHERE id = ?').run(id)
    runMemoryMaintenance({ warmToColdDays: 0 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('shared')
  })

  it('does NOT move warm memory to cold when recently read (fresh memory)', () => {
    const id = insertMem('active warm content', 'warm', 'agent-j')
    recordMemoryRead('agent-j', id, 'direct')
    runMemoryMaintenance({ warmToColdDays: 30 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('promotes cold memory to warm when read by 2+ distinct agents recently', () => {
    const id = insertMem('resurface cold content', 'cold', 'agent-k')
    recordMemoryRead('agent-k', id, 'direct')
    recordMemoryRead('agent-l', id, 'search')
    const result = runMemoryMaintenance({ coldToWarmDays: 30, minAgents: 2 })
    expect(result.coldToWarm).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('does NOT promote cold memory with only 1 reader', () => {
    const id = insertMem('single-reader cold', 'cold', 'agent-m')
    recordMemoryRead('agent-m', id, 'direct')
    runMemoryMaintenance({ coldToWarmDays: 30, minAgents: 2 })
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('returns prunedVersions count', () => {
    const id = insertMem('versioned for maintenance', 'warm', 'agent-n2')
    updateMemory(id, 'updated content', 'warm', 'agent-n2', undefined)
    getDb().prepare('UPDATE memory_versions SET changed_at = 0 WHERE memory_id = ?').run(id)
    const result = runMemoryMaintenance({ versionTtlDays: 180 })
    expect(result.prunedVersions).toBeGreaterThanOrEqual(1)
  })

  it('migration seed prevents mass cold-demotion on first maintenance run', () => {
    // Simulate pre-existing memories (created 40 days ago, no real reads)
    // and a migration seed (NULL-context span_read inserted at migration time).
    const now = Math.floor(Date.now() / 1000)
    const id1 = insertMem('seeded warm pre-existing', 'warm', 'agent-seed')
    const id2 = insertMem('seeded hot pre-existing', 'hot', 'agent-seed')
    // Backdate creation to simulate memories that existed before span tracing
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id IN (?, ?)')
      .run(now - 40 * 86400, id1, id2)
    // Seed: migration-time span_read with NULL context (matches migration SQL)
    getDb().prepare(
      'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, NULL)'
    ).run('agent-seed', id1, now)
    getDb().prepare(
      'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, NULL)'
    ).run('agent-seed', id2, now)
    // First maintenance run: seed read_at is within 30-day window -> must not demote
    runMemoryMaintenance({ warmToColdDays: 30 })
    const r1 = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id1) as { category: string }
    const r2 = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id2) as { category: string }
    expect(r1.category).toBe('warm')
    expect(r2.category).toBe('hot')
  })
})

// ── pruneMemoryVersions ──────────────────────────────────────────────────────

describe('pruneMemoryVersions', () => {
  it('deletes versions older than the TTL', () => {
    const id = insertMem('versioned content', 'warm', 'agent-n')
    updateMemory(id, 'updated', 'warm', 'agent-n', undefined)
    // Backdate the version to simulate age
    getDb().prepare('UPDATE memory_versions SET changed_at = 0 WHERE memory_id = ?').run(id)
    const pruned = pruneMemoryVersions(180)
    expect(pruned).toBeGreaterThanOrEqual(1)
    expect(getMemoryVersions(id)).toHaveLength(0)
  })

  it('keeps versions within the TTL', () => {
    const id = insertMem('fresh versioned', 'warm', 'agent-o')
    updateMemory(id, 'fresh update', 'warm', 'agent-o', undefined)
    const pruned = pruneMemoryVersions(180)
    expect(pruned).toBe(0)
    expect(getMemoryVersions(id)).toHaveLength(1)
  })
})
