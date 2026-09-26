// POST /api/kanban -- `agent` is accepted as an alias for `assignee`, and any other
// unrecognised key is WARNED (not rejected).
//
// Card b5344b62: createKanbanCard reads named fields off the body, so a key it does not
// recognise (like a caller sending `agent` instead of `assignee`) is silently absent from
// the stored row -- the response is still {ok:true,id}, and the card ends up gazdatlan
// (ownerless). Observed on this install, 2026-09-22: this happened five separate times
// before anyone noticed (c99f3c05, 3f17b3f4, 7abb8d8f, 85eb1c90, b75f9946) -- every such
// caller lost its assignment silently.
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

  // Szotasz's review on #1501, point 4: pin the explicit `assignee: null` case. Today
  // `data.assignee === undefined` correctly leaves an explicit null alone; replacing that
  // with a falsy check (`!data.assignee`) would treat null the same as undefined and apply
  // the alias anyway, silently overriding a caller's deliberate "no owner" -- this test goes
  // red on that specific regression, not just on the alias disappearing entirely.
  it('an explicit `assignee: null` is left alone -- `agent` does not override a deliberate null', async () => {
    const { ctx, out } = postCtx({ title: 'Deliberately unowned', agent: 'newton', assignee: null })
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
      expect.objectContaining({ keys: ['descrpition'] }),
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

  // Szotasz's review on #1501, point 2: `sort_order` and `archived_at` are in
  // KANBAN_WRITABLE_FIELDS (the PUT/update set) but createKanbanCard does not accept
  // either -- it computes its own sort_order and a new card is never pre-archived. Before
  // this fix the known-field set borrowed KANBAN_WRITABLE_FIELDS wholesale, so these two
  // were treated as "known" and silently dropped with no warning.
  it('sort_order and archived_at are warned and dropped, not silently accepted', async () => {
    const { ctx, out } = postCtx({ title: 'Sneaky fields', sort_order: 99, archived_at: 12345 })
    expect(await tryHandleKanban(ctx)).toBe(true)
    const card = getKanbanCard(out.body.id)
    expect(card?.archived_at).toBeNull()
    expect(card?.sort_order).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keys: expect.arrayContaining(['sort_order', 'archived_at']) }),
      expect.any(String),
    )
  })

  // Szotasz's review on #1501, point 3: a non-string `agent` (e.g. an array) fails the
  // `typeof === 'string'` check, so the alias never applies -- but the old code deleted
  // `agent` unconditionally right after, before the unknown-key loop ran, so the bad value
  // vanished with no alias AND no warning. It must now fall through and be warned.
  it('a non-string `agent` is warned as unknown, not silently dropped', async () => {
    const { ctx, out } = postCtx({ title: 'Bad agent type', agent: ['newton'] })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard(out.body.id)?.assignee).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keys: expect.arrayContaining(['agent']) }),
      expect.any(String),
    )
  })

  it('one warn call lists every unknown key, not one call per key', async () => {
    const { ctx } = postCtx({ title: 'Two typos', descrpition: 'oops', statuss: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keys: expect.arrayContaining(['descrpition', 'statuss']) }),
      expect.any(String),
    )
  })
})
