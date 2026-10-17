// Card 12b0f698: about 79 whole-board reads (18.7 MB) held the dashboard after one night start.
// The board API gains (1) a single-card read on /api/kanban/<id> -- the list's 400 hint had
// pointed callers there while it answered 405 -- and (2) status, ids and fields filters on the
// list. Without a new parameter the list must answer exactly as before.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase, createKanbanCard, moveKanbanCard, archiveKanbanCard, createLabel, addLabelToCard, addCardBlocker,
  listKanbanCards, getLabelsForAllCards, getBlockersForAllCards,
} from '../db.js'
import { tryHandleKanban, KANBAN_STATUS_VALUES } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function get(pathAndQuery: string) {
  const out: { status: number; raw: string; body: any; headers: Record<string, string> } = { status: 0, raw: '', body: null, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = String(v)
      return res
    },
    setHeader() { return res },
    end(chunk?: string | Buffer) {
      if (chunk === undefined) return
      out.raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      try { out.body = JSON.parse(out.raw) } catch { out.body = out.raw }
    },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const ctx = { req, res, path: url.pathname, method: 'GET', url } as RouteContext
  return { ctx, out }
}

async function call(pathAndQuery: string) {
  const { ctx, out } = get(pathAndQuery)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

// The list exactly as the route built it before card 12b0f698: the same query and the same
// element construction, serialized. The no-parameter answer must be these bytes.
function legacyList(opts: { includeArchived?: boolean; agent?: string } = {}): string {
  const labelsByCard = getLabelsForAllCards()
  const blockersByCard = getBlockersForAllCards()
  return JSON.stringify(listKanbanCards({ includeArchived: !!opts.includeArchived, agent: opts.agent }).map((card) => ({
    ...card,
    labels: labelsByCard.get(card.id) ?? [],
    blockers: blockersByCard.get(card.id) ?? [],
  })))
}

function seed() {
  createKanbanCard({ id: 'aaaa0001', title: 'Tervezett', assignee: 'teszt-ugynok', priority: 'high' })
  createKanbanCard({ id: 'aaaa0002', title: 'Folyamatban', assignee: 'teszt-ugynok', description: 'hosszu leiras '.repeat(20) })
  moveKanbanCard('aaaa0002', 'in_progress', 0, 'teszt')
  createKanbanCard({ id: 'aaaa0003', title: 'Var', assignee: 'masik-ugynok' })
  moveKanbanCard('aaaa0003', 'waiting', 0, 'teszt')
  createKanbanCard({ id: 'aaaa0004', title: 'Kesz es archivalt', assignee: 'teszt-ugynok' })
  moveKanbanCard('aaaa0004', 'done', 0, 'teszt')
  archiveKanbanCard('aaaa0004')
  createKanbanCard({ id: 'aaaa0005', title: 'Teszteles alatt', assignee: 'masik-ugynok' })
  moveKanbanCard('aaaa0005', 'testing', 0, 'teszt')
  createLabel({ id: 'lbl1', name: 'keret', color: '#ff0000' })
  addLabelToCard('aaaa0002', 'lbl1')
  addCardBlocker('aaaa0002', 'aaaa0003')
}

describe('GET /api/kanban/<id>: one card in the list shape (card 12b0f698)', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('answers 200 with the very bytes the list gives for that card, labels and blockers included', async () => {
    const one = await call('/api/kanban/aaaa0002')
    expect(one.status).toBe(200)
    const list = await call('/api/kanban')
    const inList = (list.body as any[]).find((c) => c.id === 'aaaa0002')
    expect(one.raw).toBe(JSON.stringify(inList))
    expect(one.body.labels.map((l: any) => l.id)).toEqual(['lbl1'])
    expect(one.body.blockers.map((b: any) => b.id)).toEqual(['aaaa0003'])
    expect(one.body.last_status_at).toBeTypeOf('number')
    expect(one.body.seq).toBeTypeOf('number')
  })

  it('an archived card is readable too, in the includeArchived list shape', async () => {
    const one = await call('/api/kanban/aaaa0004')
    expect(one.status).toBe(200)
    expect(one.body.archived_at).not.toBeNull()
    const list = await call('/api/kanban?includeArchived=1')
    expect(one.raw).toBe(JSON.stringify((list.body as any[]).find((c) => c.id === 'aaaa0004')))
  })

  it('a missing id is 404, and so is a prefix of a real one', async () => {
    expect((await call('/api/kanban/nincs-ilyen')).status).toBe(404)
    const prefix = await call('/api/kanban/aaaa000')
    expect(prefix.status).toBe(404)
    expect(prefix.body.error).toContain('prefix')
  })

  it('fields narrows the card and keeps the id', async () => {
    const one = await call('/api/kanban/aaaa0001?fields=status,priority')
    expect(one.status).toBe(200)
    expect(one.body).toEqual({ id: 'aaaa0001', status: 'planned', priority: 'high' })
  })

  it('any other parameter is a 400 that names the one it takes', async () => {
    const r = await call('/api/kanban/aaaa0001?includeArchived=1')
    expect(r.status).toBe(400)
    expect(r.body.unknown).toEqual(['includeArchived'])
    expect(r.body.known).toEqual(['fields'])
  })

  it('the fixed one-segment paths keep their own handlers (archived, stuck, labels, assignees)', async () => {
    const archived = await call('/api/kanban/archived')
    expect(archived.status).toBe(200)
    expect(Array.isArray(archived.body.cards)).toBe(true)
    const labels = await call('/api/kanban/labels')
    expect(labels.status).toBe(200)
    expect(Array.isArray(labels.body)).toBe(true)
    const assignees = await call('/api/kanban/assignees')
    expect(assignees.status).toBe(200)
  })
})

describe('GET /api/kanban filters: status, ids, fields (card 12b0f698)', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('without a new parameter the answer is byte for byte the old one (plain, includeArchived, agent)', async () => {
    expect((await call('/api/kanban')).raw).toBe(legacyList())
    expect((await call('/api/kanban?includeArchived=1')).raw).toBe(legacyList({ includeArchived: true }))
    expect((await call('/api/kanban?agent=teszt-ugynok')).raw).toBe(legacyList({ agent: 'teszt-ugynok' }))
  })

  it('status takes one value or a comma list, testing included', async () => {
    const one = await call('/api/kanban?status=waiting')
    expect((one.body as any[]).map((c) => c.id)).toEqual(['aaaa0003'])
    const two = await call('/api/kanban?status=planned,in_progress')
    expect((two.body as any[]).map((c) => c.id).sort()).toEqual(['aaaa0001', 'aaaa0002'])
    const testing = await call('/api/kanban?status=testing')
    expect((testing.body as any[]).map((c) => c.id)).toEqual(['aaaa0005'])
    expect([...KANBAN_STATUS_VALUES]).toEqual(['planned', 'in_progress', 'testing', 'waiting', 'done'])
  })

  it('status=done respects includeArchived like every other filter', async () => {
    expect((await call('/api/kanban?status=done')).body).toEqual([])
    const withArchived = await call('/api/kanban?status=done&includeArchived=1')
    expect((withArchived.body as any[]).map((c) => c.id)).toEqual(['aaaa0004'])
  })

  it('an unknown or empty status is a 400 naming the accepted values', async () => {
    const bad = await call('/api/kanban?status=todo')
    expect(bad.status).toBe(400)
    expect(bad.body.invalid).toEqual(['todo'])
    expect(bad.body.accepted).toEqual([...KANBAN_STATUS_VALUES])
    expect((await call('/api/kanban?status=')).status).toBe(400)
  })

  it('ids picks exact ids only; a prefix matches nothing', async () => {
    const r = await call('/api/kanban?ids=aaaa0003,aaaa0001')
    expect((r.body as any[]).map((c) => c.id).sort()).toEqual(['aaaa0001', 'aaaa0003'])
    expect((await call('/api/kanban?ids=aaaa000')).body).toEqual([])
    expect((await call('/api/kanban?ids=')).status).toBe(400)
  })

  it('more than 500 ids is a 400', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `id${i}`).join(',')
    expect((await call(`/api/kanban?ids=${many}`)).status).toBe(400)
  })

  it('fields narrows every row to the named keys plus id, in the row order', async () => {
    const r = await call('/api/kanban?fields=title,status&status=planned')
    expect(r.body).toEqual([{ id: 'aaaa0001', title: 'Tervezett', status: 'planned' }])
    expect(Object.keys(r.body[0])).toEqual(['id', 'title', 'status'])
    const labels = await call('/api/kanban?fields=labels&ids=aaaa0002')
    expect(labels.body).toEqual([{ id: 'aaaa0002', labels: [expect.objectContaining({ id: 'lbl1' })] }])
  })

  it('an unknown or empty field is a 400 that lists the accepted fields', async () => {
    const bad = await call('/api/kanban?fields=title,nincs')
    expect(bad.status).toBe(400)
    expect(bad.body.unknown).toEqual(['nincs'])
    expect(bad.body.accepted).toEqual(expect.arrayContaining(['seq', 'id', 'title', 'status', 'last_status_at', 'labels', 'blockers', 'dispatched_at']))
    expect((await call('/api/kanban?fields=')).status).toBe(400)
  })

  it('the filters combine with agent: assignee + status + fields', async () => {
    const r = await call('/api/kanban?assignee=teszt-ugynok&status=planned,in_progress&fields=status')
    // The list order is sort_order (a move writes it), so compare by id.
    expect([...(r.body as any[])].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'aaaa0001', status: 'planned' },
      { id: 'aaaa0002', status: 'in_progress' },
    ])
  })

  it('an unknown parameter is still a 400, and the error names the whole known set', async () => {
    const r = await call('/api/kanban?limit=10')
    expect(r.status).toBe(400)
    expect(r.body.unknown).toEqual(['limit'])
    expect(r.body.known).toEqual(['agent', 'assignee', 'includeArchived', 'status', 'ids', 'fields'])
  })
})

// The route refuses an empty status= or ids= (400), so the data layer's empty-list branch is
// only reachable from other callers of listKanbanCards: there an empty list must match nothing,
// never fall back to the whole board.
describe('listKanbanCards: an empty filter list matches nothing (card 12b0f698)', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('statuses: [] and ids: [] return no card, while the same calls without them return cards', () => {
    expect(listKanbanCards({ statuses: [] })).toEqual([])
    expect(listKanbanCards({ ids: [] })).toEqual([])
    expect(listKanbanCards({}).length).toBeGreaterThan(0)
    expect(listKanbanCards({ statuses: ['planned'] }).map((c) => c.id)).toEqual(['aaaa0001'])
  })
})
