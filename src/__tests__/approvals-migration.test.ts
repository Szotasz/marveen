import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'

// Review feedback on PR #762: every approvals test built a fresh database, so
// none of them exercised the rebuild path that actually carries the risk. This
// suite starts from a SEEDED old-schema database on disk -- the shape a real
// pre-migration install has -- and asserts the two properties the migration
// must hold: row preservation and idempotency, plus self-healing from an
// interrupted pre-fix run.

const OLD_SCHEMA = `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    category TEXT NOT NULL,
    action_description TEXT NOT NULL,
    action_payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','rejected','timeout')),
    timeout_at INTEGER,
    telegram_message_id INTEGER,
    requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER,
    resolved_by TEXT
  );
  CREATE INDEX idx_approvals_status ON approvals(status, requested_at);
  CREATE INDEX idx_approvals_agent ON approvals(agent_id, requested_at);
`

// Edge-case rows on purpose: unicode, NULLs in every nullable column, every
// legal old-schema status.
const SEED_ROWS = [
  { id: 'a-1', agent_id: 'marveen', category: 'email_send', action_description: 'Küldjem? Árvíztűrő tükörfúrógép 🚀', action_payload: '{"to":"x@y.hu"}', status: 'pending', timeout_at: 1753900000, telegram_message_id: 42, requested_at: 1753890000, resolved_at: null, resolved_by: null },
  { id: 'a-2', agent_id: 'prisma', category: 'deploy', action_description: 'plain ascii', action_payload: null, status: 'approved', timeout_at: null, telegram_message_id: null, requested_at: 1753890001, resolved_at: 1753890100, resolved_by: 'Viktor' },
  { id: 'a-3', agent_id: 'atlas', category: 'infra', action_description: 'multi\nline\ntext', action_payload: '{"nested":{"deep":true}}', status: 'rejected', timeout_at: 1753900002, telegram_message_id: 7, requested_at: 1753890002, resolved_at: 1753890200, resolved_by: 'Viktor' },
  { id: 'a-4', agent_id: 'edina1', category: 'marketing', action_description: 'قرار عربي – 中文決定', action_payload: null, status: 'timeout', timeout_at: 1753900003, telegram_message_id: null, requested_at: 1753890003, resolved_at: 1753890300, resolved_by: null },
  { id: 'a-5', agent_id: 'polaris', category: 'design', action_description: "quote ' and \" double", action_payload: '[]', status: 'pending', timeout_at: null, telegram_message_id: 0, requested_at: 1753890004, resolved_at: null, resolved_by: '' },
]

const OLD_COLUMNS = [
  'id', 'agent_id', 'category', 'action_description', 'action_payload', 'status',
  'timeout_at', 'telegram_message_id', 'requested_at', 'resolved_at', 'resolved_by',
] as const

let dir: string
let dbPath: string

function seedOldSchemaDb(path: string): void {
  const raw = new Database(path)
  raw.exec(OLD_SCHEMA)
  const ins = raw.prepare(`INSERT INTO approvals (${OLD_COLUMNS.join(',')}) VALUES (${OLD_COLUMNS.map(c => '@' + c).join(',')})`)
  for (const row of SEED_ROWS) ins.run(row)
  raw.close()
}

function readRows(path: string): Record<string, unknown>[] {
  const raw = new Database(path, { readonly: true })
  const rows = raw.prepare(`SELECT ${OLD_COLUMNS.join(',')} FROM approvals ORDER BY id`).all() as Record<string, unknown>[]
  raw.close()
  return rows
}

function tableSql(path: string, name: string): string | undefined {
  const raw = new Database(path, { readonly: true })
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined
  raw.close()
  return row?.sql
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approvals-mig-'))
  dbPath = join(dir, 'seeded.db')
})

afterEach(() => {
  // Point the module-global handle away from the temp file before removing it.
  initDatabase(':memory:')
  rmSync(dir, { recursive: true, force: true })
})

describe('approvals decision-options migration from a seeded old-schema database', () => {
  it('rebuilds the schema and preserves every row byte-identically', () => {
    seedOldSchemaDb(dbPath)

    initDatabase(dbPath)

    const sql = tableSql(dbPath, 'approvals')
    expect(sql).toContain("'decided'")
    expect(sql).toContain('card_id')

    // Row preservation, including unicode, NULLs, empty string and zero.
    expect(readRows(dbPath)).toEqual(SEED_ROWS)

    // The card index is created in the same transaction as the rebuild.
    const raw = new Database(dbPath, { readonly: true })
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_approvals_card'").get()
    raw.close()
    expect(idx).toBeTruthy()
  })

  it('is idempotent: a second init run is a clean no-op on the rows', () => {
    seedOldSchemaDb(dbPath)

    initDatabase(dbPath)
    initDatabase(dbPath)

    expect(readRows(dbPath)).toEqual(SEED_ROWS)
  })

  it('self-heals a leftover approvals_new from an interrupted pre-fix run', () => {
    seedOldSchemaDb(dbPath)
    // Simulate the pre-fix crash seam: a stale half-built shadow table next to
    // the intact old-schema approvals.
    const raw = new Database(dbPath)
    raw.exec('CREATE TABLE approvals_new (id TEXT PRIMARY KEY, junk TEXT)')
    raw.prepare("INSERT INTO approvals_new (id, junk) VALUES ('stale', 'leftover')").run()
    raw.close()

    initDatabase(dbPath)

    expect(tableSql(dbPath, 'approvals_new')).toBeUndefined()
    expect(tableSql(dbPath, 'approvals')).toContain("'decided'")
    expect(readRows(dbPath)).toEqual(SEED_ROWS)
  })
})
