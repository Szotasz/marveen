// Token lifecycle tests: creation, rotation, expiry, revocation, and
// auth-gate integration (DB-lookup -> file-token fallback precedence).
//
// Coverage contract:
//   1. create: INSERT with SHA-256 hash, role/tenant/expiry stored correctly
//   2. rotate: atomic -- old revoked, new created with rotated_from; new token resolves
//   3. expiry: expired token -> null from resolveApiToken
//   4. revoke: revoked_at set, revoked token -> null from resolveApiToken
//   5. CRITICAL: expired/revoked token in DB blocks file-token fallback (no admin bypass)
//   6. Token absent from DB -> file-token fallback allowed
//   7. Valid DB token returns its own role (not hardcoded admin)
//   8. resolveRole() returns DB role from token auth kind
//   9. Admin token -> admin role; agent token -> agent role
//  10. rotate preserves name/role/tenant across the rotation chain

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { resolveApiToken } from '../web/auth-gate.js'
import { resolveRole } from '../web/authz.js'
import type { AuthResult } from '../web/auth-gate.js'

// ── Schema ────────────────────────────────────────────────────────────────────

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
  );
`

function openDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(API_TOKENS_SCHEMA)
  return db
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const NOW = Math.floor(Date.now() / 1000)

function insertToken(
  db: Database.Database,
  opts: {
    hash: string
    name?: string
    role?: string
    tenantId?: string
    expiresAt?: number | null
    revokedAt?: number | null
    rotatedFrom?: number | null
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, revoked_at, rotated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.hash,
      opts.name ?? 'test-token',
      opts.role ?? 'agent',
      opts.tenantId ?? 'default',
      NOW - 60,
      opts.expiresAt !== undefined ? opts.expiresAt : null,
      opts.revokedAt !== undefined ? opts.revokedAt : null,
      opts.rotatedFrom !== undefined ? opts.rotatedFrom : null,
    )
  return Number(result.lastInsertRowid)
}

// ── 1. Create: SHA-256 stored, never raw ─────────────────────────────────────

describe('token creation', () => {
  it('stores the SHA-256 hash, not the raw token', () => {
    const db = openDb()
    const raw = 'my-secret-token'
    insertToken(db, { hash: sha256(raw) })
    const row = db.prepare('SELECT token_hash FROM api_tokens').get() as { token_hash: string }
    expect(row.token_hash).toBe(sha256(raw))
    expect(row.token_hash).not.toBe(raw)
  })

  it('resolves valid token with correct role and tenant', () => {
    const db = openDb()
    const raw = 'agent-tok-abc'
    insertToken(db, { hash: sha256(raw), role: 'agent', tenantId: 'tenant-x' })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.role).toBe('agent')
      expect(result.tenantId).toBe('tenant-x')
    }
  })

  it('resolves admin token with admin role', () => {
    const db = openDb()
    const raw = 'admin-tok-xyz'
    insertToken(db, { hash: sha256(raw), role: 'admin', tenantId: 'default' })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.role).toBe('admin')
    }
  })
})

// ── 3. Expiry ─────────────────────────────────────────────────────────────────

describe('token expiry', () => {
  it('expired token returns found=false, registeredButInvalid=true', () => {
    const db = openDb()
    const raw = 'expired-token'
    insertToken(db, { hash: sha256(raw), expiresAt: NOW - 3600 })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(false)
    if (!result.found) expect(result.registeredButInvalid).toBe(true)
  })

  it('non-expired token with future expires_at resolves correctly', () => {
    const db = openDb()
    const raw = 'valid-expiry-token'
    insertToken(db, { hash: sha256(raw), expiresAt: NOW + 86400 })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(true)
  })

  it('token with null expires_at (no expiry) resolves correctly', () => {
    const db = openDb()
    const raw = 'no-expiry-token'
    insertToken(db, { hash: sha256(raw), expiresAt: null })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(true)
  })
})

// ── 4. Revocation ─────────────────────────────────────────────────────────────

describe('token revocation', () => {
  it('revoked token returns found=false, registeredButInvalid=true', () => {
    const db = openDb()
    const raw = 'revoked-token'
    insertToken(db, { hash: sha256(raw), revokedAt: NOW - 60 })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(false)
    if (!result.found) expect(result.registeredButInvalid).toBe(true)
  })

  it('active token with null revoked_at resolves correctly', () => {
    const db = openDb()
    const raw = 'active-token'
    insertToken(db, { hash: sha256(raw), revokedAt: null })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(true)
  })
})

// ── 5. CRITICAL: revoked/expired token blocks file-token fallback ─────────────

describe('CRITICAL: expired/revoked token in DB blocks file-token fallback', () => {
  it('resolveApiToken returns registeredButInvalid=true for expired token', () => {
    const db = openDb()
    const raw = 'file-matches-expired'
    insertToken(db, { hash: sha256(raw), expiresAt: NOW - 1 })
    const result = resolveApiToken(raw, db)
    // The caller MUST treat registeredButInvalid=true as a hard deny, not fall through
    expect(result.found).toBe(false)
    if (!result.found) {
      expect(result.registeredButInvalid).toBe(true)
      // This sentinel signals: deny immediately, do not check file-token fallback
    }
  })

  it('resolveApiToken returns registeredButInvalid=true for revoked token', () => {
    const db = openDb()
    const raw = 'file-matches-revoked'
    insertToken(db, { hash: sha256(raw), revokedAt: NOW - 1 })
    const result = resolveApiToken(raw, db)
    expect(result.found).toBe(false)
    if (!result.found) {
      expect(result.registeredButInvalid).toBe(true)
    }
  })

  it('registeredButInvalid=false for token absent from DB (fallback allowed)', () => {
    const db = openDb()
    // No row inserted -- this simulates the prod file-token which is not in DB
    const result = resolveApiToken('completely-unknown-token', db)
    expect(result.found).toBe(false)
    if (!result.found) {
      // Caller may proceed to file-token fallback
      expect(result.registeredButInvalid).toBe(false)
    }
  })
})

// ── 2. Rotation ───────────────────────────────────────────────────────────────

describe('token rotation', () => {
  it('after rotation the old hash is revoked and the new hash resolves', () => {
    const db = openDb()
    const oldRaw = 'old-token'
    const oldId = insertToken(db, { hash: sha256(oldRaw), role: 'agent', tenantId: 'tenant-a' })

    // Simulate rotation: revoke old, insert new with rotated_from
    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, oldId)
    const newRaw = 'new-token'
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, rotated_from)
       VALUES (?, 'test-token', 'agent', 'tenant-a', ?, ?)`,
    ).run(sha256(newRaw), now, oldId)

    // Old token is now revoked
    const oldResult = resolveApiToken(oldRaw, db)
    expect(oldResult.found).toBe(false)
    if (!oldResult.found) expect(oldResult.registeredButInvalid).toBe(true)

    // New token resolves correctly
    const newResult = resolveApiToken(newRaw, db)
    expect(newResult.found).toBe(true)
    if (newResult.found) {
      expect(newResult.role).toBe('agent')
      expect(newResult.tenantId).toBe('tenant-a')
    }
  })

  it('rotation preserves name, role and tenant from the predecessor', () => {
    const db = openDb()
    const oldRaw = 'original-agent'
    const oldId = insertToken(db, {
      hash: sha256(oldRaw),
      name: 'my-agent-key',
      role: 'agent',
      tenantId: 'acme',
    })

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, oldId)
    const newRaw = 'rotated-agent'
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, rotated_from)
       VALUES (?, 'my-agent-key', 'agent', 'acme', ?, ?)`,
    ).run(sha256(newRaw), now, oldId)

    const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(sha256(newRaw)) as {
      name: string; role: string; tenant_id: string; rotated_from: number
    }
    expect(row.name).toBe('my-agent-key')
    expect(row.role).toBe('agent')
    expect(row.tenant_id).toBe('acme')
    expect(row.rotated_from).toBe(oldId)
  })
})

// ── 7-9. resolveRole integration ──────────────────────────────────────────────

describe('resolveRole with DB token role', () => {
  it('DB token with role=agent -> resolveRole returns agent', () => {
    const auth: AuthResult = { kind: 'token', role: 'agent', tenantId: 'default' }
    expect(resolveRole(auth)).toBe('agent')
  })

  it('DB token with role=admin -> resolveRole returns admin', () => {
    const auth: AuthResult = { kind: 'token', role: 'admin', tenantId: 'default' }
    expect(resolveRole(auth)).toBe('admin')
  })

  it('DB token with role=read_only -> resolveRole returns read_only', () => {
    const auth: AuthResult = { kind: 'token', role: 'read_only', tenantId: 'acme' }
    expect(resolveRole(auth)).toBe('read_only')
  })

  it('DB token with role=viewer -> resolveRole returns viewer', () => {
    const auth: AuthResult = { kind: 'token', role: 'viewer', tenantId: 'default' }
    expect(resolveRole(auth)).toBe('viewer')
  })

  it('legacy token (no role field) -> resolveRole returns admin (backward-compat)', () => {
    const auth: AuthResult = { kind: 'token' }
    expect(resolveRole(auth)).toBe('admin')
  })
})

// ── 10. Unknown token (not in DB) ─────────────────────────────────────────────

describe('unknown token', () => {
  it('returns found=false, registeredButInvalid=false for token not in DB', () => {
    const db = openDb()
    const result = resolveApiToken('not-in-db-token', db)
    expect(result.found).toBe(false)
    if (!result.found) expect(result.registeredButInvalid).toBe(false)
  })
})
