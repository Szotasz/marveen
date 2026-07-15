import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// ---- DB schema (mirrors db.ts) ----

function buildDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('tool_call', 'skill_read')),
      session_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_skill_usage_agent ON skill_usage(agent_id, created_at)`)
  db.exec(`CREATE INDEX idx_skill_usage_skill ON skill_usage(skill_name, created_at)`)
  return db
}

type DB = ReturnType<typeof buildDb>

function insert(db: DB, row: { agent_id: string; skill_name: string; trigger_type: string; session_id?: string | null; created_at?: number }) {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.agent_id, row.skill_name, row.trigger_type, row.session_id ?? null, row.created_at ?? now)
}

// ---- Schema tests ----

describe('skill_usage schema', () => {
  let db: DB

  beforeEach(() => { db = buildDb() })

  it('accepts tool_call trigger_type', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call' })
    const row = db.prepare('SELECT * FROM skill_usage LIMIT 1').get() as any
    expect(row.trigger_type).toBe('tool_call')
    expect(row.agent_id).toBe('agent-a')
    expect(row.skill_name).toBe('fleet-helper')
  })

  it('accepts skill_read trigger_type', () => {
    insert(db, { agent_id: 'agent-b', skill_name: 'deep-research', trigger_type: 'skill_read' })
    const row = db.prepare('SELECT * FROM skill_usage LIMIT 1').get() as any
    expect(row.trigger_type).toBe('skill_read')
  })

  it('rejects unknown trigger_type', () => {
    expect(() => insert(db, { agent_id: 'agent-a', skill_name: 'x', trigger_type: 'unknown' })).toThrow()
  })

  it('allows null session_id', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'y', trigger_type: 'tool_call', session_id: null })
    const row = db.prepare('SELECT session_id FROM skill_usage LIMIT 1').get() as any
    expect(row.session_id).toBeNull()
  })

  it('stores session_id when provided', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'z', trigger_type: 'skill_read', session_id: 'sess-123' })
    const row = db.prepare('SELECT session_id FROM skill_usage LIMIT 1').get() as any
    expect(row.session_id).toBe('sess-123')
  })

  it('autoincrement id is unique per row', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call' })
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call' })
    const rows = db.prepare('SELECT id FROM skill_usage').all() as any[]
    expect(rows[0].id).not.toBe(rows[1].id)
  })

  it('allows same skill to appear multiple times (no unique constraint)', () => {
    for (let i = 0; i < 5; i++) {
      insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call' })
    }
    const count = (db.prepare('SELECT COUNT(*) AS c FROM skill_usage').get() as any).c
    expect(count).toBe(5)
  })
})

// ---- Query tests ----

describe('skill_usage queries', () => {
  let db: DB
  const BASE_TS = 1_700_000_000

  beforeEach(() => {
    db = buildDb()
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call', created_at: BASE_TS })
    insert(db, { agent_id: 'agent-a', skill_name: 'deep-research', trigger_type: 'skill_read', created_at: BASE_TS + 10 })
    insert(db, { agent_id: 'agent-b', skill_name: 'fleet-helper', trigger_type: 'tool_call', created_at: BASE_TS + 20 })
    insert(db, { agent_id: 'agent-b', skill_name: 'fleet-helper', trigger_type: 'skill_read', created_at: BASE_TS + 30 })
  })

  it('returns all rows when cutoff is 0', () => {
    const rows = db.prepare('SELECT * FROM skill_usage WHERE created_at >= ? ORDER BY created_at DESC', ).all(0)
    expect(rows).toHaveLength(4)
  })

  it('filters by agent_id', () => {
    const rows = db.prepare('SELECT * FROM skill_usage WHERE agent_id = ?').all('agent-a')
    expect(rows).toHaveLength(2)
  })

  it('filters by skill_name', () => {
    const rows = db.prepare('SELECT * FROM skill_usage WHERE skill_name = ?').all('fleet-helper')
    expect(rows).toHaveLength(3)
  })

  it('returns rows newer than cutoff', () => {
    const rows = db.prepare('SELECT * FROM skill_usage WHERE created_at >= ?').all(BASE_TS + 15)
    expect(rows).toHaveLength(2)
  })
})

// ---- Stats aggregation tests ----

describe('skill_usage stats aggregation', () => {
  let db: DB
  const BASE_TS = 1_700_000_000

  beforeEach(() => {
    db = buildDb()
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'tool_call', created_at: BASE_TS })
    insert(db, { agent_id: 'agent-b', skill_name: 'fleet-helper', trigger_type: 'tool_call', created_at: BASE_TS + 10 })
    insert(db, { agent_id: 'agent-a', skill_name: 'fleet-helper', trigger_type: 'skill_read', created_at: BASE_TS + 20 })
    insert(db, { agent_id: 'agent-a', skill_name: 'deep-research', trigger_type: 'skill_read', created_at: BASE_TS + 30 })
  })

  function stats(cutoff = 0) {
    return db.prepare(`
      SELECT
        skill_name,
        SUM(CASE WHEN trigger_type = 'tool_call' THEN 1 ELSE 0 END) AS call_count,
        SUM(CASE WHEN trigger_type = 'skill_read' THEN 1 ELSE 0 END) AS read_count,
        COUNT(*) AS total_count,
        COUNT(DISTINCT agent_id) AS agent_count,
        MAX(created_at) AS last_used_at
      FROM skill_usage
      WHERE created_at >= ?
      GROUP BY skill_name
      ORDER BY total_count DESC
    `).all(cutoff) as any[]
  }

  it('aggregates fleet-helper correctly', () => {
    const rows = stats()
    const fh = rows.find((r: any) => r.skill_name === 'fleet-helper')
    expect(fh).toBeDefined()
    expect(fh.call_count).toBe(2)
    expect(fh.read_count).toBe(1)
    expect(fh.total_count).toBe(3)
    expect(fh.agent_count).toBe(2)
  })

  it('fleet-helper is ranked first by total_count', () => {
    const rows = stats()
    expect(rows[0].skill_name).toBe('fleet-helper')
  })

  it('respects the cutoff filter in stats', () => {
    // Rows at BASE_TS+20 (fleet-helper/skill_read) and BASE_TS+30 (deep-research) survive.
    // Rows at BASE_TS and BASE_TS+10 (both fleet-helper/tool_call) are filtered out.
    const rows = stats(BASE_TS + 15)
    const fh = rows.find((r: any) => r.skill_name === 'fleet-helper')
    expect(fh?.total_count ?? 0).toBe(1)
    expect(fh?.read_count ?? 0).toBe(1)
    expect(fh?.call_count ?? 0).toBe(0)
  })

  it('does not include rows outside the time window', () => {
    const rows = stats(BASE_TS + 100)
    expect(rows).toHaveLength(0)
  })
})

// ---- No-prune contract ----

describe('skill_usage has no prune mechanism', () => {
  it('table definition has no expiry column (row stays forever)', () => {
    const db = buildDb()
    // If a prune were added it would use a cutoff timestamp column.
    // Verify the schema lacks any ttl/expires_at/prune-related column.
    const cols = (db.prepare("PRAGMA table_info(skill_usage)").all() as any[]).map((c: any) => c.name)
    expect(cols).not.toContain('expires_at')
    expect(cols).not.toContain('ttl')
    expect(cols).not.toContain('deleted_at')
    // Required columns are present
    expect(cols).toContain('agent_id')
    expect(cols).toContain('skill_name')
    expect(cols).toContain('trigger_type')
    expect(cols).toContain('created_at')
  })
})
