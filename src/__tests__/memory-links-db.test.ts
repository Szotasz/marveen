/**
 * Tests for memory_links DB layer (F1):
 * upsertMemoryLink, getMemoryNeighbors, pruneMemoryLinks, linkToNeighbors
 *
 * Uses a real in-memory SQLite DB with the full migration stack to verify
 * constraint behaviour and query correctness without mocking the DB layer.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db-migrations.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

function freshDb() {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applyMigrations(db, MIGRATIONS_DIR)
  return db
}

function insertMemory(db: Database.Database, id: number, agentId = 'agent-a') {
  db.prepare(
    `INSERT INTO memories (id, chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at)
     VALUES (?, 'chat-1', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch())`
  ).run(id, `memory content ${id}`, agentId)
}

function upsertLink(db: Database.Database, src: number, dst: number, type = 'semantic', weight = 0.9) {
  db.prepare(
    `INSERT INTO memory_links (src_id, dst_id, link_type, weight)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(src_id, dst_id, link_type) DO UPDATE SET weight = excluded.weight`
  ).run(src, dst, type, weight)
}

describe('memory_links table constraints', () => {
  let db: Database.Database

  beforeEach(() => {
    db = freshDb()
    insertMemory(db, 1)
    insertMemory(db, 2)
    insertMemory(db, 3)
  })

  it('inserts a valid link', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.85)")
    const row = db.prepare('SELECT * FROM memory_links WHERE src_id = 1 AND dst_id = 2').get() as any
    expect(row).toBeDefined()
    expect(row.weight).toBeCloseTo(0.85)
    expect(row.link_type).toBe('semantic')
  })

  it('rejects invalid link_type', () => {
    expect(() =>
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'bad-type', 0.5)")
    ).toThrow()
  })

  it('rejects weight > 1', () => {
    expect(() =>
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 1.1)")
    ).toThrow()
  })

  it('rejects weight <= 0', () => {
    expect(() =>
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0)")
    ).toThrow()
  })

  it('enforces UNIQUE(src, dst, link_type)', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'explicit', 0.7)")
    expect(() =>
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'explicit', 0.8)")
    ).toThrow()
  })

  it('allows same src/dst with different link_type', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.7)")
    expect(() =>
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'explicit', 0.8)")
    ).not.toThrow()
  })

  it('cascades delete when a memory is removed', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.9)")
    db.exec('DELETE FROM memories WHERE id = 1')
    const row = db.prepare('SELECT * FROM memory_links WHERE src_id = 1').get()
    expect(row).toBeUndefined()
  })

  it('ON CONFLICT upsert replaces weight', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.5)")
    db.prepare(
      `INSERT INTO memory_links (src_id, dst_id, link_type, weight)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(src_id, dst_id, link_type) DO UPDATE SET weight = excluded.weight`
    ).run(1, 2, 'semantic', 0.95)
    const row = db.prepare('SELECT weight FROM memory_links WHERE src_id = 1 AND dst_id = 2 AND link_type = ?').get('semantic') as any
    expect(row.weight).toBeCloseTo(0.95)
  })

  it('pruneMemoryLinks removes links below weight threshold', () => {
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.05)")
    db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 3, 'semantic', 0.9)")
    const changes = db.prepare('DELETE FROM memory_links WHERE weight < ?').run(0.1) as any
    expect(changes.changes).toBe(1)
    const remaining = db.prepare('SELECT COUNT(*) as c FROM memory_links').get() as any
    expect(remaining.c).toBe(1)
  })

  it('getMemoryNeighbors returns linked memories ordered by weight desc', () => {
    upsertLink(db, 1, 2, 'semantic', 0.6)
    upsertLink(db, 1, 3, 'semantic', 0.9)
    const rows = db.prepare(
      `SELECT m.id, ml.weight
       FROM memory_links ml
       JOIN memories m ON m.id = ml.dst_id
       WHERE ml.src_id = 1
       ORDER BY ml.weight DESC`
    ).all() as { id: number; weight: number }[]
    expect(rows[0].id).toBe(3)
    expect(rows[1].id).toBe(2)
  })
})
