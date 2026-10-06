// Stale-card review: open cards that have not changed column for 14+ days go
// in front of the owner, who decides per card with one tap: keep / idea / close.
//
// Three halves:
// - the db contract (listStaleKanbanCards / decideStaleKanbanCard) on an
//   in-memory database;
// - the two routes, driven through tryHandleKanban like kanban-wait-reason;
// - the modal row builder, sliced out of web/app.js and evaluated in a vm.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  initDatabase, getDb, createKanbanCard, getKanbanCard, createLabel, addLabelToCard,
  getKanbanCardEvents, getKanbanComments, listIdeas, archiveKanbanCard,
  listStaleKanbanCards, decideStaleKanbanCard,
} from '../db.js'
import { OWNER_NAME } from '../config.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY = 86400

function route(method: string, path: string, body?: unknown | string) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

const now = () => Math.floor(Date.now() / 1000)

// A card whose last column change happened `days` ago.
function card(id: string, days: number, extra: { status?: any; assignee?: string } = {}) {
  createKanbanCard({ id, title: id, status: extra.status ?? 'planned', assignee: extra.assignee ?? 'cody' })
  getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(now() - days * DAY, id)
  // If createKanbanCard wrote a creation event (non-planned status), age it too.
  getDb().prepare('UPDATE kanban_card_events SET created_at = ? WHERE card_id = ?').run(now() - days * DAY, id)
}

function label(cardId: string, name: string) {
  const id = 'l-' + name.replace(/\W/g, '') + '-' + cardId
  createLabel({ id, name, color: '#888' })
  addLabelToCard(cardId, id)
}

const staleIds = (opts: { now?: number } = {}) => listStaleKanbanCards({ days: 14, ...opts }).map((c) => c.id)

describe('listStaleKanbanCards', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('lists 15 days, not 13, and orders oldest first', () => {
    card('d13', 13); card('d15', 15); card('d40', 40)
    expect(staleIds()).toEqual(['d40', 'd15'])
  })

  it('counts from the last status event, not the creation time', () => {
    card('moved', 40)
    getDb().prepare('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('moved', 'planned', 'in_progress', 'cody', now() - 3 * DAY)
    expect(staleIds()).toEqual([])
  })

  it('excludes done, archived, Folyamatos, both Rád vár spellings and owner cards', () => {
    card('done', 30, { status: 'done' })
    card('arch', 30); archiveKanbanCard('arch')
    card('ongoing', 30); label('ongoing', 'Folyamatos')
    card('radvar', 30); label('radvar', 'Rád vár')
    card('radvar2', 30); label('radvar2', 'rad var')
    card('owner', 30, { assignee: OWNER_NAME })
    card('kept-in', 30, { status: 'waiting' })
    expect(staleIds()).toEqual(['kept-in'])
  })
})

describe('decideStaleKanbanCard', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('keep resets the clock without writing a status event', () => {
    card('a', 30)
    decideStaleKanbanCard('a', 'keep', OWNER_NAME)
    expect(staleIds()).toEqual([])
    expect(staleIds({ now: now() + 15 * DAY })).toEqual(['a'])
    expect(getKanbanCardEvents('a')).toHaveLength(0)
    expect(getKanbanCard('a')?.archived_at).toBeNull()
  })

  it('idea files an idea_box row and archives the card', () => {
    card('a', 30)
    const result = decideStaleKanbanCard('a', 'idea', OWNER_NAME)
    const idea = listIdeas().find((i) => i.id === result.idea_id)
    expect(idea).toMatchObject({ source: 'kanban-stale', title: 'a' })
    expect(getKanbanCard('a')?.archived_at).not.toBeNull()
  })

  it('close moves to done with the actor and archives', () => {
    card('a', 30)
    decideStaleKanbanCard('a', 'close', OWNER_NAME)
    const events = getKanbanCardEvents('a')
    expect(events.at(-1)).toMatchObject({ to_status: 'done', actor: OWNER_NAME })
    expect(getKanbanCard('a')).toMatchObject({ status: 'done' })
    expect(getKanbanCard('a')?.archived_at).not.toBeNull()
  })

  it('an agent card gets a comment, an owner card does not', () => {
    card('agent', 30)
    card('own', 30, { assignee: OWNER_NAME })
    decideStaleKanbanCard('agent', 'keep', OWNER_NAME)
    decideStaleKanbanCard('own', 'keep', OWNER_NAME)
    expect(getKanbanComments('agent').map((c) => c.content).join('\n')).toContain('[Elavult kártyák átnézése]')
    expect(getKanbanComments('own')).toHaveLength(0)
  })
})

describe('stale routes', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('GET lists and rejects a bad days value', async () => {
    card('a', 30)
    const ok = route('GET', '/api/kanban/stale?days=14')
    await tryHandleKanban(ok.ctx)
    expect(ok.out).toMatchObject({ status: 200, body: { days: 14, count: 1 } })
    for (const days of ['0', 'abc']) {
      const bad = route('GET', `/api/kanban/stale?days=${days}`)
      await tryHandleKanban(bad.ctx)
      expect(bad.out.status).toBe(400)
    }
  })

  it('POST answers 400 / 404 / 409 and 200', async () => {
    card('a', 30)
    const cases: Array<[string, unknown, number]> = [
      ['a', { decision: 'maybe' }, 400],
      ['a', '{not json', 400],
      ['missing', { decision: 'keep' }, 404],
      ['a', { decision: 'close', actor: OWNER_NAME }, 200],
      ['a', { decision: 'keep' }, 409],
    ]
    for (const [id, body, status] of cases) {
      const r = route('POST', `/api/kanban/${id}/stale-decision`, body)
      await tryHandleKanban(r.ctx)
      expect([id, r.out.status]).toEqual([id, status])
    }
  })
})

describe('stale review modal row', () => {
  const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  const a = src.indexOf('function kanbanStaleRowHtml(card)')
  const b = src.indexOf('function renderKanbanStaleModal()', a)
  const ctx: Record<string, unknown> = {}
  vm.createContext(ctx)
  vm.runInContext(
    "function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;') }\n" +
      "function t(key, vars) { return key + (vars ? JSON.stringify(vars) : '') }\n" +
      src.slice(a, b) + '\nglobalThis.row = kanbanStaleRowHtml',
    ctx,
  )
  const row = ctx.row as (c: unknown) => string

  it('escapes the title and renders the three decisions', () => {
    const html = row({ id: 'x1', seq: 7, title: '<img src=x onerror=alert(1)>', status: 'planned', assignee: 'cody', idle_days: 20 })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html.match(/data-decision="(keep|idea|close)"/g)).toEqual([
      'data-decision="keep"', 'data-decision="idea"', 'data-decision="close"',
    ])
  })
})

describe('stale_kept_at migration', () => {
  it('survives the testing-status table rebuild on an old database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-mig-'))
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
      expect(cols).toContain('stale_kept_at')
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
