// Card 8fe51afd: a card's testing instructions had no field of their own, so
// they were written into comments. Finding "what do I have to test" meant
// reading the whole comment thread -- and a comment thread is a work trace, not
// a checklist: the newest comment is on top, the steps sit somewhere in the
// middle of a report, and nothing says which version is current.
//
// `test_steps` is that field. The guarantees under test:
//   1. POST stores it, PUT changes it, the list read carries it;
//   2. a PUT that echoes it back unchanged is still a no-op (the "this card is
//      stale" signal survives, #1023);
//   3. an install whose table predates the column gets it by migration;
//   4. the fleet import does not silently drop it -- measured against the LIVE
//      schema, so the next new column is covered too;
//   5. the dashboard has a field for it and shows it in its own block, marked
//      when the card is in `testing`.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { initDatabase, createKanbanCard, getKanbanCard, getDb, KANBAN_WRITABLE_FIELDS, KANBAN_CREATE_FIELDS } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8')

function ctxFor(method: string, path: string, payload?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = payload === undefined
    ? Readable.from([Buffer.from('')])
    : Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

const STEPS = '1. Nyisd meg a kártyát\n2. Mozgasd testingre\n3. A blokk kiemelve látszik'

describe('kanban test_steps -- the API stores and returns it', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('is in both writer field sets, so POST and PUT can reach it', () => {
    expect(KANBAN_CREATE_FIELDS as readonly string[]).toContain('test_steps')
    expect(KANBAN_WRITABLE_FIELDS as readonly string[]).toContain('test_steps')
  })

  it('POST /api/kanban stores test_steps instead of dropping it', async () => {
    const { ctx, out } = ctxFor('POST', '/api/kanban', { id: 'ts1', title: 'Card', test_steps: STEPS })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('ts1')!.test_steps).toBe(STEPS)
  })

  it('PUT /api/kanban/:id accepts test_steps and writes it', async () => {
    createKanbanCard({ id: 'ts2', title: 'Card' })
    expect(getKanbanCard('ts2')!.test_steps).toBeNull()
    const { ctx, out } = ctxFor('PUT', '/api/kanban/ts2', { test_steps: STEPS })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('ts2')!.test_steps).toBe(STEPS)
  })

  it('an unchanged test_steps echo is a no-op: updated_at does not move', async () => {
    createKanbanCard({ id: 'ts3', title: 'Card', test_steps: STEPS })
    const before = getKanbanCard('ts3')!
    await new Promise((r) => setTimeout(r, 1100))
    const { ctx, out } = ctxFor('PUT', '/api/kanban/ts3', { test_steps: STEPS })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('ts3')!.updated_at).toBe(before.updated_at)
  })

  it('the list read carries test_steps', async () => {
    createKanbanCard({ id: 'ts4', title: 'Card', test_steps: STEPS })
    const { ctx, out } = ctxFor('GET', '/api/kanban')
    expect(await tryHandleKanban(ctx)).toBe(true)
    const row = (out.body as any[]).find((c) => c.id === 'ts4')
    expect(row.test_steps).toBe(STEPS)
  })
})

describe('kanban test_steps -- an install older than the column', () => {
  it('gets the column by migration, and the existing rows survive', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kanban-ts-')), 'old.db')
    // The table exactly as an install before this change has it: no test_steps,
    // but already carrying 'testing' in the CHECK list, so the table-rebuild
    // migration does NOT run and the new column has to come from the ALTER.
    const old = new Database(file)
    old.exec(`
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT,
        due_date INTEGER,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        parent_id TEXT REFERENCES kanban_cards(id),
        dispatched_at INTEGER
      );
      INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('vane', 'Már bent volt', 'planned', 'normal', 0, 1, 1);
    `)
    // Negative control: before the migration the column really is absent, so a
    // passing assertion below cannot come from the fixture already having it.
    const cols = () => (old.prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).map((c) => c.name)
    expect(cols()).not.toContain('test_steps')
    old.close()

    initDatabase(file)
    const after = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).map((c) => c.name)
    expect(after).toContain('test_steps')
    expect(getKanbanCard('vane')!.title).toBe('Már bent volt')
    expect(getKanbanCard('vane')!.test_steps).toBeNull()
  })
})

describe('kanban test_steps -- the fleet import writes every card column', () => {
  it('the import INSERT names the whole live column set', () => {
    initDatabase(':memory:')
    const live = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).map((c) => c.name)
    const src = read('src', 'web', 'fleet-transfer.ts')
    const m = src.match(/INSERT OR IGNORE INTO kanban_cards\s*\n?\s*\(([^)]*)\)/)
    expect(m, 'the import INSERT was not found -- this check measured nothing').not.toBeNull()
    const named = m![1].split(',').map((s) => s.trim()).filter(Boolean)
    // Positive control: the extraction really produced the column list.
    expect(named).toContain('title')
    expect(named.length).toBeGreaterThan(10)
    // A column the import does not name is a column a transferred card loses.
    expect([...live].sort()).toEqual([...named].sort())
  })
})

describe('kanban test_steps -- the dashboard has a field and a block for it', () => {
  const html = read('web', 'index.html')
  const app = read('web', 'app.js')

  it('the card form has a test_steps input, and the detail view its own block', () => {
    expect(html).toContain('id="cardTestSteps"')
    expect(html).toContain('id="cardDetailTestSteps"')
  })

  it('a new card starts the field empty and sends it on save', () => {
    expect(app).toContain("document.getElementById('cardTestSteps').value = ''")
    expect(app).toMatch(/test_steps:\s*document\.getElementById\('cardTestSteps'\)\.value/)
  })

  it('editing an existing card loads the stored steps back into the field', () => {
    expect(app).toMatch(/document\.getElementById\('cardTestSteps'\)\.value = card\.test_steps \|\| ''/)
  })

  it('the detail block is marked when the card is in testing', () => {
    expect(app).toMatch(/cardDetailTestSteps[\s\S]{0,400}card\.status === 'testing'/)
    expect(read('web', 'style.css')).toContain('card-detail-test-steps')
  })

  it('both languages name the field', () => {
    for (const lang of ['hu.js', 'en.js']) {
      expect(read('web', 'lang', lang)).toContain("'kanban.test_steps.title'")
    }
  })
})
