import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, saveAgentMemory, syncVecMemoryDelete } from '../db.js'

// ── Ág 1: vec0-mentes regresszió-kapu (CI-ban is fut) ───────────────────────
//
// These tests run without the sqlite-vec extension loaded (which is the normal
// CI environment). They guard against the former bug where INSERT / DELETE on
// the `memories` table would throw "no such module: vec0" because three
// database-level triggers referenced the vec_memories virtual table even when
// the extension was not loaded.
//
// The third test ("no vec_memories_* triggers") is the regression gate: if the
// CREATE TRIGGER blocks ever come back in initVecSupport(), this test turns red
// in CI immediately -- even without vec0 present.

describe('memories: vec0-free write path', () => {
  beforeAll(() => {
    initDatabase(':memory:')
  })

  it('direct INSERT INTO memories does not throw without vec0', () => {
    const db = getDb()
    expect(() =>
      db.prepare(
        "INSERT INTO memories (chat_id, agent_id, category, sector, content, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())"
      ).run('test-chat', 'test-agent', 'warm', 'semantic', 'vec0-free insert test')
    ).not.toThrow()
  })

  it('direct DELETE FROM memories does not throw without vec0', () => {
    const db = getDb()
    const row = db
      .prepare("INSERT INTO memories (chat_id, agent_id, category, sector, content, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())")
      .run('test-chat', 'test-agent', 'cold', 'semantic', 'to be deleted')
    expect(() =>
      db.prepare('DELETE FROM memories WHERE id = ?').run(row.lastInsertRowid)
    ).not.toThrow()
  })

  it('saveAgentMemory does not throw without vec0', () => {
    expect(() =>
      saveAgentMemory('test-agent', 'content for embedding-free save', 'warm', 'keyword1')
    ).not.toThrow()
  })

  it('syncVecMemoryDelete is a no-op (does not throw) without vec0', () => {
    expect(() => syncVecMemoryDelete(9999)).not.toThrow()
  })

  it('no vec_memories_ai/au/ad triggers exist in DB', () => {
    // This is the regression gate: if CREATE TRIGGER blocks come back in
    // initVecSupport(), this test fails in CI before any vec0 is needed.
    const triggers = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'vec_memories_%'"
      )
      .all() as { name: string }[]
    expect(triggers).toHaveLength(0)
  })
})
