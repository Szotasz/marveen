// DELEGAPPROVER1123: the migration on a database made before it. Existing logins become owners; approval_events is
// rebuilt to accept 'decided', its rows and ids kept; approver_scopes is created.
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, getDashboardUser, listApprovalEvents, _setApprovalEventsRebuildHookForTest } from '../db.js'

const td = mkdtempSync(join(tmpdir(), 'delegapprover-mig-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))

// approval_events as it was before DELEGAPPROVER1123, with its index and three rows.
const OLD_EVENTS_SQL = `
  CREATE TABLE approval_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('consumed','consume_refused','consumed_backfill')),
    reason TEXT,
    actor TEXT,
    ref TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );
  CREATE INDEX idx_approval_events_approval ON approval_events(approval_id, created_at);
  INSERT INTO approval_events (approval_id, event, actor, created_at) VALUES ('a1', 'consumed', 'tool', 5);
  INSERT INTO approval_events (approval_id, event, reason, actor, ref, created_at) VALUES ('a2', 'consume_refused', 'hash_mismatch', 'tool', 'ref-1', 6);
  INSERT INTO approval_events (approval_id, event, actor, created_at) VALUES ('a3', 'consumed_backfill', 'op', 7);
`

describe('DELEGAPPROVER1123 migration', () => {
  it('an existing login is an owner, the old events survive, and a decided event can be written', () => {
    const file = join(td, 'old.db')
    const old = new Database(file)
    old.exec(`
      CREATE TABLE dashboard_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        totp_enabled INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('legacy', 'x', 1, 1);
      CREATE TABLE approval_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL,
        event TEXT NOT NULL CHECK(event IN ('consumed','consume_refused','consumed_backfill')),
        reason TEXT,
        actor TEXT,
        ref TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
      );
      INSERT INTO approval_events (approval_id, event, actor, created_at) VALUES ('a1', 'consumed', 'tool', 5);
    `)
    old.close()

    initDatabase(file)
    expect(getDashboardUser('legacy')!.role).toBe('owner')
    expect(listApprovalEvents('a1').map((e) => [e.id, e.event, e.actor, e.created_at])).toEqual([[1, 'consumed', 'tool', 5]])
    getDb().prepare("INSERT INTO approval_events (approval_id, event, actor, created_at) VALUES ('a1', 'decided', 'anna', 6)").run()
    expect(listApprovalEvents('a1').map((e) => e.event)).toEqual(['consumed', 'decided'])
    expect(() => getDb().prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, role) VALUES ('z', 'x', 1, 1, 'root')").run()).toThrow()
    const cols = (getDb().prepare('PRAGMA table_info(approver_scopes)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['id', 'user_id', 'category', 'agent', 'created_at', 'created_by'])
    // idempotent: a second start changes nothing
    initDatabase(file)
    expect(listApprovalEvents('a1').map((e) => e.event)).toEqual(['consumed', 'decided'])
    expect(getDashboardUser('legacy')!.role).toBe('owner')
  })

  // Abel's review of #3094: the rebuild is one transaction. A failure at its most dangerous point (after the copy and
  // the drop, before the rename) leaves the original table and every row of it; the next start completes it.
  afterEach(() => _setApprovalEventsRebuildHookForTest(null))
  it('a rebuild that fails midway is rolled back whole, and a re-run completes it', () => {
    const file = join(td, 'crash.db')
    const old = new Database(file)
    old.exec(OLD_EVENTS_SQL)
    const rows = old.prepare('SELECT * FROM approval_events ORDER BY id').all()
    const schema = (old.prepare("SELECT sql FROM sqlite_master WHERE name = 'approval_events'").get() as { sql: string }).sql
    old.close()
    expect(rows).toHaveLength(3)

    let calls = 0
    _setApprovalEventsRebuildHookForTest(() => { calls++; throw new Error('simulated crash after the copy') })
    initDatabase(file) // the migration's failure is logged, the start goes on
    expect(calls).toBe(1)
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'approval_events%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(['approval_events'])
    expect((getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'approval_events'").get() as { sql: string }).sql).toBe(schema)
    expect(getDb().prepare('SELECT * FROM approval_events ORDER BY id').all()).toEqual(rows)
    expect(getDb().inTransaction).toBe(false)

    _setApprovalEventsRebuildHookForTest(null)
    initDatabase(file)
    expect(getDb().prepare('SELECT * FROM approval_events ORDER BY id').all()).toEqual(rows)
    getDb().prepare("INSERT INTO approval_events (approval_id, event, actor, created_at) VALUES ('b1', 'decided', 'anna', 9)").run()
    const idx = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_events'").all() as { name: string }[]).map((i) => i.name)
    expect(idx).toContain('idx_approval_events_approval')
  })
})
