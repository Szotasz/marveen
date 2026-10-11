// Stale-card review: open cards that have not changed column for 14+ days go
// in front of the owner, who decides per card with one tap: keep / idea / close.
//
// Three halves:
// - the db contract (listStaleKanbanCards / decideStaleKanbanCard) on an
//   in-memory database;
// - the two routes, driven through tryHandleKanban like kanban-wait-reason;
// - the modal row builder and the modal's decide flow, sliced out of
//   web/app.js and evaluated in a vm.
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
  getKanbanCardEvents, getKanbanComments, listIdeas, archiveKanbanCard, createIdea, moveKanbanCard,
  listStaleKanbanCards, decideStaleKanbanCard, STALE_REVIEW_COMMENT_AUTHOR,
} from '../db.js'
import { OWNER_NAME } from '../config.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY = 86400

function route(method: string, path: string, body?: unknown | string, auth?: RouteContext['auth']) {
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
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
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

  it('excludes done, archived, Folyamatos, Ongoing, both Rád vár spellings and owner cards', () => {
    card('done', 30, { status: 'done' })
    card('arch', 30); archiveKanbanCard('arch')
    card('ongoing', 30); label('ongoing', 'Folyamatos')
    card('ongoing-en', 30); label('ongoing-en', ' Ongoing ')
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

  it('every decision leaves one automated comment naming the decider, on any card', () => {
    card('agent', 30)
    card('own', 30, { assignee: OWNER_NAME })
    card('nobody', 30); getDb().prepare('UPDATE kanban_cards SET assignee = NULL WHERE id = ?').run('nobody')
    decideStaleKanbanCard('agent', 'keep', 'Gabor')
    decideStaleKanbanCard('own', 'idea', 'Gabor')
    decideStaleKanbanCard('nobody', 'close', 'Gabor')
    for (const id of ['agent', 'own', 'nobody']) {
      const comments = getKanbanComments(id)
      expect(comments).toHaveLength(1)
      expect(comments[0]).toMatchObject({ author: 'Gabor', automated: 1 })
      expect(comments[0].content).toContain('[Elavult kártyák átnézése] Gabor döntése:')
    }
  })

  it('with no actor nobody is named: no event actor, a mechanism as comment author, no guessed owner', () => {
    card('a', 30)
    decideStaleKanbanCard('a', 'close')
    expect(getKanbanCardEvents('a').at(-1)).toMatchObject({ to_status: 'done', actor: null })
    const [comment] = getKanbanComments('a')
    expect(comment.author).toBe(STALE_REVIEW_COMMENT_AUTHOR)
    expect(comment.content).toContain('[Elavult kártyák átnézése] Döntés: lezárva')
    expect(comment.content).not.toContain(OWNER_NAME)
  })

  it('refuses a card that is no longer stale: moved since the list, kept, or done', () => {
    card('moved', 30)
    moveKanbanCard('moved', 'in_progress', 0, 'cody')
    card('kept', 30); decideStaleKanbanCard('kept', 'keep', 'Gabor')
    card('done', 30, { status: 'done' })
    card('young', 5)
    for (const id of ['moved', 'kept', 'done', 'young']) {
      expect(() => decideStaleKanbanCard(id, 'close', 'Gabor')).toThrow(expect.objectContaining({ code: 'not_stale' }))
      expect(getKanbanCard(id)?.archived_at).toBeNull()
    }
    expect(getKanbanCard('moved')?.status).toBe('in_progress')
    // The threshold is the caller's: listed with days=3, the 5-day card is stale.
    expect(decideStaleKanbanCard('young', 'keep', 'Gabor', { days: 3 })).toMatchObject({ ok: true })
  })

  it('idea on a card promoted from an idea returns it to THAT idea, with no duplicate', () => {
    card('a', 30)
    createIdea({ id: 'orig', title: 'Original idea', description: 'first text', category: 'Egyéb', scope: 'munka', status: 'kanban', source: 'manual', kanban_id: 'a', impact: null, effort: null })
    const before = listIdeas().length
    const result = decideStaleKanbanCard('a', 'idea', 'Gabor')
    expect(result.idea_id).toBe('orig')
    expect(listIdeas()).toHaveLength(before)
    const idea = listIdeas().find((i) => i.id === 'orig')!
    expect(idea).toMatchObject({ status: 'reviewed', kanban_id: null })
    expect(idea.description).toContain('first text')
    expect(idea.description).toContain('-> Ötletláda, Gabor')
  })

  it('close on a card promoted from an idea releases the idea, like the archive route', () => {
    card('a', 30)
    createIdea({ id: 'orig', title: 'Original idea', description: null, category: 'Egyéb', scope: 'munka', status: 'kanban', source: 'manual', kanban_id: 'a', impact: null, effort: null })
    decideStaleKanbanCard('a', 'close', 'Gabor')
    expect(listIdeas().find((i) => i.id === 'orig')).toMatchObject({ status: 'reviewed', kanban_id: null })
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

  it('POST answers 400 / 404 / 409 and 200, and refuses a bad body before any write', async () => {
    card('a', 30)
    card('fresh', 2)
    const cases: Array<[string, unknown, number]> = [
      ['a', { decision: 'maybe' }, 400],
      ['a', '{not json', 400],
      ['a', 'null', 400],
      ['a', '[]', 400],
      ['a', { decision: 'close', note: 'x' }, 400],
      ['a', { decision: 'close', actor: { name: 'x' } }, 400],
      ['a', { decision: 'close', days: 0 }, 400],
      ['a', { decision: 'close', days: '14' }, 400],
      ['missing', { decision: 'keep' }, 404],
      ['fresh', { decision: 'close' }, 409],
      ['a', { decision: 'close', actor: OWNER_NAME, days: 14 }, 200],
      ['a', { decision: 'keep' }, 409],
    ]
    for (const [id, body, status] of cases) {
      const r = route('POST', `/api/kanban/${id}/stale-decision`, body)
      await tryHandleKanban(r.ctx)
      expect([id, body, r.out.status]).toEqual([id, body, status])
    }
    expect(getKanbanCard('fresh')?.archived_at).toBeNull()
    expect(getKanbanComments('fresh')).toHaveLength(0)
  })

  it('with no actor in the body a browser session names its user, a token caller stays anonymous', async () => {
    card('s', 30); card('t', 30)
    const session = route('POST', '/api/kanban/s/stale-decision', { decision: 'close' }, { kind: 'session', user: 'gabor' } as RouteContext['auth'])
    await tryHandleKanban(session.ctx)
    expect(session.out.status).toBe(200)
    expect(getKanbanCardEvents('s').at(-1)).toMatchObject({ actor: 'gabor' })
    const token = route('POST', '/api/kanban/t/stale-decision', { decision: 'close' }, { kind: 'token' } as RouteContext['auth'])
    await tryHandleKanban(token.ctx)
    expect(token.out.status).toBe(200)
    expect(getKanbanCardEvents('t').at(-1)).toMatchObject({ actor: null })
  })
})

describe('fleet transfer carries stale_kept_at', () => {
  it('the kanban card import names every kanban_cards column, with one value per column', () => {
    initDatabase(':memory:')
    const cols = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('stale_kept_at')
    const src = readFileSync(join(ROOT, 'src', 'web', 'fleet-transfer.ts'), 'utf-8')
    const m = src.match(/INSERT OR IGNORE INTO kanban_cards\s*\(([^)]*)\)\s*VALUES \(([^)]*)\)`\s*\)\.run\(([^)]*(?:\([^)]*\)[^)]*)*)\)/)
    expect(m).not.toBeNull()
    const inserted = m![1].split(',').map((c) => c.trim())
    const placeholders = m![2].split(',').length
    const values = m![3].split(',').filter((v) => v.trim()).length
    // A column missing here drops silently on a move to a new machine.
    expect([...inserted].sort()).toEqual([...cols].sort())
    expect(placeholders).toBe(inserted.length)
    expect(values).toBe(inserted.length)
    expect(m![3]).toContain('c.stale_kept_at')
  })
})

describe('stale review modal row', () => {
  const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  const a = src.indexOf('function kanbanStaleRowHtml(')
  const b = src.indexOf('function renderKanbanStaleModal()', a)
  const ctx: Record<string, unknown> = {}
  vm.createContext(ctx)
  vm.runInContext(
    "function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;') }\n" +
      "function t(key, vars) { return key + (vars ? JSON.stringify(vars) : '') }\n" +
      src.slice(a, b) + '\nglobalThis.row = kanbanStaleRowHtml',
    ctx,
  )
  const row = ctx.row as (c: unknown, pending?: boolean) => string

  it('escapes the title and renders the three decisions', () => {
    const html = row({ id: 'x1', seq: 7, title: '<img src=x onerror=alert(1)>', status: 'planned', assignee: 'cody', idle_days: 20 })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html.match(/data-decision="(keep|idea|close)"/g)).toEqual([
      'data-decision="keep"', 'data-decision="idea"', 'data-decision="close"',
    ])
  })

  it('draws the buttons of a card whose decision is on its way disabled, so a re-render cannot re-arm them', () => {
    const c = { id: 'x1', seq: 7, title: 't', status: 'planned', assignee: 'cody', idle_days: 20 }
    expect(row(c, true).match(/data-decision="\w+" disabled>/g)).toHaveLength(3)
    expect(row(c)).not.toContain('disabled')
  })

  it('draws a decided card disabled, with its outcome', () => {
    const c = { id: 'x1', seq: 7, title: 't', status: 'planned', assignee: 'cody', idle_days: 20 }
    const html = row(c, false, 'kanban.stale.saved')
    expect(html.match(/data-decision="\w+" disabled>/g)).toHaveLength(3)
    expect(html).toContain('kanban-stale-row decided')
    expect(html).toContain('kanban.stale.saved')
  })
})

// The decide flow with a fake list element: innerHTML is parsed into rows of
// buttons, which is all the modal code touches.
describe('stale review modal: a decided card keeps its row', () => {
  const src = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  const a = src.indexOf('// --- kanban stale review ---')
  const b = src.indexOf('function renderKanbanStaleChip()', a)

  type FakeButton = { dataset: { decision: string }; disabled: boolean; click: () => Promise<void> }
  type FakeRow = { id: string; buttons: FakeButton[] }

  function setup(cards: Array<{ id: string; seq: number }>, status = 200) {
    const posts: string[] = []
    let rows: FakeRow[] = []
    const list = {
      set innerHTML(html: string) {
        rows = html.split('<div class="kanban-stale-row').slice(1).map((chunk) => {
          const row: FakeRow = { id: /data-card-id="([^"]*)"/.exec(chunk)![1], buttons: [] }
          for (const m of chunk.matchAll(/data-decision="(\w+)"( disabled)?/g)) {
            const handlers: Array<() => Promise<void>> = []
            const btn = {
              dataset: { decision: m[1] }, disabled: !!m[2],
              addEventListener: (_: string, fn: () => Promise<void>) => { handlers.push(fn) },
              closest: () => ({ dataset: { cardId: row.id }, querySelectorAll: () => row.buttons }),
              // A disabled button gets no click event, as in the browser.
              click: async () => { if (!btn.disabled) for (const h of handlers) await h() },
            }
            row.buttons.push(btn)
          }
          return row
        })
      },
      querySelectorAll: () => rows.flatMap((r) => r.buttons),
    }
    const overlay = {
      className: '', innerHTML: '',
      querySelector: (sel: string) => (sel === '.kanban-stale-list' ? list : { addEventListener: () => {} }),
    }
    const ctx: Record<string, unknown> = {
      document: { createElement: () => overlay, body: { appendChild: () => {} } },
      fetch: async (url: string) => { posts.push(decodeURIComponent(url.split('/api/kanban/')[1].split('/')[0])); return { ok: status === 200, status, json: async () => ({}) } },
      showToast: () => {}, loadKanban: async () => {}, kanbanMoveActor: () => 'Alex',
      openModal: () => {}, closeModal: () => {}, attachOverlayCloseGuard: () => {},
      t: (key: string) => key,
      escapeHtml: (x: unknown) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    }
    vm.createContext(ctx)
    vm.runInContext(src.slice(a, b) + `
      kanbanStaleCards = ${JSON.stringify(cards.map((c) => ({ ...c, title: c.id, status: 'planned', assignee: 'nova', idle_days: 20 })))}
      openKanbanStaleReview()
      globalThis.staleLeft = () => kanbanStaleCards.map((c) => c.id)`, ctx)
    return { posts, rows: () => rows, staleLeft: ctx.staleLeft as () => string[] }
  }

  it('a second tap on the same spot hits the decided row, not the next card', async () => {
    const m = setup([{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }])
    await m.rows()[0].buttons[2].click() // Close on card a
    expect(m.rows().map((r) => r.id)).toEqual(['a', 'b'])
    expect(m.rows()[0].buttons.every((x) => x.disabled)).toBe(true)
    await m.rows()[0].buttons[2].click() // the double tap lands on the same row
    expect(m.posts).toEqual(['a'])
    expect(m.rows()[1].buttons.some((x) => x.disabled)).toBe(false)
    expect(m.staleLeft()).toEqual(['b']) // the chip still counts down
  })

  it('a card that changed meanwhile also stays in place, decided', async () => {
    const m = setup([{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }], 409)
    await m.rows()[0].buttons[0].click()
    expect(m.rows().map((r) => r.id)).toEqual(['a', 'b'])
    expect(m.rows()[0].buttons.every((x) => x.disabled)).toBe(true)
    expect(m.staleLeft()).toEqual(['b'])
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
