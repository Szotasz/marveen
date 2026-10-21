// vectorSearch keeps parsed vectors in a cache instead of JSON.parse-ing every
// stored embedding on every call. These tests pin that the cached search answers
// exactly what the uncached one did (same ids, same order, bit-identical scores,
// same floor), that a second call parses nothing, and that a changed vector is
// picked up: by its byte-length fingerprint, or by the explicit forget.
//
// vectorSearch stays module-private (another test pins that), so these go through
// hybridSearch, the exported path that calls it. The query embedding comes from a
// stubbed embedding endpoint, and the query text matches no row, so the keyword
// branch is empty and the answer is the vector branch alone: its ranking, cut at
// its similarity floor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initDatabase, getDb, hybridSearch, vectorSimilarityFloor, clearMemoryCache,
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

function insert(agent: string, category: string, embedding: string, content = `row ${ids.length}`): number {
  const now = Math.floor(Date.now() / 1000)
  const r = getDb().prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
     VALUES ('0', ?, 'semantic', 1.0, ?, ?, ?, ?, NULL, ?)`,
  ).run(content, now, now, agent, category, embedding)
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

// What hybridSearch shows of the vector branch: it asks for twice the limit, keeps
// the rows at or above the floor (a row under it only with keyword support), and
// cuts at the limit.
function expected(agent: string, query: number[], limit: number, category?: string) {
  const { hits, floor } = reference(agent, query, limit * 2, category)
  return hits.filter(h => h.similarity >= floor).slice(0, limit)
}

let queryVector: number[] = []
const NO_TEXT_MATCH = 'qzxvbnmw'

async function vectorBranch(agent: string, query: number[], limit: number, category?: string, text = NO_TEXT_MATCH) {
  queryVector = query
  const trace: Record<string, unknown> = {}
  const hits = await hybridSearch(agent, text, limit, trace as never, category)
  if (text === NO_TEXT_MATCH) expect(trace.ftsHits).toBe(0) // the premise: vector branch alone
  return hits.map(h => ({ id: h.id, similarity: h.similarity }))
}

beforeEach(() => {
  initDatabase(':memory:')
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: queryVector }) })))
  ids = []
  stored.clear()
  for (let i = 0; i < 12; i++) insert('cache', i % 3 === 0 ? 'hot' : 'warm', JSON.stringify(vec(i + 1)))
  insert('other', 'shared', JSON.stringify(vec(99)))
  insert('other', 'warm', JSON.stringify(vec(98))) // not this agent's, not shared: never a candidate
  insert('cache', 'warm', 'not json', 'unparsablemarker')              // unparsable: scored 0, kept
  insert('cache', 'warm', JSON.stringify([1, 2, 3]), 'otherlengthmarker') // another model's length: dropped
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('vectorSearch with the parsed-vector cache', () => {
  it('answers exactly what the uncached search answered: ids, order, scores, floor', async () => {
    const q = vec(7)
    expect(await vectorBranch('cache', q, 5)).toEqual(expected('cache', q, 5))
    expect(await vectorBranch('cache', q, 50)).toEqual(expected('cache', q, 50))
    expect(await vectorBranch('cache', q, 50, 'hot')).toEqual(expected('cache', q, 50, 'hot'))
    // twice more, now from the cache
    expect(await vectorBranch('cache', q, 50)).toEqual(expected('cache', q, 50))
    expect(await vectorBranch('cache', q, 50, 'hot')).toEqual(expected('cache', q, 50, 'hot'))
    // the premise of the comparison: the floor cut something, and something passed it
    expect(expected('cache', q, 50).length).toBeGreaterThan(0)
    expect(expected('cache', q, 50).length).toBeLessThan(reference('cache', q, 100).hits.length)
  })

  it('keeps an unparsable vector at score 0 and drops another length', async () => {
    // Both rows sit under the floor; a keyword hit keeps such a row in the answer,
    // and then its vector score shows: 0 for the kept one, none for the dropped one.
    const bad = ids[ids.length - 10], other = ids[ids.length - 9]
    const kept = await vectorBranch('cache', vec(7), 50, undefined, 'unparsablemarker')
    expect(kept.find(h => h.id === bad)).toEqual({ id: bad, similarity: 0 })
    const dropped = await vectorBranch('cache', vec(7), 50, undefined, 'otherlengthmarker')
    expect(dropped.find(h => h.id === other)).toEqual({ id: other, similarity: undefined })
    const all = await vectorBranch('cache', vec(7), 50)
    const foreign = getDb().prepare("SELECT id FROM memories WHERE agent_id = 'other' AND category != 'shared'").all() as { id: number }[]
    expect(all.some(h => foreign.some(f => f.id === h.id))).toBe(false)
  })

  it('a second call parses no stored vector', async () => {
    const q = vec(7)
    await vectorBranch('cache', q, 5)
    const parse = vi.spyOn(JSON, 'parse')
    await vectorBranch('cache', q, 5)
    const embeddingParses = parse.mock.calls.filter(([text]) => typeof text === 'string' && [...stored.values()].includes(text))
    expect(embeddingParses).toHaveLength(0)
  })

  it('a vector rewritten to another byte length is picked up by the fingerprint', async () => {
    const q = vec(7)
    await vectorBranch('cache', q, 50)
    const id = ids[0]
    // The query's own direction, at another byte length: the row must come out on
    // top, which only the re-read vector can make it do (rows under the floor are
    // not shown, so a change that stays under it would prove nothing).
    const fresh = JSON.stringify(q.map(x => x / 3))
    expect(fresh.length).not.toBe(stored.get(id)!.length)
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(fresh, id)
    stored.set(id, fresh)
    const after = await vectorBranch('cache', q, 50)
    expect(after[0].id).toBe(id)
    expect(after).toEqual(expected('cache', q, 50))
  })

  it('a same-length rewrite is picked up after forgetCachedEmbedding', async () => {
    const q = vec(7)
    await vectorBranch('cache', q, 50)
    const id = ids[0]
    const old = JSON.parse(stored.get(id)!) as number[]
    const same = JSON.stringify([...old].reverse())
    expect(same.length).toBe(stored.get(id)!.length)
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(same, id)
    stored.set(id, same)
    forgetCachedEmbedding(id)
    expect(await vectorBranch('cache', q, 50)).toEqual(expected('cache', q, 50))
  })

  it('initDatabase and clearMemoryCache empty the cache', async () => {
    await vectorBranch('cache', vec(7), 5)
    expect(getEmbeddingCacheSize()).toBeGreaterThan(0)
    clearMemoryCache()
    expect(getEmbeddingCacheSize()).toBe(0)
    await vectorBranch('cache', vec(7), 5)
    expect(getEmbeddingCacheSize()).toBeGreaterThan(0)
    initDatabase(':memory:')
    expect(getEmbeddingCacheSize()).toBe(0)
  })
})
