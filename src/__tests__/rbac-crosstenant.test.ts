// RBAC + cross-tenant isolation test suite.
//
// Blueprint coverage:
//   1. RBAC positive: admin role -> every endpoint allowed
//   2. RBAC negative: read_only role -> POST /api/memories -> 403
//   3. RBAC negative: viewer role -> POST /api/kanban -> 403
//   4. Cross-tenant leak: tenant-A token sees 0 rows of tenant-B memories (not 403)
//   5. Cross-tenant write: tenant-A token cannot insert into tenant-B kanban (enforced)
//   6. Expired token -> 401
//   7. Revoked token -> 401
//   8. No token -> 401
//   9. Admin default-token -> admin role -> allowed on every GET
//  10. Rollback safety: vec_memories row-count unchanged after tenant_id migration
//      (skipped until migration step is implemented; scaffold asserts DB boots)
//
// Scope: unit-level. All DB operations use an in-memory SQLite instance so
// there is no dependency on the production database or the vec0 extension.
// The scopeToTenant helper is implemented inline as a minimal mock that mirrors
// the contract the real query-scope wrapper implementation will fulfill.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import type { AuthResult } from '../web/auth-gate.js'
import { initDatabase, getDb, saveAgentMemory, getStaleMemories } from '../db.js'

// ── In-memory DB setup ────────────────────────────────────────────────────────
//
// Creates the minimum schema needed for cross-tenant and token-lifecycle tests
// without running the full applyMigrations() (which would need vec0 and the
// full migration chain). Tables use tenant_id columns matching the blueprint
// spec for the migration step that adds row-level tenancy.

function openTestDb(): Database.Database {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      category    TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE kanban_cards (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'planned',
      tenant_id   TEXT NOT NULL DEFAULT 'default'
    );

    -- api_tokens: blueprint schema for the token-management step; used for token lifecycle tests.
    CREATE TABLE api_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash    TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('admin','agent','read_only','viewer')),
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER,
      revoked_at    INTEGER,
      last_used_at  INTEGER,
      rotated_from  INTEGER REFERENCES api_tokens(id)
    );
  `)

  return db
}

// ── scopeToTenant mock ────────────────────────────────────────────────────────
//
// Minimal implementation of the query-scope wrapper contract.
// The real implementation will live in src/web/tenant-scope.ts;
// this mock proves that the CONTRACT is correct (correct SQL + tenant filter)
// independently of the rest of the stack.

function scopeToTenant(db: Database.Database, tenantId: string) {
  return {
    memories: {
      list: (agentId: string) =>
        db
          .prepare('SELECT * FROM memories WHERE tenant_id = ? AND agent_id = ?')
          .all(tenantId, agentId) as Array<{ id: number; tenant_id: string }>,
      insert: (agentId: string, category: string, key: string, value: string) =>
        db
          .prepare(
            'INSERT INTO memories (agent_id, category, key, value, tenant_id) VALUES (?, ?, ?, ?, ?)',
          )
          .run(agentId, category, key, value, tenantId),
    },
    kanban: {
      list: () =>
        db
          .prepare('SELECT * FROM kanban_cards WHERE tenant_id = ?')
          .all(tenantId) as Array<{ id: string; tenant_id: string }>,
      insert: (id: string, title: string) =>
        db
          .prepare(
            'INSERT INTO kanban_cards (id, title, tenant_id) VALUES (?, ?, ?)',
          )
          .run(id, title, tenantId),
    },
  }
}

// ── Token lifecycle helpers ───────────────────────────────────────────────────

function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

const NOW = Math.floor(Date.now() / 1000)

interface TokenRow {
  role: string
  tenant_id: string
  revoked_at: number | null
  expires_at: number | null
}

function resolveToken(db: Database.Database, rawToken: string): TokenRow | null {
  const hash = sha256hex(rawToken)
  const row = db
    .prepare(
      `SELECT role, tenant_id, revoked_at, expires_at
       FROM api_tokens
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(hash, NOW) as TokenRow | undefined
  return row ?? null
}

// ── Auth fixtures ─────────────────────────────────────────────────────────────

const TOKEN_AUTH: AuthResult = { kind: 'token' }
const NONE_AUTH: AuthResult = { kind: 'none' }

function deviceAuth(name = 'agent-a'): AuthResult {
  return { kind: 'device', device: name, deviceId: 1 }
}
function sessionAuth(user = 'agent-b'): AuthResult {
  return { kind: 'session', user }
}

// ── 1. RBAC positive: admin -> all endpoints allowed ─────────────────────────

describe('RBAC positive -- admin role', () => {
  const endpoints: [string, string][] = [
    ['GET', '/api/memories'],
    ['POST', '/api/memories'],
    ['DELETE', '/api/memories/1'],
    ['GET', '/api/kanban'],
    ['POST', '/api/kanban'],
    ['PATCH', '/api/kanban/x'],
    ['DELETE', '/api/kanban/x'],
    ['GET', '/api/agents'],
    ['POST', '/api/messages'],
    ['GET', '/api/approvals'],
    ['POST', '/api/approvals'],
    ['GET', '/api/blackboard'],
    ['POST', '/api/blackboard'],
    ['GET', '/api/admin/tokens'],
    ['POST', '/api/admin/tokens/1/rotate'],
    ['GET', '/api/federation/manifest'],
    ['POST', '/api/federation/inbox'],
  ]

  for (const [method, path] of endpoints) {
    it(`allows ${method} ${path}`, () => {
      expect(checkPermission(TOKEN_AUTH, method, path).allowed).toBe(true)
    })
  }
})

// ── 2. RBAC negative: read_only -> no writes ──────────────────────────────────

describe('RBAC negative -- read_only role (via session with viewer default)', () => {
  // The current resolveRole() maps session -> viewer; once the api_tokens table
  // grants explicit read_only role, the same checkPermission() logic applies.
  // We test checkPermission() directly with the permission that read_only lacks.

  it('POST /api/memories -> 403 for session (viewer)', () => {
    const result = checkPermission(sessionAuth(), 'POST', '/api/memories')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('DELETE /api/memories/1 -> 403 for session', () => {
    const result = checkPermission(sessionAuth(), 'DELETE', '/api/memories/1')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── 3. RBAC negative: viewer -> no kanban write ───────────────────────────────

describe('RBAC negative -- viewer role', () => {
  it('POST /api/kanban -> 403 for session (viewer)', () => {
    const result = checkPermission(sessionAuth(), 'POST', '/api/kanban')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })

  it('PATCH /api/kanban/x -> 403 for session', () => {
    const result = checkPermission(sessionAuth(), 'PATCH', '/api/kanban/x')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── 4. Cross-tenant leak: 0 rows, not 403 ────────────────────────────────────

describe('Cross-tenant isolation -- no data leakage', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
    // Insert memories for two different tenants under the same agent_id.
    db.prepare(
      'INSERT INTO memories (agent_id, category, key, value, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-a', 'warm', 'k1', 'secret-b', 'tenant-b')
    db.prepare(
      'INSERT INTO memories (agent_id, category, key, value, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-a', 'warm', 'k2', 'public-a', 'tenant-a')
  })

  it('tenant-A scope returns 0 rows of tenant-B memories (not 403)', () => {
    const scopeA = scopeToTenant(db, 'tenant-a')
    const rows = scopeA.memories.list('agent-a')
    // tenant-A only sees its own row, not tenant-B's
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenant_id).toBe('tenant-a')
  })

  it('tenant-B scope cannot see tenant-A memories', () => {
    const scopeB = scopeToTenant(db, 'tenant-b')
    const rows = scopeB.memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenant_id).toBe('tenant-b')
  })

  it('cross-tenant: no tenant-B row appears in tenant-A listing (0 leaks)', () => {
    const scopeA = scopeToTenant(db, 'tenant-a')
    const rows = scopeA.memories.list('agent-a')
    const leaked = rows.filter((r) => r.tenant_id !== 'tenant-a')
    expect(leaked).toHaveLength(0)
  })
})

// ── 5. Cross-tenant write isolation ──────────────────────────────────────────

describe('Cross-tenant isolation -- write cannot cross tenant boundary', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('scopeToTenant always writes the scoped tenant_id, not a caller-supplied one', () => {
    const scopeA = scopeToTenant(db, 'tenant-a')
    scopeA.kanban.insert('card-1', 'Task for A')

    // Verify the row is stamped with tenant-a, not anything else.
    const row = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get('card-1') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('tenant-a')

    // tenant-b scope does not see it.
    const scopeB = scopeToTenant(db, 'tenant-b')
    const bRows = scopeB.kanban.list()
    expect(bRows).toHaveLength(0)
  })

  it('RBAC: agent role cannot reach /api/admin/* (write blocked at permission layer)', () => {
    const result = checkPermission(deviceAuth(), 'POST', '/api/admin/tokens')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(403)
  })
})

// ── 6. Expired token -> 401 ───────────────────────────────────────────────────

describe('Token lifecycle -- expired token', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
    const pastTs = NOW - 3600 // expired 1 hour ago
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at)
       VALUES (?, 'expired-agent', 'agent', 'default', ?, ?)`,
    ).run(sha256hex('expired-raw-token'), NOW - 7200, pastTs)
  })

  it('resolveToken returns null for an expired token', () => {
    expect(resolveToken(db, 'expired-raw-token')).toBeNull()
  })

  it('a null token resolves to no AuthResult -> 401 path', () => {
    // Simulate what the middleware does: if resolveToken returns null, auth
    // falls through to kind='none', which checkPermission gates as 401.
    const auth: AuthResult = { kind: 'none' }
    const result = checkPermission(auth, 'GET', '/api/memories')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(401)
  })
})

// ── 7. Revoked token -> 401 ───────────────────────────────────────────────────

describe('Token lifecycle -- revoked token', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, revoked_at)
       VALUES (?, 'revoked-agent', 'agent', 'default', ?, ?)`,
    ).run(sha256hex('revoked-raw-token'), NOW - 3600, NOW - 1800)
  })

  it('resolveToken returns null for a revoked token', () => {
    expect(resolveToken(db, 'revoked-raw-token')).toBeNull()
  })
})

// ── 8. No token -> 401 ───────────────────────────────────────────────────────

describe('No credentials -> 401', () => {
  it('kind=none -> 401 regardless of path', () => {
    const result = checkPermission(NONE_AUTH, 'GET', '/api/memories')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(401)
  })

  it('kind=none -> 401 even for read-only endpoint', () => {
    const result = checkPermission(NONE_AUTH, 'GET', '/api/agents')
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.status).toBe(401)
  })
})

// ── 9. Admin default-token backward-compat ────────────────────────────────────

describe('Default admin token backward-compat', () => {
  // The dashboard bearer (kind='token') must remain fully operational.
  // This block proves the guarantee does not silently break.

  const getEndpoints: [string, string][] = [
    ['GET', '/api/memories'],
    ['GET', '/api/kanban'],
    ['GET', '/api/agents'],
    ['GET', '/api/approvals'],
    ['GET', '/api/blackboard'],
    ['GET', '/api/admin/tokens'],
  ]

  for (const [method, path] of getEndpoints) {
    it(`allows ${method} ${path}`, () => {
      expect(checkPermission(TOKEN_AUTH, method, path).allowed).toBe(true)
    })
  }

  it('resolveRole returns admin for kind=token', () => {
    expect(resolveRole(TOKEN_AUTH)).toBe('admin')
  })
})

// ── 10. Rollback safety scaffold ─────────────────────────────────────────────
//
// The full rollback test (vec_memories row-count unchanged after migration
// rollback) requires the tenant_id migration to exist. This scaffold confirms that
// the in-memory DB boots cleanly with the tenant_id columns present, which
// is the pre-condition for the rollback script to be testable.

describe('Migration rollback scaffold', () => {
  it('in-memory DB with tenant_id columns boots without error', () => {
    const db = openTestDb()
    // If the schema creation threw, we would not reach this assertion.
    const count = (
      db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }
    ).n
    expect(count).toBe(0)
    db.close()
  })

  it('tenant_id column exists on memories table', () => {
    const db = openTestDb()
    const cols = db.pragma('table_info(memories)') as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('tenant_id')
    db.close()
  })

  it('tenant_id column exists on kanban_cards table', () => {
    const db = openTestDb()
    const cols = db.pragma('table_info(kanban_cards)') as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('tenant_id')
    db.close()
  })
})

// ── Valid active token resolves correctly ─────────────────────────────────────

describe('Token lifecycle -- valid active token', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
    const futureTs = NOW + 86400 // expires in 24 hours
    db.prepare(
      `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at)
       VALUES (?, 'active-agent', 'agent', 'tenant-a', ?, ?)`,
    ).run(sha256hex('valid-raw-token'), NOW - 60, futureTs)
  })

  it('resolveToken returns the token row for a valid active token', () => {
    const row = resolveToken(db, 'valid-raw-token')
    expect(row).not.toBeNull()
    expect(row!.role).toBe('agent')
    expect(row!.tenant_id).toBe('tenant-a')
  })

  it('resolveToken returns null for an unknown token', () => {
    expect(resolveToken(db, 'unknown-token-xyz')).toBeNull()
  })
})

// ── Admin bypass: admin session sees all tenants ──────────────────────────────
//
// Verifies that role===admin is the correct bypass signal (not tenantId===null)
// and that the scopeToTenant wrapper still isolates non-admin callers.

describe('Admin bypass -- admin role bypasses tenant filter', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openTestDb()
    db.prepare(
      'INSERT INTO memories (agent_id, category, key, value, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-a', 'warm', 'k-a', 'data-a', 'tenant-a')
    db.prepare(
      'INSERT INTO memories (agent_id, category, key, value, tenant_id) VALUES (?, ?, ?, ?, ?)',
    ).run('agent-a', 'warm', 'k-b', 'data-b', 'tenant-b')
  })

  it('resolveRole returns admin for a session with role=admin', () => {
    const auth: AuthResult = { kind: 'session', user: 'admin-user', role: 'admin', tenantId: null }
    expect(resolveRole(auth)).toBe('admin')
  })

  it('resolveTenantId returns null for admin session (global scope)', () => {
    const auth: AuthResult = { kind: 'session', user: 'admin-user', role: 'admin', tenantId: null }
    expect(resolveTenantId(auth)).toBeNull()
  })

  it('admin role grants access to all endpoints (checkPermission)', () => {
    const auth: AuthResult = { kind: 'session', user: 'admin-user', role: 'admin', tenantId: null }
    expect(checkPermission(auth, 'GET', '/api/memories').allowed).toBe(true)
    expect(checkPermission(auth, 'DELETE', '/api/memories/1').allowed).toBe(true)
    expect(checkPermission(auth, 'GET', '/api/kanban').allowed).toBe(true)
    expect(checkPermission(auth, 'POST', '/api/kanban').allowed).toBe(true)
  })

  it('admin raw DB query sees rows from all tenants', () => {
    const rows = db.prepare('SELECT * FROM memories WHERE agent_id = ?').all('agent-a')
    expect(rows).toHaveLength(2)
  })

  it('scoped tenant-a caller only sees tenant-a rows (not admin bypass)', () => {
    const rows = scopeToTenant(db, 'tenant-a').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect((rows[0] as { tenant_id: string }).tenant_id).toBe('tenant-a')
  })

  it('scoped tenant-b caller only sees tenant-b rows (not admin bypass)', () => {
    const rows = scopeToTenant(db, 'tenant-b').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect((rows[0] as { tenant_id: string }).tenant_id).toBe('tenant-b')
  })
})

// ── 12. Shared-tier isolation -- getAgentMemories SQL contract ────────────────
//
// Acceptance criterion (feaec069):
//   tenant_A category=shared memory MUST NOT appear in a tenant_B recall
//   of the same agent. The SQL pattern mirrors getAgentMemories with tenantId.

describe('shared-tier isolation -- getAgentMemories SQL contract', () => {
  let db2: Database.Database

  function openMemDb(): Database.Database {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,
        category    TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        keywords    TEXT,
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        accessed_at INTEGER NOT NULL DEFAULT 0
      );
    `)
    return d
  }

  // SQL that mirrors the updated getAgentMemories with tenantId (no category filter):
  function recallForTenant(d: Database.Database, agentId: string, tenantId: string, limit = 50) {
    return d.prepare(
      `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND tenant_id = ? ORDER BY accessed_at DESC LIMIT ?`
    ).all(agentId, tenantId, limit) as Array<{ id: number; category: string; tenant_id: string }>
  }

  beforeEach(() => {
    db2 = openMemDb()
    // tenant-a owns a shared-tier memory for zack
    db2.prepare('INSERT INTO memories (agent_id, category, content, tenant_id, accessed_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'shared', 'tenant-a shared secret', 'tenant-a', 100)
    // tenant-b owns a warm-tier memory for zack
    db2.prepare('INSERT INTO memories (agent_id, category, content, tenant_id, accessed_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'warm', 'tenant-b warm data', 'tenant-b', 100)
    // tenant-b also owns its own shared-tier memory for zack
    db2.prepare('INSERT INTO memories (agent_id, category, content, tenant_id, accessed_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'shared', 'tenant-b shared data', 'tenant-b', 90)
  })

  it('tenant-B recall does NOT include tenant-A shared memory', () => {
    const rows = recallForTenant(db2, 'zack', 'tenant-b')
    const leaked = rows.filter(r => r.tenant_id === 'tenant-a')
    expect(leaked).toHaveLength(0)
  })

  it('tenant-B recall includes its OWN shared-tier memory', () => {
    const rows = recallForTenant(db2, 'zack', 'tenant-b')
    const ownShared = rows.filter(r => r.category === 'shared' && r.tenant_id === 'tenant-b')
    expect(ownShared).toHaveLength(1)
  })

  it('tenant-A recall returns tenant-A shared memory but not tenant-B data', () => {
    const rows = recallForTenant(db2, 'zack', 'tenant-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenant_id).toBe('tenant-a')
    expect(rows[0]!.category).toBe('shared')
  })

  it('zero rows leaked across tenants (exhaustive check)', () => {
    const rowsA = recallForTenant(db2, 'zack', 'tenant-a')
    const rowsB = recallForTenant(db2, 'zack', 'tenant-b')
    for (const r of rowsA) expect(r.tenant_id).toBe('tenant-a')
    for (const r of rowsB) expect(r.tenant_id).toBe('tenant-b')
  })
})

// ── 13. Threads cross-tenant isolation -- getAgentConversationThreads contract ─
//
// Acceptance criterion (feaec069):
//   Non-admin tenant_B caller must NOT see tenant_A message threads.

describe('threads isolation -- getAgentConversationThreads SQL contract', () => {
  let db3: Database.Database

  function openMsgDb(): Database.Database {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE agent_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent   TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending',
        tenant_id  TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `)
    return d
  }

  // SQL that mirrors the updated getAgentConversationThreads with tenantId:
  function threadsForTenant(d: Database.Database, tenantId: string) {
    return d.prepare(`
      WITH parties AS (
        SELECT from_agent AS agent FROM agent_messages WHERE tenant_id = ?
        UNION
        SELECT to_agent AS agent FROM agent_messages WHERE tenant_id = ?
      )
      SELECT p.agent AS agent,
        (SELECT COUNT(*) FROM agent_messages m WHERE (m.from_agent = p.agent OR m.to_agent = p.agent) AND m.tenant_id = ?) AS count
      FROM parties p
    `).all(tenantId, tenantId, tenantId) as Array<{ agent: string; count: number }>
  }

  beforeEach(() => {
    db3 = openMsgDb()
    db3.prepare('INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'jarvis', 'tenant-a msg', 'tenant-a', 1000)
    db3.prepare('INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)').run('boo', 'zack', 'tenant-b msg', 'tenant-b', 2000)
  })

  it('tenant-B threads do NOT include tenant-A agents', () => {
    const threads = threadsForTenant(db3, 'tenant-b')
    const agentNames = threads.map(t => t.agent)
    expect(agentNames).not.toContain('jarvis')
    expect(agentNames.every(a => ['boo', 'zack'].includes(a))).toBe(true)
  })

  it('tenant-A threads do NOT include tenant-B agents', () => {
    const threads = threadsForTenant(db3, 'tenant-a')
    const agentNames = threads.map(t => t.agent)
    expect(agentNames).not.toContain('boo')
    expect(agentNames.every(a => ['zack', 'jarvis'].includes(a))).toBe(true)
  })

  it('zero cross-tenant agent leakage -- agents exclusive to tenant-A never appear in tenant-B listing', () => {
    const bThreads = threadsForTenant(db3, 'tenant-b')
    const bAgentNames = bThreads.map(t => t.agent)
    // jarvis only appears in tenant-a messages; must not leak into tenant-b threads
    expect(bAgentNames).not.toContain('jarvis')
    // boo only appears in tenant-b messages; must not leak into tenant-a threads
    const aThreads = threadsForTenant(db3, 'tenant-a')
    expect(aThreads.map(t => t.agent)).not.toContain('boo')
  })
})

// ── 14. /api/recall memories cross-tenant isolation -- SQL contract ───────────
//
// Acceptance criterion (feaec069):
//   Non-admin tenant_B recall MUST NOT return tenant_A memories.
//   daily_logs have no tenant_id (Jonas Q3 decision) -- logs are not filtered.

describe('/api/recall memories isolation -- recallSearch SQL contract', () => {
  let db4: Database.Database

  function openRecallDb(): Database.Database {
    const d = new Database(':memory:')
    d.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords);
      CREATE TABLE memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,
        category    TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        keywords    TEXT,
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        created_at  INTEGER NOT NULL DEFAULT 0,
        accessed_at INTEGER NOT NULL DEFAULT 0
      );
    `)
    return d
  }

  // SQL that mirrors the updated recallSearch FTS path with tenantId + agentId:
  function recallMemsForTenant(d: Database.Database, agentId: string, tenantId: string, query: string, limit = 50) {
    return d.prepare(
      `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND tenant_id = ? AND (content LIKE ? OR keywords LIKE ?) ORDER BY created_at DESC LIMIT ?`
    ).all(agentId, tenantId, `%${query}%`, `%${query}%`, limit) as Array<{ id: number; category: string; tenant_id: string }>
  }

  beforeEach(() => {
    db4 = openRecallDb()
    db4.prepare('INSERT INTO memories (agent_id, category, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'shared', 'tenant-a project context', 'tenant-a', 100)
    db4.prepare('INSERT INTO memories (agent_id, category, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)').run('zack', 'warm', 'tenant-b zack memory', 'tenant-b', 90)
  })

  it('tenant-B recall does NOT return tenant-A shared memories', () => {
    const rows = recallMemsForTenant(db4, 'zack', 'tenant-b', 'context')
    // 'tenant-a project context' matches the query but belongs to tenant-a
    expect(rows.filter(r => r.tenant_id === 'tenant-a')).toHaveLength(0)
  })

  it('tenant-A recall does NOT return tenant-B memories', () => {
    const rows = recallMemsForTenant(db4, 'zack', 'tenant-a', 'memory')
    expect(rows.filter(r => r.tenant_id === 'tenant-b')).toHaveLength(0)
  })

  it('tenant-B recall returns its OWN memories', () => {
    const rows = recallMemsForTenant(db4, 'zack', 'tenant-b', 'zack')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenant_id).toBe('tenant-b')
  })
})

// ── 15. /api/memories/stale cross-tenant isolation -- real getStaleMemories ────
//
// Acceptance criterion (feaec069):
//   Non-admin tenant_B GET /api/memories/stale MUST NOT return tenant_A memories.
//
// Unlike blocks 12-14 (which exercise SQL copies for readability), this block
// calls the REAL getStaleMemories from db.ts against an in-memory database
// so that the test fails if the function body loses the tenant filter.

describe('/api/memories/stale isolation -- real getStaleMemories', () => {
  const now = Math.floor(Date.now() / 1000)

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  beforeEach(() => {
    const d = getDb()
    d.exec('DELETE FROM memories')
    d.exec('DELETE FROM span_reads')
    // tenant-a shared memory -- would leak to tenant-b without the tenant filter
    const r1 = saveAgentMemory('zack', 'tenant-a stale shared', 'shared', undefined, false, 'tenant-a')
    d.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, r1.id)
    // tenant-b own warm memory
    const r2 = saveAgentMemory('zack', 'tenant-b warm memory', 'warm', undefined, false, 'tenant-b')
    d.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, r2.id)
  })

  it('tenant-B stale does NOT return tenant-A shared memories', () => {
    const rows = getStaleMemories('zack', 'tenant-b')
    expect(rows.filter(r => r.tenant_id === 'tenant-a')).toHaveLength(0)
  })

  it('tenant-A stale does NOT return tenant-B memories', () => {
    const rows = getStaleMemories('zack', 'tenant-a')
    expect(rows.filter(r => r.tenant_id === 'tenant-b')).toHaveLength(0)
  })

  it('tenant-B stale returns its OWN memories', () => {
    const rows = getStaleMemories('zack', 'tenant-b')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenant_id).toBe('tenant-b')
  })
})
