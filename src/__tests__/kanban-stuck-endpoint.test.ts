// KANBANSTUCKURES916: the stuck-card detector used to filter on
// status='in_progress' alone, which on this board is structurally almost
// always empty (started work sits on 'planned', not 'in_progress'), so it
// reported "0 stuck" every round without measuring anything. getStuckKanbanCards
// replaces that with a real "started, then went idle" signal across all
// non-done statuses (see the WHY comment on it in db.ts). These cases mirror
// the source-spec (KANBANSTUCKURES916/spec.md) 5. fejezet 1-8, plus the
// endpoint's own error path.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getStuckKanbanCards } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)

function insertCard(db: ReturnType<typeof getDb>, opts: {
  id: string
  status?: string
  createdAt: number
  updatedAt: number
  dispatchedAt?: number | null
  archivedAt?: number | null
  assignee?: string | null
}) {
  db.prepare(
    `INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at, dispatched_at, archived_at)
     VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    `card ${opts.id}`,
    opts.status ?? 'planned',
    opts.assignee ?? null,
    opts.createdAt,
    opts.updatedAt,
    opts.dispatchedAt ?? null,
    opts.archivedAt ?? null,
  )
}

function insertComment(db: ReturnType<typeof getDb>, cardId: string, createdAt: number) {
  db.prepare(`INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, 'someone', 'note', ?)`).run(cardId, createdAt)
}

function insertEvent(db: ReturnType<typeof getDb>, cardId: string, toStatus: string, createdAt: number) {
  db.prepare(`INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, 'planned', ?, 'someone', ?)`).run(cardId, toStatus, createdAt)
}

const OPTS = { plannedDays: 7, activeDays: 3, creatorCommentWindowSec: 600 }

beforeEach(() => {
  initDatabase(':memory:')
})

describe('getStuckKanbanCards (KANBANSTUCKURES916 forrás-spec 5. fejezet)', () => {
  it('1. backlog planned, no comment/event, 30 days old -> not examined, not stuck', () => {
    const db = getDb()
    insertCard(db, { id: 'c1', createdAt: now() - 30 * DAY, updatedAt: now() - 30 * DAY })
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(0)
    expect(r.stuck).toHaveLength(0)
  })

  it('2. planned, dispatched_at set, idle 8 days -> stuck', () => {
    const db = getDb()
    insertCard(db, { id: 'c2', createdAt: now() - 20 * DAY, updatedAt: now() - 8 * DAY, dispatchedAt: now() - 8 * DAY })
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(1)
    expect(r.stuck.map((c) => c.id)).toEqual(['c2'])
  })

  it('3. planned, one comment 1 minute after creation, 8 days idle -> not examined (creator comment)', () => {
    const db = getDb()
    const created = now() - 8 * DAY
    insertCard(db, { id: 'c3', createdAt: created, updatedAt: created })
    insertComment(db, 'c3', created + 60)
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(0)
  })

  it('4. planned, comment 2 days after creation, then 8 days of silence -> stuck', () => {
    const db = getDb()
    const created = now() - 10 * DAY
    insertCard(db, { id: 'c4', createdAt: created, updatedAt: created })
    insertComment(db, 'c4', created + 2 * DAY)
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(1)
    expect(r.stuck.map((c) => c.id)).toEqual(['c4'])
  })

  it('5. testing 4 days idle -> stuck; testing 2 days idle -> examined, not stuck', () => {
    const db = getDb()
    insertCard(db, { id: 'c5-stuck', status: 'testing', createdAt: now() - 10 * DAY, updatedAt: now() - 4 * DAY })
    insertCard(db, { id: 'c5-fresh', status: 'testing', createdAt: now() - 10 * DAY, updatedAt: now() - 2 * DAY })
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(2)
    expect(r.stuck.map((c) => c.id)).toEqual(['c5-stuck'])
  })

  it('6. fresh comment on a card with an old updated_at -> not stuck (last_activity is the comment)', () => {
    const db = getDb()
    const created = now() - 20 * DAY
    insertCard(db, { id: 'c6', createdAt: created, updatedAt: created, dispatchedAt: created })
    insertComment(db, 'c6', now() - 1 * DAY)
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(1)
    expect(r.stuck).toHaveLength(0)
  })

  it('7. empty table -> examined: 0, own signal (no crash, no false positives)', () => {
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(0)
    expect(r.stuck).toHaveLength(0)
    expect(r.by_status).toEqual({})
  })

  it('8. archived and done cards are never examined', () => {
    const db = getDb()
    insertCard(db, { id: 'c8-done', status: 'done', createdAt: now() - 30 * DAY, updatedAt: now() - 30 * DAY, dispatchedAt: now() - 30 * DAY })
    insertCard(db, { id: 'c8-archived', status: 'in_progress', createdAt: now() - 30 * DAY, updatedAt: now() - 30 * DAY, archivedAt: now() - 1 * DAY })
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(0)
  })

  it('a card that once left planned (event) but has no other trace is started', () => {
    const db = getDb()
    const created = now() - 10 * DAY
    insertCard(db, { id: 'c9', createdAt: created, updatedAt: created })
    insertEvent(db, 'c9', 'waiting', created + DAY)
    const r = getStuckKanbanCards(OPTS)
    expect(r.examined).toBe(1)
    expect(r.stuck.map((c) => c.id)).toEqual(['c9'])
  })

  it('by_status carries per-status examined/stuck breakdown', () => {
    const db = getDb()
    insertCard(db, { id: 'p1', createdAt: now() - 10 * DAY, updatedAt: now() - 8 * DAY, dispatchedAt: now() - 8 * DAY })
    insertCard(db, { id: 't1', status: 'testing', createdAt: now() - 10 * DAY, updatedAt: now() - 4 * DAY })
    const r = getStuckKanbanCards(OPTS)
    expect(r.by_status.planned).toEqual({ examined: 1, stuck: 1 })
    expect(r.by_status.testing).toEqual({ examined: 1, stuck: 1 })
  })
})

describe('GET /api/kanban/stuck', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an invalid query parameter answers 400, not a silent default', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/stuck?planned_days=abc', 'GET')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('a negative value answers 400 too', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/stuck?active_days=-1', 'GET')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
  })

  it('examined: 0 gets an empty_reason field, not a bare zero', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/stuck', 'GET')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(out.body.examined).toBe(0)
    expect(out.body.empty_reason).toBeTruthy()
  })

  it('defaults to planned_days=7, active_days=3 when no query params are given', async () => {
    const db = getDb()
    insertCard(db, { id: 'd1', createdAt: now() - 10 * DAY, updatedAt: now() - 8 * DAY, dispatchedAt: now() - 8 * DAY })
    const { ctx, out } = fakeCtx('/api/kanban/stuck', 'GET')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(out.body.examined).toBe(1)
    expect(out.body.stuck).toHaveLength(1)
    expect(out.body.empty_reason).toBeUndefined()
  })
})
