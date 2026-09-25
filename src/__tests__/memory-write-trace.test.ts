import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, saveAgentMemory, updateMemory, decayMemories } from '../db.js'

// MEMIRASNYOM915: a lost concurrent write on `memories` used to be
// undetectable after the fact -- no updated_at, no writer trace. These tests
// pin the write-trace contract:
//   1. content-shaped updates stamp updated_at (trigger path, raw SQL writer);
//   2. maintenance writes (decay, accessed_at, embedding) do NOT stamp;
//   3. updateMemory() attributes the write (updated_by), and a raw writer
//      never inherits the previous author -- NULL means "unattributed",
//      false attribution is the failure mode this design excludes;
//   4. the trigger cannot recurse even under PRAGMA recursive_triggers=ON.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  // The trigger must be safe in the stricter mode regardless of the runtime
  // default -- prove it there.
  getDb().exec('PRAGMA recursive_triggers=ON')
})

function traceOf(id: number): { updated_at: number | null; updated_by: string | null } {
  return getDb().prepare('SELECT updated_at, updated_by FROM memories WHERE id = ?').get(id) as {
    updated_at: number | null; updated_by: string | null
  }
}

describe('memories write-trace (MEMIRASNYOM915)', () => {
  it('a fresh row carries no trace (NULL = never content-updated)', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    expect(traceOf(id)).toEqual({ updated_at: null, updated_by: null })
  })

  it('a raw content UPDATE (the sqlite3 patch path) stamps updated_at via the trigger', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    getDb().prepare('UPDATE memories SET content = ? WHERE id = ?').run('Patched raw', id)
    const t = traceOf(id)
    expect(t.updated_at).toBeGreaterThan(0)
    expect(t.updated_by).toBeNull()
  })

  it('a raw writer never inherits the previous author', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    updateMemory(id, 'Attributed edit', undefined, undefined, undefined, 'mira')
    expect(traceOf(id).updated_by).toBe('mira')
    // Now a raw write that says nothing about itself: attribution must CLEAR,
    // not stick to mira.
    getDb().prepare('UPDATE memories SET content = ? WHERE id = ?').run('Unattributed overwrite', id)
    const t = traceOf(id)
    expect(t.updated_by).toBeNull()
    expect(t.updated_at).toBeGreaterThan(0)
  })

  it('updateMemory() attributes the write and wins over the trigger', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    expect(updateMemory(id, 'API edit', 'cold', undefined, undefined, 'samu')).toBe(true)
    const t = traceOf(id)
    expect(t.updated_by).toBe('samu')
    expect(t.updated_at).toBeGreaterThan(0)
  })

  it('updateMemory() without attribution writes explicit NULL, not the previous author', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    updateMemory(id, 'First', undefined, undefined, undefined, 'mira')
    updateMemory(id, 'Second, anonymous')
    expect(traceOf(id).updated_by).toBeNull()
  })

  it('maintenance writes do not stamp: decay, accessed_at, embedding', () => {
    const { id } = saveAgentMemory('trace-agent', 'Original', 'hot', 'kw')
    // Backdate created_at so decayMemories() touches this row.
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1000, id)
    decayMemories()
    getDb().prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), id)
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run('[0.1,0.2]', id)
    expect(traceOf(id)).toEqual({ updated_at: null, updated_by: null })
  })

  it('the trigger does not recurse under PRAGMA recursive_triggers=ON (and FTS stays in sync)', () => {
    const { id } = saveAgentMemory('trace-agent', 'Recursion probe alpha', 'hot', 'kw')
    // If the touch trigger re-fired itself, this UPDATE would error (nested
    // trigger depth) or loop; a clean run plus a single consistent trace is
    // the pass.
    getDb().prepare('UPDATE memories SET content = ? WHERE id = ?').run('Recursion probe beta', id)
    expect(traceOf(id).updated_at).toBeGreaterThan(0)
    const fts = getDb().prepare(
      "SELECT count(*) as c FROM memories_fts WHERE memories_fts MATCH 'beta'",
    ).get() as { c: number }
    expect(fts.c).toBe(1)
  })
})
