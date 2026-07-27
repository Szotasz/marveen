import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  saveAgentMemory,
  getAgentMemories,
  updateMemory,
  clearMemoryCache,
} from '../db.js'

// Regression guards for two ways the agent-memory listing could serve a stale
// or silently incomplete picture. Both matter most right after a restart: a
// fresh session builds its idea of "what am I supposed to be doing" from this
// listing, and neither failure mode is visible in the response.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  clearMemoryCache()
})

// ---------------------------------------------------------------------------
// 1. PUT must invalidate the cache even without an agent_id in the body
// ---------------------------------------------------------------------------
describe('updateMemory cache invalidation', () => {
  it('invalidates without an explicit agentId (the normal edit, owner unchanged)', () => {
    const AGENT = 'stale-put-agent'
    const { id } = saveAgentMemory(AGENT, 'Original content', 'hot', 'orig')
    // Warm the cache the way a recall does.
    expect(getAgentMemories(AGENT, 50).some(m => m.content === 'Original content')).toBe(true)

    // The normal PUT: content and category change, ownership does not, so the
    // caller passes no agentId at all.
    updateMemory(id, 'Rewritten content', 'cold')

    const after = getAgentMemories(AGENT, 50)
    const row = after.find(m => m.id === id)
    expect(row?.content).toBe('Rewritten content')
    expect(row?.category).toBe('cold')
  })

  it('invalidates both the old and the new owner when the memory is reassigned', () => {
    const OLD = 'reassign-old-agent'
    const NEW = 'reassign-new-agent'
    const { id } = saveAgentMemory(OLD, 'Handover note', 'hot', 'ho')
    // Warm both agents' caches.
    expect(getAgentMemories(OLD, 50).some(m => m.id === id)).toBe(true)
    expect(getAgentMemories(NEW, 50).some(m => m.id === id)).toBe(false)

    updateMemory(id, 'Handover note', 'hot', NEW)

    // The memory must leave the old owner's list and appear in the new one.
    expect(getAgentMemories(OLD, 50).some(m => m.id === id)).toBe(false)
    expect(getAgentMemories(NEW, 50).some(m => m.id === id)).toBe(true)
  })

  it('invalidates every agent when a shared memory changes', () => {
    const OWNER = 'shared-owner-agent'
    const READER = 'shared-reader-agent'
    const { id } = saveAgentMemory(OWNER, 'Fleet rule v1', 'shared', 'rule')
    // A shared memory shows up in every agent's list, so the reader caches it too.
    expect(getAgentMemories(READER, 50).some(m => m.content === 'Fleet rule v1')).toBe(true)

    updateMemory(id, 'Fleet rule v2', 'shared')

    expect(getAgentMemories(READER, 50).find(m => m.id === id)?.content).toBe('Fleet rule v2')
  })
})

// ---------------------------------------------------------------------------
// 1b. The create path owes the same guarantee as the update path
// ---------------------------------------------------------------------------
describe('saveAgentMemory cache invalidation', () => {
  it('invalidates every agent when a NEW shared memory is created', () => {
    const OWNER = 'shared-create-owner'
    const READER = 'shared-create-reader'
    // The reader warms its list before the shared memory exists.
    const before = getAgentMemories(READER, 50)
    expect(before.some(m => m.content === 'Fleet-wide announcement')).toBe(false)

    saveAgentMemory(OWNER, 'Fleet-wide announcement', 'shared', 'ann')

    // A shared row is listed for every agent, so evicting only the author
    // leaves every other agent serving a list that is missing it -- with
    // nothing in the response to signal the omission.
    expect(getAgentMemories(READER, 50).some(m => m.content === 'Fleet-wide announcement')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Category filtering must happen before the LIMIT, not after
// ---------------------------------------------------------------------------
describe('getAgentMemories category filtering', () => {
  const AGENT = 'category-limit-agent'

  it('returns a hot memory that falls outside the most-recent N rows', () => {
    const db = getDb()
    // One hot memory, then enough newer warm ones to push it past the limit.
    const { id: hotId } = saveAgentMemory(AGENT, 'Priority: ship the thing', 'hot', 'prio')
    // accessed_at drives the ORDER BY; make the hot one genuinely the oldest.
    db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(1000, hotId)
    for (let i = 0; i < 10; i++) {
      const { id } = saveAgentMemory(AGENT, `Filler ${i}`, 'warm', 'filler')
      db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(2000 + i, id)
    }
    clearMemoryCache()

    // With a limit of 5 the hot memory is not among the 5 most recent rows.
    // Asking for hot must still find it -- otherwise a priority silently
    // disappears from a fresh session's view with no truncation signal.
    const hot = getAgentMemories(AGENT, 5, 'hot')
    expect(hot.map(m => m.id)).toContain(hotId)
    expect(hot.every(m => m.category === 'hot')).toBe(true)
  })

  it('caches each category separately from the unfiltered list', () => {
    const A = 'category-cache-agent'
    saveAgentMemory(A, 'Hot one', 'hot', 'h')
    saveAgentMemory(A, 'Warm one', 'warm', 'w')

    const hot = getAgentMemories(A, 50, 'hot')
    const warm = getAgentMemories(A, 50, 'warm')
    const all = getAgentMemories(A, 50)

    // A shared cache key would make these three the same list.
    expect(hot.every(m => m.category === 'hot')).toBe(true)
    expect(warm.every(m => m.category === 'warm')).toBe(true)
    expect(all.length).toBeGreaterThan(hot.length)
  })
})
