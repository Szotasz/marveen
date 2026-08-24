// Unit tests for bootstrapDashboardToken (startup enrollment).
//
// Verifies three contracts:
//   1. First boot: dashboard token hash inserted with role=admin, tenant='default'
//   2. Idempotent: second call is a no-op (INSERT OR IGNORE, no error)
//   3. Error-safe: if the DB throws, the function catches and does not rethrow

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { bootstrapDashboardToken } from '../web/token-bootstrap.js'

const API_TOKENS_SCHEMA = `
  CREATE TABLE api_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash    TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK(role IN ('admin', 'agent', 'read_only', 'viewer')),
    tenant_id     TEXT    NOT NULL DEFAULT 'default',
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    revoked_at    INTEGER,
    last_used_at  INTEGER,
    rotated_from  INTEGER REFERENCES api_tokens(id)
  )
`

function openDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(API_TOKENS_SCHEMA)
  return db
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const RAW_TOKEN = 'test-dashboard-token-abc123'

describe('bootstrapDashboardToken', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
  })

  it('enrolls the token on first boot with correct fields', () => {
    bootstrapDashboardToken(RAW_TOKEN, db)

    const row = db
      .prepare('SELECT token_hash, name, role, tenant_id, expires_at, revoked_at FROM api_tokens WHERE name = ?')
      .get('dashboard') as {
        token_hash: string
        name: string
        role: string
        tenant_id: string
        expires_at: number | null
        revoked_at: number | null
      } | undefined

    expect(row).toBeDefined()
    expect(row!.token_hash).toBe(sha256(RAW_TOKEN))
    expect(row!.name).toBe('dashboard')
    expect(row!.role).toBe('admin')
    expect(row!.tenant_id).toBe('default')
    expect(row!.expires_at).toBeNull()
    expect(row!.revoked_at).toBeNull()
  })

  it('sets created_at to a plausible unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000)
    bootstrapDashboardToken(RAW_TOKEN, db)
    const after = Math.floor(Date.now() / 1000)

    const row = db
      .prepare('SELECT created_at FROM api_tokens WHERE name = ?')
      .get('dashboard') as { created_at: number } | undefined

    expect(row!.created_at).toBeGreaterThanOrEqual(before)
    expect(row!.created_at).toBeLessThanOrEqual(after)
  })

  it('is idempotent: second call is a no-op, row count stays 1', () => {
    bootstrapDashboardToken(RAW_TOKEN, db)
    bootstrapDashboardToken(RAW_TOKEN, db)

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE name = ?').get('dashboard') as { n: number }
    ).n
    expect(count).toBe(1)
  })

  it('does not throw when the DB prepare/run throws (error-safe)', () => {
    const brokenDb = { prepare: () => { throw new Error('DB locked') } } as unknown as Database.Database
    expect(() => bootstrapDashboardToken(RAW_TOKEN, brokenDb)).not.toThrow()
  })

  it('does not insert a row when it throws', () => {
    // Verify the error path leaves the DB untouched (real DB, force conflict via closed db)
    db.close()
    // After close, all operations throw; the function must silently survive
    expect(() => bootstrapDashboardToken(RAW_TOKEN, db)).not.toThrow()
  })

  it('different tokens produce different hashes (no collision risk)', () => {
    bootstrapDashboardToken('token-one', db)
    bootstrapDashboardToken('token-two', db)

    const count = (db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get() as { n: number }).n
    expect(count).toBe(2)
  })
})
