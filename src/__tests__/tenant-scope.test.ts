// Tenant-scope wrapper contract tests.
//
// Verifies that scopeToTenant() enforces tenant isolation on all four core
// tables: reads return only the caller's tenant rows, writes are stamped with
// the caller's tenant_id, and cross-tenant access is structurally impossible.
//
// Uses an in-memory SQLite instance with the minimum schema that the 0017
// migration adds (tenant_id columns + api_tokens table), so these tests run
// without vec0 or the full migration chain.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { scopeToTenant } from '../web/tenant-scope.js'

// ── Shared schema ─────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    keywords    TEXT,
    tenant_id   TEXT    NOT NULL DEFAULT 'default',
    created_at  INTEGER NOT NULL DEFAULT 0,
    accessed_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE kanban_cards (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'planned',
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE agent_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent   TEXT NOT NULL,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE import_memories (
    id         TEXT PRIMARY KEY,
    source_id  TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    content    TEXT NOT NULL,
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`

function openDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

// ── memories ──────────────────────────────────────────────────────────────────

describe('scopeToTenant -- memories', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    // Seed rows for two tenants
    db.exec(`
      INSERT INTO memories (agent_id, category, content, keywords, tenant_id)
        VALUES ('agent-a', 'warm', 'mem-a-content', 'kw-a', 'tenant-a');
      INSERT INTO memories (agent_id, category, content, keywords, tenant_id)
        VALUES ('agent-a', 'warm', 'mem-b-content', 'kw-b', 'tenant-b');
    `)
  })

  it('list returns only tenant-a rows', () => {
    const rows = scopeToTenant(db, 'tenant-a').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('mem-a-content')
    expect(rows[0]!.tenant_id).toBe('tenant-a')
  })

  it('list returns only tenant-b rows', () => {
    const rows = scopeToTenant(db, 'tenant-b').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('mem-b-content')
  })

  it('cross-tenant list returns 0 rows for unknown tenant', () => {
    const rows = scopeToTenant(db, 'tenant-c').memories.list('agent-a')
    expect(rows).toHaveLength(0)
  })

  it('category filter works within tenant', () => {
    db.exec(`INSERT INTO memories (agent_id, category, content, tenant_id)
      VALUES ('agent-a', 'cold', 'cold-content', 'tenant-a')`)
    const warm = scopeToTenant(db, 'tenant-a').memories.list('agent-a', 'warm')
    expect(warm).toHaveLength(1)
    const cold = scopeToTenant(db, 'tenant-a').memories.list('agent-a', 'cold')
    expect(cold).toHaveLength(1)
  })

  it('get returns row only within correct tenant', () => {
    const scope = scopeToTenant(db, 'tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    expect(scope.memories.get(row.id)).not.toBeNull()
  })

  it('get returns null for row in different tenant', () => {
    const scope = scopeToTenant(db, 'tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    expect(scope.memories.get(row.id)).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant(db, 'tenant-a').memories.insert('agent-a', 'hot', 'new-insert-content', 'new-kw')
    const row = db.prepare('SELECT tenant_id FROM memories WHERE content = ?').get('new-insert-content') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('insert into tenant-a is invisible to tenant-b', () => {
    scopeToTenant(db, 'tenant-a').memories.insert('agent-a', 'hot', 'hidden-content')
    const rows = scopeToTenant(db, 'tenant-b').memories.list('agent-a')
    expect(rows.find((r) => r.content === 'hidden-content')).toBeUndefined()
  })

  it('update patches only own-tenant row', () => {
    const scope = scopeToTenant(db, 'tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    const changed = scope.memories.update(row.id, { category: 'cold' })
    expect(changed).toBe(true)
    const updated = db.prepare('SELECT category FROM memories WHERE id = ?').get(row.id) as { category: string }
    expect(updated.category).toBe('cold')
  })

  it('update cannot touch cross-tenant row', () => {
    const scopeA = scopeToTenant(db, 'tenant-a')
    const rowB = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    const changed = scopeA.memories.update(rowB.id, { category: 'cold' })
    expect(changed).toBe(false)
    const untouched = db.prepare('SELECT category FROM memories WHERE id = ?').get(rowB.id) as { category: string }
    expect(untouched.category).toBe('warm')
  })

  it('delete removes only own-tenant row', () => {
    const scope = scopeToTenant(db, 'tenant-a')
    const row = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content') as { id: number }
    expect(scope.memories.delete(row.id)).toBe(true)
    expect(db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-a-content')).toBeUndefined()
  })

  it('delete cannot remove cross-tenant row', () => {
    const scopeA = scopeToTenant(db, 'tenant-a')
    const rowB = db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content') as { id: number }
    expect(scopeA.memories.delete(rowB.id)).toBe(false)
    expect(db.prepare('SELECT id FROM memories WHERE content = ?').get('mem-b-content')).toBeDefined()
  })
})

// ── kanban ────────────────────────────────────────────────────────────────────

describe('scopeToTenant -- kanban', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    db.exec(`
      INSERT INTO kanban_cards (id, title, tenant_id) VALUES ('card-a', 'Task A', 'tenant-a');
      INSERT INTO kanban_cards (id, title, tenant_id) VALUES ('card-b', 'Task B', 'tenant-b');
    `)
  })

  it('list returns only tenant-a cards', () => {
    const cards = scopeToTenant(db, 'tenant-a').kanban.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('card-a')
  })

  it('cross-tenant list returns 0 cards', () => {
    expect(scopeToTenant(db, 'tenant-c').kanban.list()).toHaveLength(0)
  })

  it('status filter works within tenant', () => {
    db.exec(`UPDATE kanban_cards SET status = 'done' WHERE id = 'card-a'`)
    const planned = scopeToTenant(db, 'tenant-a').kanban.list('planned')
    expect(planned).toHaveLength(0)
    const done = scopeToTenant(db, 'tenant-a').kanban.list('done')
    expect(done).toHaveLength(1)
  })

  it('get returns card only in correct tenant', () => {
    expect(scopeToTenant(db, 'tenant-a').kanban.get('card-a')).not.toBeNull()
    expect(scopeToTenant(db, 'tenant-b').kanban.get('card-a')).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant(db, 'tenant-a').kanban.insert('card-new', 'New Task')
    const row = db.prepare('SELECT tenant_id FROM kanban_cards WHERE id = ?').get('card-new') as {
      tenant_id: string
    }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('update only affects own-tenant card', () => {
    expect(scopeToTenant(db, 'tenant-a').kanban.update('card-a', { status: 'done' })).toBe(true)
    expect(scopeToTenant(db, 'tenant-a').kanban.update('card-b', { status: 'done' })).toBe(false)
    const b = db.prepare('SELECT status FROM kanban_cards WHERE id = ?').get('card-b') as { status: string }
    expect(b.status).toBe('planned')
  })

  it('delete only removes own-tenant card', () => {
    expect(scopeToTenant(db, 'tenant-a').kanban.delete('card-b')).toBe(false)
    expect(db.prepare('SELECT id FROM kanban_cards WHERE id = ?').get('card-b')).toBeDefined()
    expect(scopeToTenant(db, 'tenant-a').kanban.delete('card-a')).toBe(true)
    expect(db.prepare('SELECT id FROM kanban_cards WHERE id = ?').get('card-a')).toBeUndefined()
  })
})

// ── agentMessages ─────────────────────────────────────────────────────────────

describe('scopeToTenant -- agentMessages', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    db.exec(`
      INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id)
        VALUES ('agent-x', 'agent-y', 'msg-a', 'tenant-a');
      INSERT INTO agent_messages (from_agent, to_agent, content, tenant_id)
        VALUES ('agent-x', 'agent-y', 'msg-b', 'tenant-b');
    `)
  })

  it('listFor returns only tenant-a messages', () => {
    const msgs = scopeToTenant(db, 'tenant-a').agentMessages.listFor('agent-y')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe('msg-a')
  })

  it('cross-tenant listFor returns 0 messages', () => {
    expect(scopeToTenant(db, 'tenant-c').agentMessages.listFor('agent-y')).toHaveLength(0)
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant(db, 'tenant-a').agentMessages.insert('agent-x', 'agent-z', 'hello')
    const row = db
      .prepare('SELECT tenant_id FROM agent_messages WHERE content = ?')
      .get('hello') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('status filter works within tenant', () => {
    db.exec(`UPDATE agent_messages SET status = 'done' WHERE content = 'msg-a'`)
    const pending = scopeToTenant(db, 'tenant-a').agentMessages.listFor('agent-y', 'pending')
    expect(pending).toHaveLength(0)
    const done = scopeToTenant(db, 'tenant-a').agentMessages.listFor('agent-y', 'done')
    expect(done).toHaveLength(1)
  })
})

// ── importMemories ────────────────────────────────────────────────────────────

describe('scopeToTenant -- importMemories', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    db.exec(`
      INSERT INTO import_memories (id, source_id, file_path, content, tenant_id)
        VALUES ('im-a', 'src-1', '/a.md', 'body-a', 'tenant-a');
      INSERT INTO import_memories (id, source_id, file_path, content, tenant_id)
        VALUES ('im-b', 'src-1', '/b.md', 'body-b', 'tenant-b');
    `)
  })

  it('listForSource returns only tenant-a memories', () => {
    const rows = scopeToTenant(db, 'tenant-a').importMemories.listForSource('src-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('im-a')
  })

  it('cross-tenant listForSource returns 0 rows', () => {
    expect(scopeToTenant(db, 'tenant-c').importMemories.listForSource('src-1')).toHaveLength(0)
  })

  it('get returns record only in correct tenant', () => {
    expect(scopeToTenant(db, 'tenant-a').importMemories.get('im-a')).not.toBeNull()
    expect(scopeToTenant(db, 'tenant-a').importMemories.get('im-b')).toBeNull()
  })

  it('insert stamps correct tenant_id', () => {
    scopeToTenant(db, 'tenant-a').importMemories.insert('im-new', 'src-2', '/new.md', 'body')
    const row = db
      .prepare('SELECT tenant_id FROM import_memories WHERE id = ?')
      .get('im-new') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('delete removes only own-tenant record', () => {
    expect(scopeToTenant(db, 'tenant-a').importMemories.delete('im-b')).toBe(false)
    expect(db.prepare('SELECT id FROM import_memories WHERE id = ?').get('im-b')).toBeDefined()
    expect(scopeToTenant(db, 'tenant-a').importMemories.delete('im-a')).toBe(true)
    expect(db.prepare('SELECT id FROM import_memories WHERE id = ?').get('im-a')).toBeUndefined()
  })
})

// ── default tenant backward-compat ───────────────────────────────────────────

describe('scopeToTenant -- default tenant backward-compat', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDb()
    // Simulate rows that got tenant_id = 'default' from the migration backfill.
    db.exec(`
      INSERT INTO memories (agent_id, category, content, keywords, tenant_id)
        VALUES ('agent-a', 'warm', 'legacy-content', 'legacy-kw', 'default');
      INSERT INTO kanban_cards (id, title, tenant_id)
        VALUES ('legacy-card', 'Legacy Task', 'default');
    `)
  })

  it('default tenant scope sees legacy memory rows', () => {
    const rows = scopeToTenant(db, 'default').memories.list('agent-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('legacy-content')
  })

  it('default tenant scope sees legacy kanban cards', () => {
    const cards = scopeToTenant(db, 'default').kanban.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.id).toBe('legacy-card')
  })

  it('non-default tenant does not see legacy rows', () => {
    expect(scopeToTenant(db, 'tenant-new').memories.list('agent-a')).toHaveLength(0)
    expect(scopeToTenant(db, 'tenant-new').kanban.list()).toHaveLength(0)
  })
})
