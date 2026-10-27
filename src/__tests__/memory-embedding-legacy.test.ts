import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, hybridSearch, backfillEmbeddings } from '../db.js'

// A database from before the embedding_model column gets its vectors stamped
// with the current model on the first start, and a later model switch treats
// them like any other model's vectors.
const cfg = vi.hoisted(() => ({ model: 'legacy-model-a' }))
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, EMBED_DIMS: 0, get EMBED_MODEL() { return cfg.model } }
})

const AGENT = 'embedding-legacy-agent'
const VECTOR = [0.1, 0.2, 0.3]
const NO_TEXT_MATCH = 'qzxvbnmw'

function legacyDb(dir: string) {
  const file = join(dir, 'legacy.db')
  initDatabase(file)
  getDb().close()
  const old = new Database(file)
  old.exec('ALTER TABLE memories DROP COLUMN embedding_model')
  const now = Math.floor(Date.now() / 1000)
  const insert = (content: string, embedding: string | null): number => Number(old.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)
     VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, ?, 'warm', 0, NULL, ?)`
  ).run(content, now, now, AGENT, embedding).lastInsertRowid)
  const withVector = insert('legacy row', JSON.stringify(VECTOR))
  const noVector = insert('legacy row without vector', null)
  old.close()
  return { file, withVector, noVector }
}

function row(id: number) {
  return getDb().prepare('SELECT embedding, embedding_model FROM memories WHERE id = ?').get(id) as
    { embedding: string | null; embedding_model: string | null }
}

let queryVector: number[] = VECTOR

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  cfg.model = 'legacy-model-a'
  queryVector = VECTOR
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: queryVector }) })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('database from before the embedding_model column', () => {
  it('stamps the stored vectors with the current model when the column is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedding-legacy-'))
    try {
      const { file, withVector, noVector } = legacyDb(dir)
      initDatabase(file)
      expect(row(withVector)).toEqual({ embedding: JSON.stringify(VECTOR), embedding_model: 'legacy-model-a' })
      expect(row(noVector)).toEqual({ embedding: null, embedding_model: null })

      // a second start does not stamp again
      getDb().prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run('some-other-model', withVector)
      initDatabase(file)
      expect(row(withVector).embedding_model).toBe('some-other-model')
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('after a model switch a stamped legacy vector is left out of search and re-embedded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedding-legacy-'))
    try {
      const { file, withVector } = legacyDb(dir)
      initDatabase(file)
      const ids = async () => (await hybridSearch(AGENT, NO_TEXT_MATCH, 10)).map(h => h.id)
      expect(await ids()).toContain(withVector)

      cfg.model = 'legacy-model-b'
      expect(await ids()).not.toContain(withVector)

      queryVector = [9, 8, 7]
      await backfillEmbeddings()
      expect(row(withVector)).toEqual({ embedding: JSON.stringify([9, 8, 7]), embedding_model: 'legacy-model-b' })
      expect(await ids()).toContain(withVector)
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
