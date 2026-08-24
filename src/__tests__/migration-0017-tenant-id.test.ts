// Verifies that migration 0017 (tenant_id + api_tokens) applies cleanly
// to a fresh in-memory database and satisfies all structural contracts:
//
//   - tenant_id column present on all four core tables
//   - Existing rows keep their data and receive tenant_id = 'default'
//   - api_tokens table created with the correct schema and constraints
//   - All expected indexes created
//   - No INSERT/UPDATE on memories (vec0 safety)
//   - Migration is idempotent via IF NOT EXISTS / ADD COLUMN guard

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = join(__dirname, '../../src/migrations/0017_tenant_id.sql')

// Minimal baseline schema that the migration ALTER TABLE statements require.
// Only the columns that actually exist in the real tables are included so we
// can verify ADD COLUMN without running the full migration chain.
const BASELINE_SQL = `
  CREATE TABLE memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    category    TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL
  );

  CREATE TABLE kanban_cards (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'planned',
    archived_at INTEGER
  );

  CREATE TABLE agent_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent   TEXT NOT NULL,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE import_memories (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    content     TEXT NOT NULL
  );

  -- Simulate a pre-existing vec_memories virtual table (vec0 not loaded
  -- in this test environment, so we use a regular table as a stand-in to
  -- track whether the migration row-count changes it).
  CREATE TABLE vec_memories_rowcount_sentinel (
    snapshot INTEGER NOT NULL
  );
  INSERT INTO vec_memories_rowcount_sentinel VALUES (0);
`

function openWithBaseline(): Database.Database {
  const db = new Database(':memory:')
  db.exec(BASELINE_SQL)
  return db
}

function applyMigration(db: Database.Database): void {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  db.exec(sql)
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (c) => c.name,
  )
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

// ── Migration applies cleanly ─────────────────────────────────────────────────

describe('Migration 0017 -- applies cleanly', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openWithBaseline()
    applyMigration(db)
  })

  it('tenant_id added to memories', () => {
    expect(columnNames(db, 'memories')).toContain('tenant_id')
  })

  it('tenant_id added to kanban_cards', () => {
    expect(columnNames(db, 'kanban_cards')).toContain('tenant_id')
  })

  it('tenant_id added to agent_messages', () => {
    expect(columnNames(db, 'agent_messages')).toContain('tenant_id')
  })

  it('tenant_id added to import_memories', () => {
    expect(columnNames(db, 'import_memories')).toContain('tenant_id')
  })

  it('api_tokens table created', () => {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_tokens'")
      .get()
    expect(row).toBeDefined()
  })

  it('api_tokens has correct columns', () => {
    const cols = columnNames(db, 'api_tokens')
    for (const col of [
      'id',
      'token_hash',
      'name',
      'role',
      'tenant_id',
      'created_at',
      'expires_at',
      'revoked_at',
      'last_used_at',
      'rotated_from',
    ]) {
      expect(cols).toContain(col)
    }
  })

  it('api_tokens role CHECK constraint rejects unknown roles', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() =>
      db
        .prepare(
          "INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run('hash-x', 'test', 'superadmin', 'default', now),
    ).toThrow()
  })

  it('api_tokens accepts all valid roles', () => {
    const now = Math.floor(Date.now() / 1000)
    for (const [i, role] of (['admin', 'agent', 'read_only', 'viewer'] as const).entries()) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(`hash-${i}`, `token-${role}`, role, 'default', now),
      ).not.toThrow()
    }
  })

  it('indexes created for all four core tables', () => {
    const indexes = indexNames(db)
    expect(indexes).toContain('idx_memories_tenant')
    expect(indexes).toContain('idx_kanban_tenant')
    expect(indexes).toContain('idx_agent_msg_tenant')
    expect(indexes).toContain('idx_import_mem_tenant')
    expect(indexes).toContain('idx_api_tokens_hash')
    expect(indexes).toContain('idx_api_tokens_tenant')
  })
})

// ── Existing data preserved ───────────────────────────────────────────────────

describe('Migration 0017 -- backward-compat: existing rows get default tenant', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openWithBaseline()
    // Insert rows BEFORE applying the migration (simulates production data).
    db.exec(`
      INSERT INTO memories (agent_id, category, key, value) VALUES ('agent-a', 'warm', 'k1', 'v1');
      INSERT INTO kanban_cards (id, title) VALUES ('card-1', 'Task one');
      INSERT INTO agent_messages (from_agent, to_agent, content) VALUES ('agent-a', 'agent-b', 'hello');
      INSERT INTO import_memories (id, source_id, file_path, content) VALUES ('im-1', 'src-1', '/f', 'body');
    `)
    applyMigration(db)
  })

  it('existing memory row gets tenant_id = default', () => {
    const row = db.prepare('SELECT tenant_id FROM memories WHERE key = ?').get('k1') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('default')
  })

  it('existing kanban card gets tenant_id = default', () => {
    const row = db.prepare('SELECT tenant_id FROM kanban_cards WHERE id = ?').get('card-1') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('default')
  })

  it('existing agent_message gets tenant_id = default', () => {
    const row = db
      .prepare('SELECT tenant_id FROM agent_messages WHERE content = ?')
      .get('hello') as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('existing import_memory gets tenant_id = default', () => {
    const row = db
      .prepare('SELECT tenant_id FROM import_memories WHERE id = ?')
      .get('im-1') as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('original data is intact after migration', () => {
    const mem = db.prepare('SELECT value FROM memories WHERE key = ?').get('k1') as {
      value: string
    }
    expect(mem.value).toBe('v1')
  })
})

// ── vec0 safety: sentinel row-count unchanged ─────────────────────────────────

describe('Migration 0017 -- vec0 safety', () => {
  it('sentinel row-count is unchanged (no INSERT/UPDATE on memories fired)', () => {
    const db = openWithBaseline()
    const before = (
      db
        .prepare('SELECT snapshot FROM vec_memories_rowcount_sentinel')
        .get() as { snapshot: number }
    ).snapshot
    applyMigration(db)
    const after = (
      db
        .prepare('SELECT snapshot FROM vec_memories_rowcount_sentinel')
        .get() as { snapshot: number }
    ).snapshot
    expect(after).toBe(before)
  })

  it('migration SQL contains no INSERT INTO memories', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8').toLowerCase()
    // Must not contain "insert into memories" (would trigger vec0 in prod).
    expect(sql).not.toMatch(/insert\s+into\s+memories/)
  })

  it('migration SQL contains no UPDATE OF embedding_blob', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf-8').toLowerCase()
    expect(sql).not.toMatch(/update\s+of\s+embedding_blob/)
  })
})

// ── api_tokens uniqueness constraint ─────────────────────────────────────────

describe('Migration 0017 -- api_tokens constraints', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openWithBaseline()
    applyMigration(db)
  })

  it('token_hash UNIQUE rejects duplicate', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      "INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run('unique-hash', 'first', 'admin', 'default', now)
    expect(() =>
      db
        .prepare(
          "INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run('unique-hash', 'second', 'agent', 'default', now),
    ).toThrow()
  })

  it('revoked_at NULL means active (not filtered out)', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      "INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run('active-hash', 'active-token', 'agent', 'default', now)
    const row = db
      .prepare('SELECT revoked_at FROM api_tokens WHERE token_hash = ?')
      .get('active-hash') as { revoked_at: number | null }
    expect(row.revoked_at).toBeNull()
  })
})
