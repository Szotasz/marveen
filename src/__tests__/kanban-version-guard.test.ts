// Contract tests: the whole-card PUT is refused (409) when the body was based on
// a card version that has moved on, instead of silently overwriting the change.
//
// The failure this closes: a client GETs a card, keeps it, and PUTs the whole
// object back (the dashboard does that on every assignee and parent edit). By
// then the body carries the OLD description, and the write reverted whatever
// anyone had added to it meanwhile -- with a 200.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import Database from 'better-sqlite3'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: vi.fn() }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import {
  initDatabase, getDb, createKanbanCard, getKanbanCard, updateKanbanCard, writeKanbanCard,
  addKanbanComment, archiveKanbanCard, claimKanbanCard, KANBAN_WRITABLE_FIELDS,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function call(method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 200
  let sent = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((chunk?: unknown) => { if (chunk != null) sent += String(chunk) }),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path, method, url: new URL(`http://localhost${path}`),
  } as never)
  expect(handled).toBe(true)
  return { status, body: sent ? JSON.parse(sent) as Record<string, unknown> : {} }
}

const put = (id: string, fields: Record<string, unknown>) => call('PUT', `/api/kanban/${id}`, fields)
const move = (id: string, status: string) => call('POST', `/api/kanban/${id}/move`, { status, sort_order: 0, actor: 'orin' })

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
})

describe('kanban card version', () => {
  it('a new card starts at version 0, and a real field change moves it', () => {
    createKanbanCard({ id: 'v1', title: 'Card' })
    expect(getKanbanCard('v1')?.version).toBe(0)
    updateKanbanCard('v1', { description: 'first' })
    expect(getKanbanCard('v1')?.version).toBe(1)
  })

  it('a write that changes nothing does not move it', () => {
    createKanbanCard({ id: 'v2', title: 'Card' })
    updateKanbanCard('v2', { title: 'Card' })
    expect(getKanbanCard('v2')?.version).toBe(0)
  })

  it('a script writing the table directly moves it too (the trigger, not the TypeScript path)', () => {
    createKanbanCard({ id: 'v3', title: 'Card' })
    getDb().prepare('UPDATE kanban_cards SET description = ? WHERE id = ?').run('from a script', 'v3')
    expect(getKanbanCard('v3')?.version).toBe(1)
  })

  it('/move moves it: a status change is a change a stale whole-card PUT would revert', async () => {
    createKanbanCard({ id: 'v4', title: 'Card', assignee: 'dex' })
    expect((await move('v4', 'waiting')).status).toBe(200)
    expect(getKanbanCard('v4')?.version).toBe(1)
  })

  it('archiving moves it (archived_at is written back by a whole-card PUT)', () => {
    createKanbanCard({ id: 'v6', title: 'Card' })
    expect(archiveKanbanCard('v6')).toBe(true)
    expect(getKanbanCard('v6')?.version).toBe(1)
  })

  it('comments, claims, dispatch stamps and updated_at do not move it -- a PUT cannot overwrite those', () => {
    createKanbanCard({ id: 'v5', title: 'Card' })
    addKanbanComment('v5', 'dex', 'a comment')
    expect(claimKanbanCard('v5', 'dex').ok).toBe(true)
    getDb().prepare('UPDATE kanban_cards SET dispatched_at = ?, updated_at = ? WHERE id = ?').run(1, 2, 'v5')
    expect(getKanbanCard('v5')?.version).toBe(0)
  })

  it('the trigger watches exactly KANBAN_WRITABLE_FIELDS', () => {
    const row = getDb().prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'kanban_cards_version_bump'")
      .get() as { sql: string } | undefined
    expect(row).toBeDefined()
    const of = /AFTER UPDATE OF (.+?) ON kanban_cards/.exec(row!.sql)?.[1].split(',').map((s) => s.trim())
    expect(of).toEqual([...KANBAN_WRITABLE_FIELDS])
    // Every watched column is compared, not only listed: a column in the OF list
    // but missing from WHEN would fire the trigger and never bump.
    for (const c of KANBAN_WRITABLE_FIELDS) expect(row!.sql).toContain(`NEW.${c} IS NOT OLD.${c}`)
  })
})

describe('PUT /api/kanban/:id with the version it read', () => {
  it('the lost update: a whole-card PUT based on an old copy is refused, and the newer text survives', async () => {
    createKanbanCard({ id: 'c1', title: 'Card', assignee: 'dex' })
    const copy = { ...getKanbanCard('c1')! }
    // Someone else writes meanwhile.
    expect(updateKanbanCard('c1', { description: 'measurement record' })).toBe(true)

    // The old copy comes back with an unrelated edit, as the dashboard sends it.
    const r = await put('c1', { ...copy, assignee: 'orin' })
    expect(r.status).toBe(409)
    expect(r.body.conflict).toBe('stale_version')
    expect(r.body.current_version).toBe(1)
    const after = getKanbanCard('c1')!
    expect(after.description).toBe('measurement record')
    expect(after.assignee).toBe('dex')
  })

  it('control: the same PUT without a version still overwrites (the old behaviour, unchanged)', async () => {
    createKanbanCard({ id: 'c2', title: 'Card', assignee: 'dex' })
    const { version: _drop, ...copy } = getKanbanCard('c2')!
    updateKanbanCard('c2', { description: 'measurement record' })
    const r = await put('c2', { ...copy, assignee: 'orin' })
    expect(r.status).toBe(200)
    expect(getKanbanCard('c2')?.description).toBeNull()
  })

  it('expected_version: a partial body is checked the same way', async () => {
    createKanbanCard({ id: 'c3', title: 'Card' })
    updateKanbanCard('c3', { description: 'newer' })
    const stale = await put('c3', { description: 'older', expected_version: 0 })
    expect(stale.status).toBe(409)
    expect(getKanbanCard('c3')?.description).toBe('newer')

    const fresh = await put('c3', { description: 'edited on top', expected_version: 1 })
    expect(fresh.status).toBe(200)
    expect(fresh.body.version).toBe(2)
    expect(getKanbanCard('c3')?.description).toBe('edited on top')
  })

  it('the returned version chains: a second write from the same view is not refused as stale against the first', async () => {
    createKanbanCard({ id: 'c4', title: 'Card' })
    const card = { ...getKanbanCard('c4')! }
    const first = await put('c4', { ...card, assignee: 'dex' })
    expect(first.status).toBe(200)
    card.version = first.body.version as number
    card.assignee = 'dex'
    const second = await put('c4', { ...card, priority: 'high' })
    expect(second.status).toBe(200)
    expect(getKanbanCard('c4')).toMatchObject({ assignee: 'dex', priority: 'high' })
  })

  it('a stale version is refused even when the body changes nothing', async () => {
    createKanbanCard({ id: 'c5', title: 'Card' })
    updateKanbanCard('c5', { description: 'newer' })
    expect((await put('c5', { title: 'Card', expected_version: 0 })).status).toBe(409)
  })

  it('a malformed version is a 400 and nothing is written, not an unchecked write', async () => {
    createKanbanCard({ id: 'c6', title: 'Card' })
    for (const bad of ['0', -1, 1.5, null, true]) {
      const r = await put('c6', { description: 'x', expected_version: bad })
      expect(r.status, String(bad)).toBe(400)
      expect((await put('c6', { description: 'x', version: bad })).status, String(bad)).toBe(400)
    }
    expect(getKanbanCard('c6')?.description).toBeNull()
  })

  it('version and expected_version that disagree are a 400', async () => {
    createKanbanCard({ id: 'c7', title: 'Card' })
    expect((await put('c7', { description: 'x', version: 0, expected_version: 1 })).status).toBe(400)
    expect(getKanbanCard('c7')?.description).toBeNull()
  })

  // Another process writing between writeKanbanCard's read and its UPDATE. The seam:
  // the function reads the row, then takes the clock, then writes -- so a clock
  // that performs a write on its first call is exactly that interleaving.
  function raceOnNextClockRead(id: string): void {
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementationOnce(() => {
      getDb().prepare('UPDATE kanban_cards SET description = ? WHERE id = ?').run('written by another process', id)
      return realNow()
    })
  }

  it('race, with a version: a write landing between the read and the UPDATE is not overwritten', () => {
    createKanbanCard({ id: 'r1', title: 'Card' })
    raceOnNextClockRead('r1')
    expect(writeKanbanCard('r1', { assignee: 'dex' }, 'orin', 0)).toEqual({ ok: false, reason: 'stale', current_version: 1 })
    vi.restoreAllMocks()
    expect(getKanbanCard('r1')).toMatchObject({ description: 'written by another process', assignee: null })
  })

  it('race, without a version: still the unconditional write it always was (C2)', () => {
    createKanbanCard({ id: 'r2', title: 'Card' })
    raceOnNextClockRead('r2')
    expect(writeKanbanCard('r2', { assignee: 'dex' }, 'orin').ok).toBe(true)
    vi.restoreAllMocks()
    expect(getKanbanCard('r2')?.assignee).toBe('dex')
  })

  it('writeKanbanCard reports not_found for a missing card, with or without a version', () => {
    expect(writeKanbanCard('nope', { title: 'x' })).toEqual({ ok: false, reason: 'not_found' })
    expect(writeKanbanCard('nope', { title: 'x' }, undefined, 0)).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('migration', () => {
  it('an existing database gets the column, every old row at version 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-version-'))
    try {
      const file = join(dir, 'old.db')
      const old = new Database(file)
      old.exec(`CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
        assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)`)
      old.prepare('INSERT INTO kanban_cards (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('old1', 'Old card', 1, 1)
      old.close()

      initDatabase(file)
      expect(getKanbanCard('old1')?.version).toBe(0)
      updateKanbanCard('old1', { description: 'after upgrade' })
      expect(getKanbanCard('old1')?.version).toBe(1)
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
