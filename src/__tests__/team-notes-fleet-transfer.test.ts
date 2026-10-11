// Team notes travel with a fleet export/import (src/web/fleet-transfer.ts).
// The import uses a fixed column list per table, so a table that is not named
// there drops silently on a move to a new machine. These tests drive the real
// exportFleet/importFleet against a recording fake database (the same mocks as
// fleet-transfer.test.ts) and check what is read and written.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Call = { sql: string; args: unknown[]; kind: 'all' | 'get' | 'run' }
const calls: Call[] = []
let rowsFor: (sql: string) => unknown[] = () => []
let existing = new Set<string>()

vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => { calls.push({ sql, args, kind: 'all' }); return rowsFor(sql) },
      get: (...args: unknown[]) => {
        calls.push({ sql, args, kind: 'get' })
        return /FROM team_notes WHERE id/.test(sql) && existing.has(String(args[0])) ? { 1: 1 } : null
      },
      run: (...args: unknown[]) => { calls.push({ sql, args, kind: 'run' }); return { changes: 1 } },
    }),
    transaction: (fn: Function) => fn,
  }),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
  readJsonObjectForWrite: () => ({}),
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: () => false, mkdirSync: () => undefined, unlinkSync: () => undefined, rmSync: () => undefined, readdirSync: () => [] }
})
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: '/mock/tasks' }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project', STORE_DIR: '/mock/store', MAIN_AGENT_ID: 'marveen', BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen', OWNER_NAME: 'Owner', CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

const NOTE = { id: 'abc123', assignee: 'cody', content: 'check the build', due_date: '2026-10-20', created_at: 1791700000, created_by: 'margo', deleted_at: null, deleted_by: null, delete_reason: null }
const DELETED = { id: 'def456', assignee: 'mindenki', content: 'old line', due_date: null, created_at: 1791600000, created_by: 'cody', deleted_at: 1791650000, deleted_by: 'cody', delete_reason: 'done' }

function fleet(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', sourceHost: 'test-host',
    agents: [], skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
    kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    ...extra,
  })
}

// team_notes columns as db.ts creates them.
function teamNotesColumns(): string[] {
  const db = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf-8')
  const m = db.match(/CREATE TABLE IF NOT EXISTS team_notes \(([\s\S]*?)\n\s*\)/)
  if (!m) throw new Error('team_notes CREATE TABLE not found')
  return m[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
}

beforeEach(() => { calls.length = 0; rowsFor = () => []; existing = new Set() })

describe('fleet transfer: team notes', () => {
  it('export reads the whole team_notes table into teamNotes', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    rowsFor = (sql) => (/FROM team_notes/.test(sql) ? [NOTE, DELETED] : [])
    const { data } = exportFleet()
    expect(calls.some((c) => c.kind === 'all' && /SELECT \* FROM team_notes/.test(c.sql))).toBe(true)
    expect(JSON.parse(data).teamNotes).toEqual([NOTE, DELETED])
  })

  it('apply inserts every note, deleted ones included, naming every team_notes column, and skips a broken row', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const broken = { id: 'bad000', assignee: 'cody', content: '', created_at: 1, created_by: 'x' }
    const r = importFleet(fleet({ teamNotes: [NOTE, DELETED, broken] }), { apply: true }) as { ok: boolean; imported: { teamNotes: number } }
    expect(r.ok).toBe(true)
    expect(r.imported.teamNotes).toBe(3)
    const inserts = calls.filter((c) => c.kind === 'run' && /INSERT OR IGNORE INTO team_notes/.test(c.sql))
    expect(inserts).toHaveLength(2)
    const cols = inserts[0].sql.match(/\(([^)]*)\)\s*VALUES/)![1].split(',').map((s) => s.trim())
    expect([...cols].sort()).toEqual([...teamNotesColumns()].sort())
    const asRow = (args: unknown[]) => Object.fromEntries(cols.map((c, i) => [c, args[i]]))
    expect(asRow(inserts[0].args)).toEqual(NOTE)
    expect(asRow(inserts[1].args)).toEqual(DELETED)
  })

  it('dry run counts only the notes the target does not have yet', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    existing = new Set(['abc123'])
    const r = importFleet(fleet({ teamNotes: [NOTE, DELETED] }), { apply: false }) as { wouldCreate: { teamNotes: number } }
    expect(r.wouldCreate.teamNotes).toBe(1)
    expect(calls.some((c) => c.kind === 'run')).toBe(false)
  })

  it('an export made before the Notes page (no teamNotes key) imports as zero notes', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const dry = importFleet(fleet(), { apply: false }) as { errors: string[]; wouldCreate: { teamNotes: number } }
    expect(dry.errors).toEqual([])
    expect(dry.wouldCreate.teamNotes).toBe(0)
    const applied = importFleet(fleet(), { apply: true }) as { imported: { teamNotes: number } }
    expect(applied.imported.teamNotes).toBe(0)
  })
})
