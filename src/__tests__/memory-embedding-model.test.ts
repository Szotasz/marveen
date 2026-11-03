import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, getDb, hybridSearch, backfillEmbeddings, updateMemory } from '../db.js'
import { EMBED_MODEL, EMBED_DIMS } from '../config.js'

// Vectors record which model wrote them; vector search ignores other models'
// vectors and the backfill re-embeds them. In-memory DB, rows seeded with raw
// SQL (Ollama is not running under test) and the embedding endpoint stubbed.
const IDENTITY = EMBED_DIMS > 0 ? `${EMBED_MODEL}@${EMBED_DIMS}` : EMBED_MODEL
const AGENT = 'embedding-model-agent'
const VECTOR = [0.1, 0.2, 0.3]
const NO_TEXT_MATCH = 'qzxvbnmw'

function seed(content: string, model: string | null, embedding: string = JSON.stringify(VECTOR)): number {
  const now = Math.floor(Date.now() / 1000)
  const info = getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding, embedding_model)
     VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, ?, 'warm', 0, NULL, ?, ?)`
  ).run(content, now, now, AGENT, embedding, model)
  return Number(info.lastInsertRowid)
}

function row(id: number) {
  return getDb().prepare('SELECT embedding, embedding_model FROM memories WHERE id = ?').get(id) as
    { embedding: string | null; embedding_model: string | null }
}

let queryVector: number[] = VECTOR

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  queryVector = VECTOR
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: queryVector }) })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('embedding_model column', () => {
  it('exists after migration', () => {
    const cols = getDb().prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    expect(cols.map(c => c.name)).toContain('embedding_model')
  })

  it('vector search ignores vectors of another model', async () => {
    const a = seed('row a', IDENTITY)
    const b = seed('row b', 'some-other-model')
    const c = seed('row c', null)
    const ids = async () => (await hybridSearch(AGENT, NO_TEXT_MATCH, 10)).map(h => h.id)
    const got = await ids()
    expect(got).toContain(a)
    expect(got).toContain(c)
    expect(got).not.toContain(b)
    getDb().prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(IDENTITY, b)
    expect(await ids()).toContain(b)
  })

  it('the category-filtered vector search ignores them too', async () => {
    const a = seed('row a', IDENTITY)
    const b = seed('row b', 'some-other-model')
    const ids = async () => (await hybridSearch(AGENT, NO_TEXT_MATCH, 10, undefined, 'warm')).map(h => h.id)
    const got = await ids()
    expect(got).toContain(a)
    expect(got).not.toContain(b)
    getDb().prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(IDENTITY, b)
    expect(await ids()).toContain(b)
  })

  it('backfill re-embeds a vector of another model only', async () => {
    queryVector = [9, 8, 7]
    const old = seed('old model row', 'some-other-model')
    const cur = seed('current model row', IDENTITY)
    const r = await backfillEmbeddings()
    expect(r.embedded).toBe(1)
    expect(row(old)).toEqual({ embedding: JSON.stringify([9, 8, 7]), embedding_model: IDENTITY })
    expect(row(cur)).toEqual({ embedding: JSON.stringify(VECTOR), embedding_model: IDENTITY })
  })

  it('an edit that changes the text clears both columns', () => {
    const id = seed('before edit', IDENTITY)
    expect(updateMemory(id, 'after edit')).toBe(true)
    expect(row(id)).toEqual({ embedding: null, embedding_model: null })
  })

  it('records the model plus truncation as identity, and treats another truncation as another model', async () => {
    const fresh = seed('fresh row', null, null as unknown as string)
    await backfillEmbeddings()
    expect(row(fresh).embedding_model).toBe(IDENTITY)
    const other = EMBED_DIMS === 384 ? 383 : 384
    const stale = seed('stale truncation', `${EMBED_MODEL}@${other}`)
    expect(await (async () => (await hybridSearch(AGENT, NO_TEXT_MATCH, 10)).map(h => h.id))()).not.toContain(stale)
    await backfillEmbeddings()
    expect(row(stale).embedding_model).toBe(IDENTITY)
  })

  it('a vector of text edited during the embedding is not written back', async () => {
    const raced = seed('before', null, null as unknown as string)
    const ok = seed('untouched', null, null as unknown as string)
    vi.stubGlobal('fetch', vi.fn(async () => {
      getDb().prepare("UPDATE memories SET content = 'after edit' WHERE id = ? AND content = 'before'").run(raced)
      return { json: async () => ({ embedding: VECTOR }) }
    }))
    const r = await backfillEmbeddings()
    expect(r.embedded).toBe(1) // only the untouched row was stored
    expect(row(raced)).toEqual({ embedding: null, embedding_model: null })
    expect(row(ok)).toEqual({ embedding: JSON.stringify(VECTOR), embedding_model: IDENTITY })
  })
})
