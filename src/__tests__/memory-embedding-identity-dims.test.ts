import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// With EMBED_DIMS set, the recorded identity is "<model>@<dims>", so a change of
// the truncation alone marks old vectors as another model's. The default test
// configuration has EMBED_DIMS = 0, so this file pins the truncated case by
// overriding just that one config value.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, EMBED_DIMS: 2 }
})

import { initDatabase, getDb, backfillEmbeddings } from '../db.js'
import { EMBED_MODEL, EMBED_DIMS } from '../config.js'

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: [0.1, 0.2, 0.3] }) })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('embedding identity with EMBED_DIMS', () => {
  it('records "<model>@<dims>" and re-embeds a vector recorded under the bare model name', async () => {
    expect(EMBED_DIMS).toBe(2)
    const now = Math.floor(Date.now() / 1000)
    const insert = getDb().prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
       created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding, embedding_model)
       VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, 'identity-agent', 'warm', 0, NULL, ?, ?)`,
    )
    const fresh = Number(insert.run('fresh row', now, now, null, null).lastInsertRowid)
    const bare = Number(insert.run('bare model row', now, now, JSON.stringify([0.5, 0.5]), EMBED_MODEL).lastInsertRowid)
    await backfillEmbeddings()
    const get = (id: number) => getDb().prepare('SELECT embedding_model FROM memories WHERE id = ?').get(id) as { embedding_model: string | null }
    expect(get(fresh).embedding_model).toBe(`${EMBED_MODEL}@2`)
    expect(get(bare).embedding_model).toBe(`${EMBED_MODEL}@2`)
  })
})
