// DELEGAPPROVER1123: the migration on a database made before it. Existing logins become owners; approval_events is
// rebuilt to accept 'decided', its rows and ids kept; approver_scopes is created.
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, getDashboardUser, listApprovalEvents } from '../db.js'

const td = mkdtempSync(join(tmpdir(), 'delegapprover-mig-'))
afterAll(() => rmSync(td, { recursive: true, force: true }))

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
})
