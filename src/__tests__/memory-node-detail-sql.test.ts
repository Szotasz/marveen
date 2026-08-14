/**
 * Integration tests for GET /api/memories/:id/detail SQL queries.
 * Uses real in-memory better-sqlite3 -- NOT mocked -- so SQLite syntax
 * errors surface here and not only in production.
 *
 * Fixtures use neutral agent names (agent-a, agent-b) per persona rule.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT,
      topic_key   TEXT,
      content     TEXT    NOT NULL,
      sector      TEXT,
      salience    REAL    DEFAULT 1.0,
      created_at  INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      agent_id    TEXT,
      category    TEXT    DEFAULT 'warm',
      auto_generated INTEGER DEFAULT 0,
      keywords    TEXT,
      updated_at  INTEGER
    );

    CREATE TABLE memory_links (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      src_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      dst_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      link_type        TEXT    NOT NULL,
      weight           REAL    NOT NULL DEFAULT 1.0,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      last_traversed_at INTEGER,
      UNIQUE(src_id, dst_id, link_type)
    );

    CREATE TABLE span_reads (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id  TEXT    NOT NULL,
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      read_at   INTEGER NOT NULL,
      context   TEXT
    );

    CREATE TABLE memory_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      content     TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      keywords    TEXT,
      changed_at  INTEGER NOT NULL,
      changed_by  TEXT    NOT NULL,
      change_type TEXT    NOT NULL
    );
  `)
  return db
}

// The exact neighbor SQL from src/web/routes/memories.ts (must stay in sync)
const NEIGHBOR_SQL = `
  SELECT * FROM (
    SELECT m.id, m.content, m.category, ml.weight, 'outgoing' AS direction
    FROM memory_links ml
    JOIN memories m ON m.id = ml.dst_id
    WHERE ml.src_id = ? AND ml.weight >= 0.75
    ORDER BY ml.weight DESC LIMIT 5
  )
  UNION ALL
  SELECT * FROM (
    SELECT m.id, m.content, m.category, ml.weight, 'incoming' AS direction
    FROM memory_links ml
    JOIN memories m ON m.id = ml.src_id
    WHERE ml.dst_id = ? AND ml.weight >= 0.75
    ORDER BY ml.weight DESC LIMIT 5
  )
`

describe('GET /api/memories/:id/detail -- real SQLite queries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    // Insert two memories: id=1 (agent-a) and id=2 (agent-b)
    db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, keywords, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(1, 'Memory alpha content', 'warm', 'agent-a', 'alpha,test', 1000, 2000)
    db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, keywords, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(2, 'Memory beta content', 'cold', 'agent-b', null, 1200, 1900)
  })

  // --- Base memory query ---

  it('base query returns correct fields for existing memory', () => {
    const row = db.prepare(
      'SELECT id, content, category, agent_id, keywords, created_at, accessed_at FROM memories WHERE id = ?'
    ).get(1) as any
    expect(row).not.toBeNull()
    expect(row.id).toBe(1)
    expect(row.content).toBe('Memory alpha content')
    expect(row.category).toBe('warm')
    expect(row.agent_id).toBe('agent-a')
    expect(row.keywords).toBe('alpha,test')
    expect(row.created_at).toBe(1000)
    expect(row.accessed_at).toBe(2000)
  })

  it('base query returns undefined for non-existent memory id', () => {
    const row = db.prepare(
      'SELECT id, content, category, agent_id, keywords, created_at, accessed_at FROM memories WHERE id = ?'
    ).get(999)
    expect(row).toBeUndefined()
  })

  // --- UNION ALL neighbor query (the bug that caused HTTP 500) ---

  it('neighbor UNION ALL query executes without SQL error', () => {
    // This test would throw if ORDER BY ... LIMIT inside a UNION ALL arm
    // is not wrapped in a subquery (SQLite restriction).
    expect(() => db.prepare(NEIGHBOR_SQL).all(1, 1)).not.toThrow()
  })

  it('neighbor query returns outgoing links ordered by weight desc, capped at 5', () => {
    // Insert 6 outgoing links from node 1 (only top 5 by weight should appear)
    const insertMem = db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertLink = db.prepare(
      'INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (?, ?, ?, ?)'
    )
    for (let i = 10; i <= 15; i++) {
      insertMem.run(i, `Neighbor ${i}`, 'warm', 'agent-b', 1000 + i, 2000 + i)
      insertLink.run(1, i, 'semantic', 0.75 + (i - 10) * 0.03)  // weights 0.75..0.90
    }
    const rows = db.prepare(NEIGHBOR_SQL).all(1, 999) as any[]
    const outgoing = rows.filter(r => r.direction === 'outgoing')
    expect(outgoing.length).toBe(5)  // cap at 5
    // Ordered by weight desc: highest weight first
    for (let i = 0; i < outgoing.length - 1; i++) {
      expect(outgoing[i].weight).toBeGreaterThanOrEqual(outgoing[i + 1].weight)
    }
  })

  it('neighbor query returns incoming links ordered by weight desc, capped at 5', () => {
    const insertMem = db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertLink = db.prepare(
      'INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (?, ?, ?, ?)'
    )
    for (let i = 20; i <= 25; i++) {
      insertMem.run(i, `Incoming ${i}`, 'cold', 'agent-b', 1000 + i, 2000 + i)
      insertLink.run(i, 1, 'semantic', 0.76 + (i - 20) * 0.02)
    }
    const rows = db.prepare(NEIGHBOR_SQL).all(1, 1) as any[]
    const incoming = rows.filter(r => r.direction === 'incoming')
    expect(incoming.length).toBe(5)
    for (let i = 0; i < incoming.length - 1; i++) {
      expect(incoming[i].weight).toBeGreaterThanOrEqual(incoming[i + 1].weight)
    }
  })

  it('neighbor query excludes links with weight < 0.75', () => {
    db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(30, 'Low weight neighbor', 'warm', 'agent-b', 1000, 2000)
    db.prepare(
      'INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (?, ?, ?, ?)'
    ).run(1, 30, 'semantic', 0.74)
    const rows = db.prepare(NEIGHBOR_SQL).all(1, 1) as any[]
    expect(rows.filter(r => r.id === 30)).toHaveLength(0)
  })

  it('neighbor query returns empty array when no links exist', () => {
    const rows = db.prepare(NEIGHBOR_SQL).all(1, 1)
    expect(rows).toHaveLength(0)
  })

  it('neighbor direction field is correct for outgoing vs incoming', () => {
    db.prepare(
      'INSERT INTO memories (id, content, category, agent_id, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(40, 'Linked neighbor', 'warm', 'agent-b', 1000, 2000)
    db.prepare(
      'INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (?, ?, ?, ?)'
    ).run(1, 40, 'semantic', 0.90)  // outgoing from 1
    db.prepare(
      'INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (?, ?, ?, ?)'
    ).run(40, 1, 'semantic', 0.85)  // incoming to 1
    const rows = db.prepare(NEIGHBOR_SQL).all(1, 1) as any[]
    expect(rows.find((r: any) => r.id === 40 && r.direction === 'outgoing')).toBeDefined()
    expect(rows.find((r: any) => r.id === 40 && r.direction === 'incoming')).toBeDefined()
  })

  // --- span_reads read_count query ---

  it('span_reads COUNT query returns correct count', () => {
    db.prepare('INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)').run('agent-a', 1, 1500, 'direct')
    db.prepare('INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)').run('agent-b', 1, 1600, 'search')
    const { cnt } = db.prepare('SELECT COUNT(*) AS cnt FROM span_reads WHERE memory_id = ?').get(1) as any
    expect(cnt).toBe(2)
  })

  it('span_reads COUNT returns 0 when no reads exist', () => {
    const { cnt } = db.prepare('SELECT COUNT(*) AS cnt FROM span_reads WHERE memory_id = ?').get(1) as any
    expect(cnt).toBe(0)
  })

  // --- memory_versions tier history query ---

  it('tier history query returns category_change rows in asc order', () => {
    db.prepare(
      'INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(1, 'Memory alpha content', 'cold', 1400, 'system:maintenance', 'category_change')
    db.prepare(
      'INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(1, 'Memory alpha content', 'warm', 1800, 'system:maintenance', 'category_change')
    const rows = db.prepare(
      `SELECT category, changed_at, changed_by
       FROM memory_versions
       WHERE memory_id = ? AND change_type = 'category_change'
       ORDER BY changed_at ASC`
    ).all(1) as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].changed_at).toBe(1400)
    expect(rows[0].category).toBe('cold')
    expect(rows[1].changed_at).toBe(1800)
    expect(rows[1].category).toBe('warm')
  })

  it('tier history query excludes non-category_change rows', () => {
    db.prepare(
      'INSERT INTO memory_versions (memory_id, content, category, changed_at, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(1, 'Updated content', 'warm', 1300, 'agent-a', 'update')
    const rows = db.prepare(
      `SELECT category, changed_at, changed_by
       FROM memory_versions
       WHERE memory_id = ? AND change_type = 'category_change'
       ORDER BY changed_at ASC`
    ).all(1) as any[]
    expect(rows).toHaveLength(0)
  })
})
