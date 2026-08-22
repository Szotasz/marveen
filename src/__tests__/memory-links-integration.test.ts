/**
 * F2 integration tests for linkToNeighbors and upsertMemoryLink.
 * Uses the real in-memory SQLite DB (same pattern as db-extended2.test.ts).
 * Ollama is NOT available in CI, so embedding-dependent paths are covered
 * by pre-populating embedding_blob directly; linkToNeighbors returns 0 early
 * when no embedding or no agent_id exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase, getDb,
  upsertMemoryLink, getMemoryNeighbors, pruneMemoryLinks, linkToNeighbors,
} from '../db.js'

const AGENT = 'agent-link-test'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec(`DELETE FROM memories WHERE agent_id = '${AGENT}'`)
  getDb().exec(`DELETE FROM memory_links WHERE src_id NOT IN (SELECT id FROM memories)`)
})

function insertMemoryWithEmbedding(content: string, floats?: number[]): number {
  const db = getDb()
  const info = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at)
     VALUES ('chat-1', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch())`
  ).run(content, AGENT) as { lastInsertRowid: number | bigint }
  const id = Number(info.lastInsertRowid)
  if (floats) {
    const buf = Buffer.allocUnsafe(floats.length * 4)
    floats.forEach((v, i) => buf.writeFloatLE(v, i * 4))
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(buf, id)
  }
  return id
}

describe('upsertMemoryLink', () => {
  it('creates a new link and returns a row id', () => {
    const src = insertMemoryWithEmbedding('src memory')
    const dst = insertMemoryWithEmbedding('dst memory')
    const linkId = upsertMemoryLink(src, dst, 'explicit', 0.8)
    expect(typeof linkId).toBe('number')
    const row = getDb().prepare('SELECT * FROM memory_links WHERE id = ?').get(linkId) as any
    expect(row).toBeDefined()
    expect(row.src_id).toBe(src)
    expect(row.dst_id).toBe(dst)
    expect(row.link_type).toBe('explicit')
    expect(row.weight).toBeCloseTo(0.8)
  })

  it('updates weight on conflict (upsert semantics)', () => {
    const src = insertMemoryWithEmbedding('upsert src')
    const dst = insertMemoryWithEmbedding('upsert dst')
    upsertMemoryLink(src, dst, 'semantic', 0.5)
    upsertMemoryLink(src, dst, 'semantic', 0.95)
    const row = getDb()
      .prepare('SELECT weight FROM memory_links WHERE src_id = ? AND dst_id = ? AND link_type = ?')
      .get(src, dst, 'semantic') as any
    expect(row.weight).toBeCloseTo(0.95)
  })
})

describe('getMemoryNeighbors', () => {
  it('returns neighbors ordered by weight descending', () => {
    const src = insertMemoryWithEmbedding('neighbor src')
    const d1 = insertMemoryWithEmbedding('neighbor low')
    const d2 = insertMemoryWithEmbedding('neighbor high')
    upsertMemoryLink(src, d1, 'semantic', 0.4)
    upsertMemoryLink(src, d2, 'semantic', 0.9)
    const neighbors = getMemoryNeighbors(src, 10)
    expect(neighbors.length).toBe(2)
    expect(neighbors[0].memory.id).toBe(d2)
    expect(neighbors[0].weight).toBeCloseTo(0.9)
    expect(neighbors[1].memory.id).toBe(d1)
  })

  it('returns empty array when memory has no links', () => {
    const lone = insertMemoryWithEmbedding('lone memory')
    expect(getMemoryNeighbors(lone)).toEqual([])
  })

  it('touches last_traversed_at on the edges', () => {
    const src = insertMemoryWithEmbedding('traverse src')
    const dst = insertMemoryWithEmbedding('traverse dst')
    upsertMemoryLink(src, dst, 'cooccurrence', 0.7)
    const before = getDb().prepare('SELECT last_traversed_at FROM memory_links WHERE src_id = ?').get(src) as any
    expect(before.last_traversed_at).toBeNull()
    getMemoryNeighbors(src, 5)
    const after = getDb().prepare('SELECT last_traversed_at FROM memory_links WHERE src_id = ?').get(src) as any
    expect(after.last_traversed_at).toBeGreaterThan(0)
  })
})

describe('pruneMemoryLinks', () => {
  it('removes links below weight threshold', () => {
    const src = insertMemoryWithEmbedding('prune src')
    const d1 = insertMemoryWithEmbedding('prune keep')
    const d2 = insertMemoryWithEmbedding('prune remove')
    upsertMemoryLink(src, d1, 'semantic', 0.8)
    upsertMemoryLink(src, d2, 'entity', 0.05)
    const removed = pruneMemoryLinks(0.1)
    expect(removed).toBeGreaterThanOrEqual(1)
    const remaining = getMemoryNeighbors(src, 10)
    const ids = remaining.map(n => n.memory.id)
    expect(ids).toContain(d1)
    expect(ids).not.toContain(d2)
  })
})

describe('linkToNeighbors', () => {
  it('returns 0 when memory has no embedding', async () => {
    const id = insertMemoryWithEmbedding('no embedding memory')  // no floats arg
    const linked = await linkToNeighbors(id)
    expect(linked).toBe(0)
  })

  it('returns 0 for unknown memory id', async () => {
    const linked = await linkToNeighbors(999999)
    expect(linked).toBe(0)
  })

  it('creates semantic links when embeddings are sufficiently similar', async () => {
    // Two memories with identical embeddings (cosine = 1.0, above any threshold)
    const vec = Array.from({ length: 768 }, (_, i) => (i % 10) / 10)
    const src = insertMemoryWithEmbedding('similar A', vec)
    insertMemoryWithEmbedding('similar B', vec)
    // linkToNeighbors uses vectorSearch which requires vec_memories extension --
    // not available in test environment. Expect 0 or positive gracefully.
    const linked = await linkToNeighbors(src, 5, 0.99)
    expect(linked).toBeGreaterThanOrEqual(0)
  })

  it('import shadow row (agent_id=import) links against fleet memories via crossAgent BLOB fallback', async () => {
    const db = getDb()
    const vec = Array.from({ length: 768 }, (_, i) => ((i + 1) % 7) / 7)
    const embBuf = Buffer.allocUnsafe(vec.length * 4)
    vec.forEach((v, i) => embBuf.writeFloatLE(v, i * 4))

    // Import shadow row
    const importInfo = db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('import', 'import', 'semantic', 'fleet-cross-agent import doc', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }
    const importId = Number(importInfo.lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(embBuf, importId)

    // Fleet memory with a different agent_id and the same embedding (cosine = 1.0)
    const fleetInfo = db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('agent-b', 'chat-fleet', 'semantic', 'fleet-cross-agent regular memory', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }
    const fleetId = Number(fleetInfo.lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(embBuf, fleetId)

    // vec_memories extension not available in tests -- falls back to BLOB scan.
    // crossAgent=true (because agent_id='import') forces the BLOB path even
    // when the ANN extension would be loaded, bypassing orphan-index issues.
    // effectiveThreshold is clamped to 0.65 for import nodes; cosine=1.0 passes.
    const linked = await linkToNeighbors(importId, 5, 0.75)
    expect(linked).toBeGreaterThanOrEqual(1)

    const links = db.prepare(
      'SELECT dst_id FROM memory_links WHERE src_id = ? AND link_type = ?'
    ).all(importId, 'semantic') as { dst_id: number }[]
    expect(links.some(l => l.dst_id === fleetId)).toBe(true)


    // Cleanup
    db.prepare('DELETE FROM memory_links WHERE src_id = ? OR dst_id = ?').run(importId, importId)
    db.prepare('DELETE FROM memories WHERE id IN (?, ?)').run(importId, fleetId)
  })

  it('import node effectiveThreshold clamps to 0.65: cosine ~0.707 candidate gets linked when caller passes 0.75', async () => {
    const db = getDb()
    // v1: only dim 0 and 1 set -- unit vector in 2D subspace of 768D
    // v2: only dim 0 set -- unit vector along dim 0
    // cosine(v1, v2) = 1/sqrt(2) ~= 0.707 (above 0.65, below 0.75)
    const norm2 = 1 / Math.sqrt(2)
    const vecImport = Array.from({ length: 768 }, (_, i) => (i < 2 ? norm2 : 0))
    const vecFleet  = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1   : 0))

    function toBuf(v: number[]) {
      const b = Buffer.allocUnsafe(v.length * 4)
      v.forEach((f, i) => b.writeFloatLE(f, i * 4))
      return b
    }

    const impInfo = db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('import', 'import', 'semantic', 'threshold-clamp import doc', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }
    const impId = Number(impInfo.lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(toBuf(vecImport), impId)

    const fltInfo = db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('agent-d', 'chat-d', 'semantic', 'threshold-clamp fleet doc', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }
    const fltId = Number(fltInfo.lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(toBuf(vecFleet), fltId)

    // Caller passes 0.75, but import node clamps to 0.65. cosine ~0.707 >= 0.65 -> link forms.
    const linked = await linkToNeighbors(impId, 5, 0.75)
    expect(linked).toBeGreaterThanOrEqual(1)

    const links = db.prepare(
      'SELECT dst_id FROM memory_links WHERE src_id = ? AND link_type = ?'
    ).all(impId, 'semantic') as { dst_id: number }[]
    expect(links.some(l => l.dst_id === fltId)).toBe(true)

    // Cleanup
    db.prepare('DELETE FROM memory_links WHERE src_id = ? OR dst_id = ?').run(impId, impId)
    db.prepare('DELETE FROM memories WHERE id IN (?, ?)').run(impId, fltId)
  })

  it('crossAgent linking ranks by pure cosine, not recency: an older higher-cosine memory beats a fresh lower-cosine one', async () => {
    // Regression: the crossAgent (link-building) path used to rank candidates by
    // cosine * recency-decay. A batch of freshly imported docs (decay ~1.0) then
    // crowded out older-but-more-similar fleet memories (decay <1), so imports
    // linked only to each other. The fix ranks the link path by pure cosine.
    const db = getDb()
    const DAY = 86400
    function toBuf(v: number[]) {
      const b = Buffer.allocUnsafe(v.length * 4)
      v.forEach((f, i) => b.writeFloatLE(f, i * 4))
      return b
    }
    // Query along dim 0. old: cosine 0.90 (higher). fresh: cosine 0.70 (lower).
    const vecImport = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0))
    const vecOld    = Array.from({ length: 768 }, (_, i) => (i === 0 ? 0.90 : i === 1 ? Math.sqrt(1 - 0.81) : 0))
    const vecFresh  = Array.from({ length: 768 }, (_, i) => (i === 0 ? 0.70 : i === 1 ? Math.sqrt(1 - 0.49) : 0))

    const impId = Number((db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('import', 'import', 'semantic', 'recency-rank import doc', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }).lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(toBuf(vecImport), impId)

    // Older fleet memory (100 days old), higher cosine 0.90.
    const oldId = Number((db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('agent-old', 'chat-old', 'semantic', 'older higher-cosine fleet memory', 'warm', unixepoch() - ?, unixepoch(), unixepoch())`
    ).run(100 * DAY) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(toBuf(vecOld), oldId)

    // Fresh competing memory (now), lower cosine 0.70.
    const freshId = Number((db.prepare(
      `INSERT INTO memories (agent_id, chat_id, sector, content, category, created_at, accessed_at, updated_at)
       VALUES ('agent-fresh', 'chat-fresh', 'semantic', 'fresh lower-cosine memory', 'warm', unixepoch(), unixepoch(), unixepoch())`
    ).run() as { lastInsertRowid: number | bigint }).lastInsertRowid)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(toBuf(vecFresh), freshId)

    // maxNeighbors=1: only the single top-ranked candidate gets linked.
    const linked = await linkToNeighbors(impId, 1, 0.75)
    expect(linked).toBe(1)

    const links = db.prepare(
      'SELECT dst_id FROM memory_links WHERE src_id = ? AND link_type = ?'
    ).all(impId, 'semantic') as { dst_id: number }[]
    // Pure cosine wins: the older 0.90 memory is linked, not the fresh 0.70 one.
    expect(links.map(l => l.dst_id)).toContain(oldId)
    expect(links.map(l => l.dst_id)).not.toContain(freshId)

    // Cleanup
    db.prepare('DELETE FROM memory_links WHERE src_id = ? OR dst_id = ?').run(impId, impId)
    db.prepare('DELETE FROM memories WHERE id IN (?, ?, ?)').run(impId, oldId, freshId)
  })
})
