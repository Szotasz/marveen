// POST /api/kanban -- `agent` is accepted as an alias for `assignee`, and any other
// unrecognised key is WARNED (not rejected).
//
// Card b5344b62: createKanbanCard reads named fields off the body, so a key it does not
// recognise (like a caller sending `agent` instead of `assignee`) is silently absent from
// the stored row -- the response is still {ok:true,id}, and the card ends up gazdatlan
// (ownerless). Measured against the whole table at the time: zero cards ever carried a
// literal `agent` column value, i.e. every such caller lost its assignment silently.
//
// Same postCtx shape as kanban-create-id-echo.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import { logger } from '../logger.js'

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

describe('POST /api/kanban -- agent -> assignee alias', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a body carrying `agent` (not `assignee`) still gets an owner', async () => {
    const { ctx, out } = postCtx({ title: 'Aliased card', agent: 'newton' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard(out.body.id)?.assignee).toBe('newton')
  })

  it('an explicit `assignee` wins over `agent` when both are sent', async () => {
    const { ctx, out } = postCtx({ title: 'Both fields', agent: 'newton', assignee: 'ada' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard(out.body.id)?.assignee).toBe('ada')
  })

  it('a body with neither field still creates a (gazdatlan) card, unchanged behavior', async () => {
    const { ctx, out } = postCtx({ title: 'No owner at all' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard(out.body.id)?.assignee).toBeNull()
  })
})

describe('POST /api/kanban -- unknown fields are warned, not rejected', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    initDatabase(':memory:')
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  })
  afterEach(() => { warn.mockRestore() })

  it('an unrecognised key logs a WARN naming the key, but the write still succeeds', async () => {
    const { ctx, out } = postCtx({ title: 'Typo field', descrpition: 'oops' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.id)?.title).toBe('Typo field')
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'descrpition' }),
      expect.any(String),
    )
  })

  it('`agent` itself is never warned as unknown -- it is a recognised, handled key', async () => {
    const { ctx } = postCtx({ title: 'Agent only', agent: 'newton' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a fully known body (writable fields + id) logs no warning', async () => {
    const { ctx } = postCtx({ id: 'k1', title: 'Clean card', status: 'planned', assignee: 'newton' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})
