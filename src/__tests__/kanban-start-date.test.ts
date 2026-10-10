// Planned start date (kanban_cards.start_date): the day work on a card is
// planned to begin, drawn as the left end of its timeline bar.
//
// Under test:
//   1. normaliseCardDate coerces the shapes a caller naturally sends (unix
//      seconds, seconds as text, "YYYY-MM-DD") to integer seconds, and a bare
//      date becomes UTC midnight -- the instant the dashboard's own date input
//      produces, so the edit modal reads the same day back;
//   2. POST and PUT /api/kanban accept start_date (POST without an
//      unknown-field warning), and a PUT that does not send it leaves it alone;
//   3. the column survives the testing-status table rebuild on an old database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, createKanbanCard, getKanbanCard, updateKanbanCard, normaliseCardDate,
} from '../db.js'
import { logger } from '../logger.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const OCT10 = Date.UTC(2026, 9, 10) / 1000

function routeCtx(method: 'POST' | 'PUT', path: string, payload: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('normaliseCardDate', () => {
  it('passes integer seconds through and floors fractional ones', () => {
    expect(normaliseCardDate(OCT10)).toBe(OCT10)
    expect(normaliseCardDate(OCT10 + 0.7)).toBe(OCT10)
  })

  it('reads seconds sent as text', () => {
    expect(normaliseCardDate(String(OCT10))).toBe(OCT10)
  })

  it('turns a bare YYYY-MM-DD into UTC midnight, the same instant the date input sends', () => {
    expect(normaliseCardDate('2026-10-10')).toBe(OCT10)
    expect(normaliseCardDate('2026-10-10')).toBe(Math.floor(new Date('2026-10-10').getTime() / 1000))
    // the edit modal reads the value back with toISOString: it must be the same day
    expect(new Date(normaliseCardDate('2026-10-10')! * 1000).toISOString().slice(0, 10)).toBe('2026-10-10')
  })

  it('maps empty and unparseable input to null instead of storing it', () => {
    for (const v of [null, undefined, '', 'next week', Number.NaN, {}]) {
      expect(normaliseCardDate(v)).toBeNull()
    }
  })
})

describe('start_date on create and update', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('createKanbanCard stores a normalised start_date, and null when absent', () => {
    createKanbanCard({ id: 's1', title: 'Planned', start_date: '2026-10-10' })
    createKanbanCard({ id: 's2', title: 'Unplanned' })
    expect(getKanbanCard('s1')!.start_date).toBe(OCT10)
    expect(getKanbanCard('s2')!.start_date).toBeNull()
  })

  it('updateKanbanCard sets, keeps and clears start_date', () => {
    createKanbanCard({ id: 's3', title: 'Card' })
    expect(updateKanbanCard('s3', { start_date: OCT10 })).toBe(true)
    expect(getKanbanCard('s3')!.start_date).toBe(OCT10)
    updateKanbanCard('s3', { title: 'Renamed' })
    expect(getKanbanCard('s3')!.start_date).toBe(OCT10)
    updateKanbanCard('s3', { start_date: null })
    expect(getKanbanCard('s3')!.start_date).toBeNull()
  })
})

describe('start_date over HTTP', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    initDatabase(':memory:')
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  })
  afterEach(() => { warn.mockRestore() })

  it('POST /api/kanban stores start_date and does not warn about it as unknown', async () => {
    const { ctx, out } = routeCtx('POST', '/api/kanban', { title: 'With start', start_date: '2026-10-10' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.id)!.start_date).toBe(OCT10)
    expect(warn).not.toHaveBeenCalled()
  })

  it('PUT /api/kanban/:id accepts start_date (no 400 unknown field)', async () => {
    createKanbanCard({ id: 'h1', title: 'Card' })
    const { ctx, out } = routeCtx('PUT', '/api/kanban/h1', { start_date: OCT10 })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('h1')!.start_date).toBe(OCT10)
  })
})

describe('start_date migration', () => {
  it('survives the testing-status table rebuild on an old database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'start-date-mig-'))
    const file = join(dir, 'old.db')
    try {
      const old = new Database(file)
      old.exec(`CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
        assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, archived_at INTEGER)`)
      old.close()
      initDatabase(file)
      const cols = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).map((c) => c.name)
      const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name='kanban_cards'").get() as { sql: string }).sql
      expect(sql).toContain("'testing'")
      expect(cols).toContain('start_date')
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
