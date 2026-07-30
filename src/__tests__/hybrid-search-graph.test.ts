/**
 * F3 integration tests: link-aware hybridSearch 1-hop traversal.
 *
 * Uses real in-memory SQLite (initDatabase) and pre-inserted memory_links
 * to verify the graph expansion logic without mocking internal functions.
 * FTS is relied upon for direct hits; links supply the neighbor expansion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase, getDb,
  hybridSearch, upsertMemoryLink,
} from '../db.js'

const AGENT = 'agent-graph-test'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec(`DELETE FROM memory_links WHERE src_id IN (SELECT id FROM memories WHERE agent_id = '${AGENT}')`)
  getDb().exec(`DELETE FROM memories WHERE agent_id = '${AGENT}'`)
})

function insertMemory(content: string): number {
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, keywords)
     VALUES ('chat-1', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch(), ?)`
  ).run(content, AGENT, content.split(' ').join(',')) as { lastInsertRowid: number | bigint }
  return Number(info.lastInsertRowid)
}

describe('hybridSearch graph traversal (F3)', () => {
  it('linked neighbor of a direct FTS hit appears in results', async () => {
    // "alpha" appears in FTS; "omega unique xyz" does NOT
    const alpha = insertMemory('alpha unique keyword fts hit here')
    const omega = insertMemory('omega unique xyz not matching the fts query')
    upsertMemoryLink(alpha, omega, 'semantic', 0.95)

    const results = await hybridSearch(AGENT, 'alpha unique keyword', 10)
    const ids = results.map(r => r.id)
    expect(ids).toContain(alpha)
    expect(ids).toContain(omega)
  })

  it('direct hit ranks before its linked neighbor', async () => {
    const direct = insertMemory('directhit xq9z7 special term fts ranking')
    const neighbor = insertMemory('neighbor xq9z7 does not match the fts query directly here')
    upsertMemoryLink(direct, neighbor, 'semantic', 0.9)

    const results = await hybridSearch(AGENT, 'directhit xq9z7 special term', 10)
    const directIdx = results.findIndex(r => r.id === direct)
    const neighborIdx = results.findIndex(r => r.id === neighbor)
    // Both must be present
    expect(directIdx).toBeGreaterThanOrEqual(0)
    expect(neighborIdx).toBeGreaterThanOrEqual(0)
    // Direct hit must rank above its neighbor
    expect(directIdx).toBeLessThan(neighborIdx)
  })

  it('memory already in FTS hits is not duplicated via graph traversal', async () => {
    const m1 = insertMemory('dupltest zyxw7 first memory with shared terms')
    const m2 = insertMemory('dupltest zyxw7 second memory also matches fts')
    // m2 is a FTS hit AND a link-neighbor of m1
    upsertMemoryLink(m1, m2, 'semantic', 0.85)

    const results = await hybridSearch(AGENT, 'dupltest zyxw7', 10)
    const m2Count = results.filter(r => r.id === m2).length
    expect(m2Count).toBe(1)
  })

  it('respects the limit parameter after graph expansion', async () => {
    // Create enough memories + links to potentially exceed the limit
    const hub = insertMemory('hubnode kq8v3 central memory term')
    for (let i = 0; i < 8; i++) {
      const spoke = insertMemory(`spoke ${i} kq8v3 connected memory node`)
      upsertMemoryLink(hub, spoke, 'semantic', 0.8)
    }
    const results = await hybridSearch(AGENT, 'hubnode kq8v3', 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('returns empty when no matches and no links', async () => {
    const results = await hybridSearch(AGENT, 'zzz_no_such_term_exists_qx99z_nowhere', 10)
    // Filter to only our test agent's results
    expect(results.filter(r => r.agent_id === AGENT)).toEqual([])
  })
})
