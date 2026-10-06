// PUT /api/kanban/:id -- a parent_id that would close a loop, or points at a
// card that does not exist, is refused before updateKanbanCard ever runs.
// Same shape as kanban-put-unknown-field.test.ts's putCtx helper.
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

describe('PUT /api/kanban/:id -- parent_id cycle guard', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('rejects a card set as its own parent, with 409, and does NOT touch the card', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one' })
    const before = getKanbanCard('c1')!
    const { ctx, out } = putCtx('c1', { parent_id: 'c1' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('c1')!.parent_id).toBe(before.parent_id)
  })

  it('rejects a re-parent that would close a transitive loop, with 409', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one' })
    createKanbanCard({ id: 'c2', title: 'Card two', parent_id: 'c1' })
    // c1 already lives under c2's subtree via c2 -> c1; asking c1 to adopt c2
    // as its parent would close the loop.
    const { ctx, out } = putCtx('c1', { parent_id: 'c2' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('c1')!.parent_id).toBeNull()
  })

  it('rejects a parent_id pointing at a card that does not exist, with 404', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one' })
    const { ctx, out } = putCtx('c1', { parent_id: 'no-such-card' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(getKanbanCard('c1')!.parent_id).toBeNull()
  })

  it('allows a plain re-parent onto an unrelated existing card', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one' })
    createKanbanCard({ id: 'c2', title: 'Card two' })
    const { ctx, out } = putCtx('c2', { parent_id: 'c1' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c2')!.parent_id).toBe('c1')
  })

  it('clearing the parent (null) needs no cycle check', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one' })
    createKanbanCard({ id: 'c2', title: 'Card two', parent_id: 'c1' })
    const { ctx, out } = putCtx('c2', { parent_id: null })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c2')!.parent_id).toBeNull()
  })
})
