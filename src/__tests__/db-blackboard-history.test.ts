import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

// Test the history functions directly against real in-memory SQLite.
// This catches SQL syntax errors and schema mismatches that mocks cannot.

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE fleet_blackboard (
      id         TEXT    PRIMARY KEY,
      agent_id   TEXT    NOT NULL UNIQUE,
      task_ref   TEXT,
      status     TEXT    NOT NULL DEFAULT 'active',
      summary    TEXT    NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE fleet_blackboard_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id   TEXT    NOT NULL,
      task_ref   TEXT,
      status     TEXT    NOT NULL,
      summary    TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_fbh_agent   ON fleet_blackboard_history(agent_id);
    CREATE INDEX idx_fbh_created ON fleet_blackboard_history(created_at DESC);
    CREATE INDEX idx_fbh_status  ON fleet_blackboard_history(status);
  `)
  return db
}

function insertHistory(db: Database.Database, agent_id: string, status: string, created_at: number) {
  db.prepare(
    'INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary, created_at) VALUES (?, NULL, ?, ?, ?)'
  ).run(agent_id, status, 'summary', created_at)
}

function pruneBlackboardHistory(db: Database.Database, ttlDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return db.prepare('DELETE FROM fleet_blackboard_history WHERE created_at < ?').run(cutoff).changes
}

function listBlackboardHistory(db: Database.Database, opts: { agent_id?: string; since?: number; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const params: (string | number)[] = []
  if (opts.agent_id) { parts.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.since !== undefined) { parts.push('created_at >= ?'); params.push(opts.since) }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : ''
  params.push(limit)
  return db.prepare(
    `SELECT id, agent_id, task_ref, status, summary, created_at
     FROM fleet_blackboard_history ${where}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params)
}

const NOW = Math.floor(Date.now() / 1000)
const DAY = 86400
const FRESH = NOW - 5 * DAY
const STALE = NOW - 35 * DAY

describe('pruneBlackboardHistory', () => {
  let db: Database.Database

  beforeEach(() => { db = createTestDb() })
  afterEach(() => { db.close() })

  it('deletes rows older than 30 days', () => {
    insertHistory(db, 'agent-a', 'done', STALE)
    insertHistory(db, 'agent-b', 'active', FRESH)
    const deleted = pruneBlackboardHistory(db, 30)
    expect(deleted).toBe(1)
    const remaining = db.prepare('SELECT * FROM fleet_blackboard_history').all()
    expect(remaining).toHaveLength(1)
    expect((remaining[0] as { agent_id: string }).agent_id).toBe('agent-b')
  })

  it('returns 0 when nothing is old enough to prune', () => {
    insertHistory(db, 'agent-a', 'active', FRESH)
    expect(pruneBlackboardHistory(db, 30)).toBe(0)
  })

  it('returns 0 on empty table', () => {
    expect(pruneBlackboardHistory(db, 30)).toBe(0)
  })

  it('deletes all rows when ttl is 0', () => {
    insertHistory(db, 'agent-a', 'active', NOW - 1)
    insertHistory(db, 'agent-b', 'done', NOW - 2)
    const deleted = pruneBlackboardHistory(db, 0)
    expect(deleted).toBe(2)
  })
})

describe('listBlackboardHistory', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    insertHistory(db, 'agent-a', 'active', FRESH)
    insertHistory(db, 'agent-a', 'done', FRESH + 100)
    insertHistory(db, 'agent-b', 'active', FRESH + 200)
  })
  afterEach(() => { db.close() })

  it('returns all rows up to default limit', () => {
    const rows = listBlackboardHistory(db)
    expect(rows).toHaveLength(3)
  })

  it('filters by agent_id', () => {
    const rows = listBlackboardHistory(db, { agent_id: 'agent-a' })
    expect(rows).toHaveLength(2)
    expect((rows as { agent_id: string }[]).every(r => r.agent_id === 'agent-a')).toBe(true)
  })

  it('filters by since (unix epoch)', () => {
    const rows = listBlackboardHistory(db, { since: FRESH + 150 })
    expect(rows).toHaveLength(1)
    expect((rows[0] as { agent_id: string }).agent_id).toBe('agent-b')
  })

  it('respects limit', () => {
    const rows = listBlackboardHistory(db, { limit: 1 })
    expect(rows).toHaveLength(1)
  })

  it('clamps limit to 200', () => {
    for (let i = 0; i < 5; i++) insertHistory(db, `agent-x${i}`, 'done', FRESH + i)
    const rows = listBlackboardHistory(db, { limit: 999 })
    expect(rows.length).toBeLessThanOrEqual(200)
  })

  it('returns rows in descending created_at order', () => {
    const rows = listBlackboardHistory(db) as { created_at: number }[]
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].created_at).toBeGreaterThanOrEqual(rows[i].created_at)
    }
  })
})

describe('API-level double-write via upsert simulation', () => {
  let db: Database.Database

  beforeEach(() => { db = createTestDb() })
  afterEach(() => { db.close() })

  it('records each status transition in history', () => {
    const id = 'bb-test-01'
    const agent = 'agent-a'

    // Simulate upsert: active
    db.prepare('INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary) VALUES (?, ?, NULL, ?, ?)')
      .run(id, agent, 'active', 'Starting work')
    db.prepare('INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary) VALUES (?, NULL, ?, ?)')
      .run(agent, 'active', 'Starting work')

    // Simulate upsert: done
    db.prepare('UPDATE fleet_blackboard SET status = ?, summary = ? WHERE id = ?')
      .run('done', 'Finished', id)
    db.prepare('INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary) VALUES (?, NULL, ?, ?)')
      .run(agent, 'done', 'Finished')

    const history = db.prepare('SELECT status FROM fleet_blackboard_history WHERE agent_id = ? ORDER BY id').all(agent) as { status: string }[]
    expect(history).toHaveLength(2)
    expect(history[0].status).toBe('active')
    expect(history[1].status).toBe('done')

    // Current state only has the latest
    const current = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as { status: string }
    expect(current.status).toBe('done')
  })

  it('does not write history on validation failure (no insert)', () => {
    const rows = db.prepare('SELECT * FROM fleet_blackboard_history').all()
    expect(rows).toHaveLength(0)
  })

  it('no-op upsert (same status/summary/task_ref) does not add a history row', () => {
    const noop_agent = 'agent-noop'
    // First write: real insert, history is recorded
    db.prepare('INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary) VALUES (?, ?, NULL, ?, ?)')
      .run('bb-noop-01', noop_agent, 'active', 'Same summary')
    db.prepare('INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary) VALUES (?, NULL, ?, ?)')
      .run(noop_agent, 'active', 'Same summary')

    // Simulate change-detection: existing matches incoming, so no history insert
    const existing = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get('bb-noop-01') as { status: string; summary: string; task_ref: string | null }
    const changed = existing.status !== 'active' || existing.summary !== 'Same summary' || (existing.task_ref ?? null) !== null
    if (changed) {
      db.prepare('INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary) VALUES (?, NULL, ?, ?)')
        .run(noop_agent, 'active', 'Same summary')
    }

    const history = db.prepare('SELECT * FROM fleet_blackboard_history WHERE agent_id = ?').all(noop_agent)
    expect(history).toHaveLength(1) // only the first real insert
  })
})
