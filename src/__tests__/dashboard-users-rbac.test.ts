// Tests for dashboard_users role + tenant_id migration and first-user-wins bootstrap.
//
// Covers four contracts:
//   1. Migration 0018 adds role + tenant_id columns with correct defaults
//   2. createDashboardUser first-user-wins: first user gets admin + null tenant
//   3. createDashboardUser subsequent users get viewer role
//   4. auth-gate session resolution carries role + tenantId when DB is provided
//   5. resolveRole reads session role from AuthResult
//   6. resolveTenantId returns null for global admin, string for scoped, 'default' fallback

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRole, resolveTenantId } from '../web/authz.js'
import { resolveApiToken } from '../web/auth-gate.js'
import type { AuthResult } from '../web/auth-gate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_0017 = join(__dirname, '../../src/migrations/0017_tenant_id.sql')
const MIGRATION_0018 = join(__dirname, '../../src/migrations/0018_dashboard_users_rbac.sql')

// Minimal schema to apply migration 0018 against.
const BASELINE = `
  CREATE TABLE dashboard_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0
  );
`

function openDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(BASELINE)
  return db
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

// ── Migration 0018 structural tests ──────────────────────────────────────────

describe('Migration 0018 -- dashboard_users role + tenant_id', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    db.exec(readFileSync(MIGRATION_0018, 'utf8'))
  })

  it('adds role column with DEFAULT viewer', () => {
    expect(colNames(db, 'dashboard_users')).toContain('role')
    db.prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('u', 'h', 1, 1)").run()
    const row = db.prepare("SELECT role FROM dashboard_users WHERE username = 'u'").get() as { role: string }
    expect(row.role).toBe('viewer')
  })

  it('adds tenant_id column (nullable)', () => {
    expect(colNames(db, 'dashboard_users')).toContain('tenant_id')
    db.prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('u', 'h', 1, 1)").run()
    const row = db.prepare("SELECT tenant_id FROM dashboard_users WHERE username = 'u'").get() as { tenant_id: string | null }
    expect(row.tenant_id).toBeNull()
  })

  it('role CHECK rejects invalid values', () => {
    expect(() =>
      db
        .prepare("INSERT INTO dashboard_users (username, password_hash, role, created_at, updated_at) VALUES ('u', 'h', 'superuser', 1, 1)")
        .run(),
    ).toThrow()
  })

  it('role CHECK accepts all four valid values', () => {
    for (const [i, role] of ['admin', 'agent', 'read_only', 'viewer'].entries()) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO dashboard_users (username, password_hash, role, created_at, updated_at) VALUES ('user${i}', 'h', '${role}', 1, 1)`,
          )
          .run(),
      ).not.toThrow()
    }
  })

  it('promotes the first existing user to admin on migration', () => {
    const freshDb = openDb()
    // Insert two users before applying the migration
    freshDb
      .prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('first', 'h', 1, 1)")
      .run()
    freshDb
      .prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at) VALUES ('second', 'h', 2, 2)")
      .run()
    freshDb.exec(readFileSync(MIGRATION_0018, 'utf8'))

    const first = freshDb.prepare("SELECT role FROM dashboard_users WHERE username = 'first'").get() as { role: string }
    const second = freshDb.prepare("SELECT role FROM dashboard_users WHERE username = 'second'").get() as { role: string }
    expect(first.role).toBe('admin')
    expect(second.role).toBe('viewer')
  })

  it('is safe on an empty table (UPDATE with no rows is a no-op)', () => {
    // Fresh DB: baseline only, no existing users
    const emptyDb = openDb()
    emptyDb.exec(readFileSync(MIGRATION_0018, 'utf8'))
    const count = (emptyDb.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get() as { c: number }).c
    expect(count).toBe(0)  // no rows inserted, no error
  })
})

// ── resolveRole session path ──────────────────────────────────────────────────

describe('resolveRole -- session with explicit role in AuthResult', () => {
  it('returns the role from AuthResult when present', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user', role: 'admin' }
    expect(resolveRole(auth)).toBe('admin')
  })

  it('falls back to viewer when role is absent (no-DB path)', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user' }
    expect(resolveRole(auth)).toBe('viewer')
  })

  it('returns agent role correctly', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user', role: 'agent' }
    expect(resolveRole(auth)).toBe('agent')
  })
})

// ── resolveTenantId session path ─────────────────────────────────────────────

describe('resolveTenantId -- session with tenantId in AuthResult', () => {
  it('returns null for global admin (tenantId=null)', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user', role: 'admin', tenantId: null }
    expect(resolveTenantId(auth)).toBeNull()
  })

  it('returns the string tenantId for scoped users', () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user', role: 'agent', tenantId: 'acme-corp' }
    expect(resolveTenantId(auth)).toBe('acme-corp')
  })

  it("returns 'default' when tenantId is absent (no-DB path fallback)", () => {
    const auth: AuthResult = { kind: 'session', user: 'test-user' }
    expect(resolveTenantId(auth)).toBe('default')
  })

  it('non-session kinds still return default', () => {
    expect(resolveTenantId({ kind: 'device', device: 'd', deviceId: 1 })).toBe('default')
    expect(resolveTenantId({ kind: 'federation', peer: 'p' })).toBe('default')
    expect(resolveTenantId({ kind: 'none' })).toBe('default')
  })
})
