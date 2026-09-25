import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, updateMemory } from '../db.js'

// An edit that changes the embedded text must drop the stored vector, because
// the vector still describes the PREVIOUS text and nothing in the schema
// records that. The next backfillEmbeddings() round regenerates it.
//
// All tests use an in-memory SQLite database so they never touch the real store.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const AGENT = 'embedding-staleness-agent'

// A stand-in for a real vector. Ollama is not running under test, so rows are
// seeded with raw SQL: saveAgentMemory's fire-and-forget embedding never lands
// and would leave every row NULL, which would make the assertions vacuous.
const SENTINEL_EMBEDDING = JSON.stringify([0.1, 0.2, 0.3])

function seedMemory(content: string, keywords: string | null = 'seed-kw'): number {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)
     VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, 'warm', 0, ?, ?)`
  ).run('test-chat', content, now, now, AGENT, keywords, SENTINEL_EMBEDDING)
  return Number(info.lastInsertRowid)
}

function readEmbedding(id: number): string | null {
  return (getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as
    { embedding: string | null }).embedding
}

describe('updateMemory invalidates the stale embedding', () => {
  it('seeded rows really carry an embedding (guards the assertions below)', () => {
    // Without this the "IS NULL" expectations would also pass on a row that
    // never had a vector to begin with.
    expect(readEmbedding(seedMemory('Seed check'))).toBe(SENTINEL_EMBEDDING)
  })

  it('nulls the embedding when the content changes', () => {
    const id = seedMemory('Original content')
    expect(updateMemory(id, 'Rewritten content')).toBe(true)
    expect(readEmbedding(id)).toBeNull()
  })

  it('nulls the embedding when only the keywords change', () => {
    // backfillEmbeddings embeds `content + ' ' + keywords`, so a keywords-only
    // edit leaves exactly the same stale vector as a content edit.
    const id = seedMemory('Unchanged body', 'old-kw')
    expect(updateMemory(id, 'Unchanged body', undefined, undefined, 'new-kw')).toBe(true)
    expect(readEmbedding(id)).toBeNull()
  })

  // Positive control. Without it the suite stays green on an implementation
  // that nulls the embedding on EVERY update -- which would re-embed the whole
  // store on each category retag.
  it('keeps the embedding when only the category changes', () => {
    const id = seedMemory('Body that stays put')
    // The PUT route always resends `content`, so a category-only edit arrives
    // with the identical body. That must not count as a change.
    expect(updateMemory(id, 'Body that stays put', 'cold')).toBe(true)
    expect(readEmbedding(id)).toBe(SENTINEL_EMBEDDING)
  })

  it('keeps the embedding when only the owning agent changes', () => {
    const id = seedMemory('Handover body')
    expect(updateMemory(id, 'Handover body', undefined, 'other-agent')).toBe(true)
    expect(readEmbedding(id)).toBe(SENTINEL_EMBEDDING)
  })

  it('keeps the embedding when the resent keywords are identical', () => {
    const id = seedMemory('Same keywords body', 'kw-a, kw-b')
    expect(updateMemory(id, 'Same keywords body', 'cold', undefined, 'kw-a, kw-b')).toBe(true)
    expect(readEmbedding(id)).toBe(SENTINEL_EMBEDDING)
  })
})
