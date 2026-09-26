import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { initDatabase, getDb, backfillEmbeddings } from '../db.js'

// BACKFILLHAMISNULLA921. backfillEmbeddings() counted SUCCESSES and returned
// that number, so a sweep over nine un-vectorized rows with the embedder down
// returned 0 -- byte-for-byte the same answer as a sweep that found nothing to
// do. POST /api/memories/backfill then answered {"ok":true,"count":0} and the
// dashboard toasted "0 memories vectorized", which reads as "everything is
// already vectorized". Measured on the live install 2026-09-21: 2 rows with a
// NULL embedding, localhost:11434 unreachable (curl exit 7), response
// {"ok":true,"count":0}.
//
// The sweep must report what it ATTEMPTED, not only what it achieved, and it
// must stop hammering an embedder that is plainly not there.
//
// In-memory SQLite: never touches the real store.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const AGENT = 'backfill-false-zero-agent'
const VECTOR = JSON.stringify([0.1, 0.2, 0.3])

function seedMemory(content: string, embedding: string | null): number {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)
     VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, 'warm', 0, ?, ?)`
  ).run('test-chat', content, now, now, AGENT, 'seed-kw', embedding)
  return Number(info.lastInsertRowid)
}

function clearMemories(): void {
  getDb().prepare('DELETE FROM memories').run()
}

// The sweep reaches the embedder over HTTP; a stubbed fetch is what makes
// "embedder down" and "embedder up" reproducible without running Ollama.
function stubEmbedder(mode: 'down' | 'up'): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    return { json: async () => ({ embedding: [0.4, 0.5, 0.6] }) } as unknown as Response
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearMemories()
})

describe('backfillEmbeddings tells a dead embedder apart from an empty backlog', () => {
  it('an empty backlog reports zero pending and no failure', async () => {
    seedMemory('already vectorized', VECTOR)
    stubEmbedder('down')

    const res = await backfillEmbeddings()

    expect(res.pending).toBe(0)
    expect(res.embedded).toBe(0)
    expect(res.failed).toBe(0)
    expect(res.embedderDown).toBe(false)
  })

  it('a backlog the embedder refuses is NOT reported as a clean zero', async () => {
    seedMemory('row one', null)
    seedMemory('row two', null)
    seedMemory('row three', null)
    stubEmbedder('down')

    const res = await backfillEmbeddings()

    // This is the whole card: same `embedded` as the empty backlog above,
    // every other field different.
    expect(res.embedded).toBe(0)
    expect(res.pending).toBe(3)
    expect(res.failed).toBeGreaterThan(0)
    expect(res.embedderDown).toBe(true)
  })

  it('gives up after a short streak instead of walking the whole backlog', async () => {
    for (let i = 0; i < 40; i++) seedMemory(`row ${i}`, null)
    stubEmbedder('down')

    const started = Date.now()
    const res = await backfillEmbeddings()

    // 40 rows x the inter-row delay would be seconds of waiting on a service
    // that answered the first three calls with ECONNREFUSED.
    expect(res.failed).toBeLessThanOrEqual(5)
    expect(res.pending).toBe(40)
    expect(res.embedderDown).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 10_000)

  it('a working embedder vectorizes the backlog and is not called down', async () => {
    const a = seedMemory('row one', null)
    seedMemory('row two', null)
    stubEmbedder('up')

    const res = await backfillEmbeddings()

    expect(res.pending).toBe(2)
    expect(res.embedded).toBe(2)
    expect(res.failed).toBe(0)
    expect(res.embedderDown).toBe(false)
    const stored = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(a) as
      { embedding: string | null }
    expect(stored.embedding).toBeTruthy()
  }, 10_000)
})
