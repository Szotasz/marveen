// #1023: PUT /api/kanban/:id used to accept any JSON body, drop the fields it
// did not recognise, bump updated_at anyway, and answer 200 {ok:true}. Twice a
// real closing note was lost this way (a `description_append` that never
// existed as a column), and because updated_at was fresh the card never looked
// stale. Two guarantees under test:
//   1. an unknown field is rejected with 400 -- and the card is NOT touched;
//   2. a no-op PUT (a known field echoed back unchanged) does not bump
//      updated_at, so the "go look, this is stale" signal survives.
// Plus the load-bearing compatibility claim: the dashboard's whole-`{...card}`
// PUT (assignee/parent edits, carrying id/seq/created_at/labels/blockers) still
// succeeds.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function putCtx(id: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(id)}`)
  return { ctx: { req, res, path: url.pathname, method: 'PUT', url } as RouteContext, out }
}

describe('PUT /api/kanban/:id -- unknown fields are rejected, no-ops do not refresh', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('rejects an unknown field with 400 and does NOT touch the card', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one', status: 'planned' })
    const before = getKanbanCard('c1')!
    // simulate a later real write happening at a later second
    await new Promise((r) => setTimeout(r, 1100))
    const { ctx, out } = putCtx('c1', { status: 'done', description_append: 'result text' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('description_append')
    // the whole write is refused: status did NOT change, updated_at did NOT move
    const after = getKanbanCard('c1')!
    expect(after.status).toBe('planned')
    expect(after.updated_at).toBe(before.updated_at)
  })

  it('a no-op PUT (unchanged known fields) does not bump updated_at', async () => {
    createKanbanCard({ id: 'c2', title: 'Card two', status: 'planned' })
    const before = getKanbanCard('c2')!
    await new Promise((r) => setTimeout(r, 1100))
    const { ctx, out } = putCtx('c2', { status: 'planned', title: 'Card two' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c2')!.updated_at).toBe(before.updated_at)
  })

  it('a real change still writes and bumps updated_at', async () => {
    createKanbanCard({ id: 'c3', title: 'Card three', status: 'planned' })
    const before = getKanbanCard('c3')!
    await new Promise((r) => setTimeout(r, 1100))
    const { ctx, out } = putCtx('c3', { status: 'in_progress' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const after = getKanbanCard('c3')!
    expect(after.status).toBe('in_progress')
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
  })

  it('accepts the dashboard whole-card PUT (read-only fields + embedded arrays)', async () => {
    createKanbanCard({ id: 'c4', title: 'Card four', status: 'planned', assignee: 'samu' })
    const card = getKanbanCard('c4')!
    // shape of web/app.js's { ...card, assignee } send: base columns + seq +
    // last_status_at + the GET-embedded labels/blockers arrays.
    const { ctx, out } = putCtx('c4', {
      ...card,
      seq: 4,
      last_status_at: card.created_at,
      labels: [{ id: 'l1', name: 'x', color: '#fff' }],
      blockers: [],
      assignee: 'zara',
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c4')!.assignee).toBe('zara')
  })
})
