// POST /api/kanban must report the id it actually STORED.
//
// The handler generates an id, but callers may supply their own (we use readable
// slugs for long-lived cards). The spread order used to let the supplied id win in
// the stored row while the response echoed the generated one -- so a caller that
// referenced the returned id pointed at a card that does not exist, with HTTP 200.
// Measured 2026-08-31 (sanyiba): response `0b2a8b32`, stored
// `juta-nulla-vegosszegu-bizonylatfej`.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function postCtx(payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL('http://localhost:3420/api/kanban')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

describe('POST /api/kanban -- the reported id is the stored id', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('echoes the CALLER-supplied id, and that id resolves to a real card', async () => {
    const { ctx, out } = postCtx({ id: 'juta-olvashato-slug', title: 'Slug card' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.id).toBe('juta-olvashato-slug')
    // the load-bearing half: the reported id must resolve
    expect(getKanbanCard(out.body.id)?.title).toBe('Slug card')
  })

  it('generates an id when none is supplied, and that id resolves too', async () => {
    const { ctx, out } = postCtx({ title: 'Generated card' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(typeof out.body.id).toBe('string')
    expect(out.body.id.length).toBeGreaterThan(0)
    expect(getKanbanCard(out.body.id)?.title).toBe('Generated card')
  })

  it('ignores a blank supplied id rather than storing an empty key', async () => {
    const { ctx, out } = postCtx({ id: '   ', title: 'Blank id card' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.id.trim()).not.toBe('')
    expect(getKanbanCard(out.body.id)?.title).toBe('Blank id card')
  })
})
