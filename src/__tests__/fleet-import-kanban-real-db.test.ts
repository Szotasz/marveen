// The fleet import's kanban card INSERT, run against a REAL SQLite schema.
//
// fleet-transfer.test.ts mocks the whole db module, so the INSERT there is only
// a string: a VALUES list one placeholder short, or two bound values swapped,
// stays green and only fails on a real import on the new machine (measured
// 2026-10-16 in a review: a short placeholder count passed every kanban and
// fleet-transfer test). Here the db module is the real one on ':memory:', the
// file system writes are stubbed, and a card carrying a distinct value in every
// live kanban_cards column has to come back from SELECT * exactly as exported
// (the export side is SELECT *).
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  // The embedding backfill is fire-and-forget network work; not part of this check.
  return { ...real, backfillEmbeddings: async () => 0 }
})

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const refuse = () => { throw new Error('fleet-import-kanban-real-db: unexpected file write') }
  return {
    ...real,
    existsSync: () => false,
    mkdirSync: () => undefined,
    unlinkSync: () => undefined,
    rmSync: () => undefined,
    readdirSync: () => [],
    writeFileSync: refuse,
    renameSync: refuse,
  }
})

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: () => { throw new Error('fleet-import-kanban-real-db: unexpected file write') },
}))

vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
  readJsonObjectForWrite: () => ({}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/mock/tasks',
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: () => [],
}))

vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  updateEnvFile: () => { throw new Error('fleet-import-kanban-real-db: unexpected .env write') },
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

import { initDatabase, getDb } from '../db.js'
import { importFleet } from '../web/fleet-transfer.js'

const fleetWith = (cards: unknown[]) => JSON.stringify({
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'test-host',
  agents: [],
  skills: [],
  scheduledTasks: [],
  memories: [],
  dailyLogs: [],
  kanban: { cards, comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
})

// A distinct value for every live column, so a dropped column, a short or long
// VALUES list and two swapped bindings all change what comes back. Columns with
// a CHECK or a reference get a valid value; everything else is derived from the
// column's declared type and position.
const FIXED: Record<string, unknown> = {
  id: 'fleet-real-db-card',
  title: 'Imported card',
  status: 'waiting',
  priority: 'high',
  parent_id: null,
}

function cardForLiveSchema(): Record<string, unknown> {
  const cols = getDb().prepare('PRAGMA table_info(kanban_cards)').all() as { name: string; type: string }[]
  const card: Record<string, unknown> = {}
  cols.forEach((c, i) => {
    if (c.name in FIXED) card[c.name] = FIXED[c.name]
    else if (/INT/i.test(c.type)) card[c.name] = 1_790_000_000 + i * 1_000
    else card[c.name] = `value-of-${c.name}`
  })
  return card
}

describe('fleet import: a kanban card survives a real SQLite import', () => {
  it('every live kanban_cards column comes back exactly as exported', () => {
    initDatabase(':memory:')
    const card = cardForLiveSchema()
    // Positive control: the schema was read, and it is the full card table.
    expect(Object.keys(card)).toContain('title')
    expect(Object.keys(card).length).toBeGreaterThan(10)

    const result = importFleet(fleetWith([card]), { apply: true }) as { errors?: string[] }
    expect(result.errors ?? []).toEqual([])

    const back = getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(card.id)
    expect(back, 'the card was not written -- the INSERT failed or was skipped').toBeDefined()
    expect(back).toEqual(card)
  })

  it('the import is idempotent on a real schema (INSERT OR IGNORE)', () => {
    initDatabase(':memory:')
    const card = cardForLiveSchema()
    importFleet(fleetWith([card]), { apply: true })
    const second = importFleet(fleetWith([{ ...card, title: 'Changed on the second run' }]), { apply: true }) as { errors?: string[] }
    // A second import of the same card is not an error, and it does not overwrite.
    expect(second.errors ?? []).toEqual([])
    const rows = getDb().prepare('SELECT title FROM kanban_cards WHERE id = ?').all(card.id) as { title: string }[]
    expect(rows).toEqual([{ title: 'Imported card' }])
  })
})
