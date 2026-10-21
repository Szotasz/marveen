// vectorSearch keeps parsed vectors in a cache instead of JSON.parse-ing every
// stored embedding on every call. These tests pin that the cached search answers
// exactly what the uncached one did (same ids, same order, bit-identical scores,
// same floor), that a second call parses nothing, and that a changed vector is
// picked up: by its byte-length fingerprint, or by the explicit forget.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, getDb, vectorSearch, vectorSimilarityFloor, clearMemoryCache,
  forgetCachedEmbedding, getEmbeddingCacheSize,
} from '../db.js'

const DIM = 8

// The scoring the uncached search did, written out again as the reference.
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function vec(seed: number): number[] {
  const v: number[] = []
  let s = seed
  for (let i = 0; i < DIM; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    v.push(((s % 2000) - 1000) / 997)
  }
  return v
}

let ids: number[] = []
const stored = new Map<number, string>()

function insert(agent: string, category: string, embedding: string): number {
  const now = Math.floor(Date.now() / 1000)
  const r = getDb().prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
     VALUES ('0', ?, 'semantic', 1.0, ?, ?, ?, ?, NULL, ?)`,
  ).run(`row ${ids.length}`, now, now, agent, category, embedding)
  const id = Number(r.lastInsertRowid)
  ids.push(id)
  stored.set(id, embedding)
  return id
}

// The uncached search, computed in the test from the stored text.
function reference(agent: string, query: number[], limit: number, category?: string) {
  const rows = getDb().prepare(
    `SELECT id, agent_id, category, embedding FROM memories WHERE embedding IS NOT NULL AND (agent_id = ? OR category = 'shared')${category ? ' AND category = ?' : ''}`,
  ).all(...(category ? [agent, category] : [agent])) as { id: number; embedding: string }[]
  const scored = rows.flatMap(r => {
    try {
      const emb = JSON.parse(r.embedding) as number[]
      if (emb.length !== query.length) return []
      return [{ id: r.id, similarity: cosine(query, emb) }]
    } catch {
      return [{ id: r.id, similarity: 0 }]
    }
  })
  const floor = vectorSimilarityFloor(scored.map(s => s.similarity))
  scored.sort((a, b) => b.similarity - a.similarity)
  return { hits: scored.slice(0, limit), floor }
}

const shape = (r: ReturnType<typeof vectorSearch>) => ({ hits: r.hits.map(h => ({ id: h.memory.id, similarity: h.similarity })), floor: r.floor })

beforeEach(() => {
  initDatabase(':memory:')
  ids = []
  stored.clear()
  for (let i = 0; i < 12; i++) insert('cache', i % 3 === 0 ? 'hot' : 'warm', JSON.stringify(vec(i + 1)))
  insert('other', 'shared', JSON.stringify(vec(99)))
  insert('other', 'warm', JSON.stringify(vec(98))) // not this agent's, not shared: never a candidate
  insert('cache', 'warm', 'not json')              // unparsable: scored 0, kept
  insert('cache', 'warm', JSON.stringify([1, 2, 3])) // another model's length: dropped
  insert('cache', 'warm', '{}')                      // parses, but not to an array: dropped
  insert('cache', 'warm', 'null')                    // parses to null: scored 0, like an unparsable text
  insert('cache', 'warm', '"abc"')                   // a string of another length: dropped
  insert('cache', 'warm', JSON.stringify({ length: DIM, 0: 1, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 })) // array-like: scored
  // members that cannot become numbers: the old code dropped the wrong length and scored a throw 0
  const hostile = { toString: 1 }
  insert('cache', 'warm', JSON.stringify([hostile, 2, 3]))
  insert('cache', 'warm', JSON.stringify([hostile, ...vec(42).slice(1)]))
  insert('cache', 'warm', JSON.stringify({ length: DIM, 0: hostile }))
  insert('cache', 'warm', JSON.stringify([null, ...vec(43).slice(1)])) // coerced like the old arithmetic did
})
afterEach(() => { vi.restoreAllMocks() })

describe('vectorSearch with the parsed-vector cache', () => {
  it('answers exactly what the uncached search answered: ids, order, scores, floor', () => {
    const q = vec(7)
    expect(shape(vectorSearch('cache', q, 5))).toEqual(reference('cache', q, 5))
    expect(shape(vectorSearch('cache', q, 50))).toEqual(reference('cache', q, 50))
    expect(shape(vectorSearch('cache', q, 50, 'hot'))).toEqual(reference('cache', q, 50, 'hot'))
    // twice more, now from the cache
    expect(shape(vectorSearch('cache', q, 50))).toEqual(reference('cache', q, 50))
    expect(shape(vectorSearch('cache', q, 50, 'hot'))).toEqual(reference('cache', q, 50, 'hot'))
    // and for a degenerate, zero-length query
    expect(shape(vectorSearch('cache', [], 50))).toEqual(reference('cache', [], 50))
  })

  it('keeps an unparsable vector at score 0 and drops another length', () => {
    const r = vectorSearch('cache', vec(7), 50)
    const bad = ids[ids.length - 10], other = ids[ids.length - 9]
    expect(r.hits.find(h => h.memory.id === bad)?.similarity).toBe(0)
    expect(r.hits.some(h => h.memory.id === other)).toBe(false)
    expect(r.hits.some(h => h.memory.agent_id === 'other' && h.memory.category !== 'shared')).toBe(false)
  })

  it('a second call parses no stored vector', () => {
    const q = vec(7)
    vectorSearch('cache', q, 5)
    const parse = vi.spyOn(JSON, 'parse')
    vectorSearch('cache', q, 5)
    const embeddingParses = parse.mock.calls.filter(([text]) => typeof text === 'string' && [...stored.values()].includes(text))
    expect(embeddingParses).toHaveLength(0)
  })

  it('a vector rewritten to another byte length is picked up by the fingerprint', () => {
    const q = vec(7)
    vectorSearch('cache', q, 50)
    const id = ids[0]
    const fresh = JSON.stringify(vec(500).map(x => x / 3))
    expect(fresh.length).not.toBe(stored.get(id)!.length)
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(fresh, id)
    stored.set(id, fresh)
    expect(shape(vectorSearch('cache', q, 50))).toEqual(reference('cache', q, 50))
  })

  it('a same-length rewrite is picked up after forgetCachedEmbedding', () => {
    const q = vec(7)
    vectorSearch('cache', q, 50)
    const id = ids[0]
    const old = JSON.parse(stored.get(id)!) as number[]
    const same = JSON.stringify([...old].reverse())
    expect(same.length).toBe(stored.get(id)!.length)
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(same, id)
    stored.set(id, same)
    forgetCachedEmbedding(id)
    expect(shape(vectorSearch('cache', q, 50))).toEqual(reference('cache', q, 50))
  })

  it('initDatabase and clearMemoryCache empty the cache', () => {
    vectorSearch('cache', vec(7), 5)
    expect(getEmbeddingCacheSize()).toBeGreaterThan(0)
    clearMemoryCache()
    expect(getEmbeddingCacheSize()).toBe(0)
    vectorSearch('cache', vec(7), 5)
    expect(getEmbeddingCacheSize()).toBeGreaterThan(0)
    initDatabase(':memory:')
    expect(getEmbeddingCacheSize()).toBe(0)
  })
})
