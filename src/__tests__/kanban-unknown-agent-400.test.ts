// Fleet review, 09-20: the PR description claimed "an unrecognised agent name now 400s
// naming the accepted set", but the route only ever passed `agent=` straight into the
// `assignee = ?` filter -- an unknown name returned an empty list with 200, same as
// before. This wires the claim up for real: GET /api/kanban now refuses an `agent=`/
// `assignee=` value that names no known agent, instead of silently matching nothing.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { OWNER_NAME, BOT_NAME } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

function getCtx(query: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([])
  const url = new URL(`http://localhost:3420/api/kanban${query}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

describe('GET /api/kanban -- agent= naming no known agent is refused, not silently empty', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an agent name nothing has -> 400, not an empty 200', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one', assignee: 'valaki-mas' })
    const { ctx, out } = getCtx('?agent=nincs-ilyen-agens-xyz')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('unknown agent')
    expect(out.body.agent).toBe('nincs-ilyen-agens-xyz')
  })

  it('the same via the assignee= alias -> 400', async () => {
    const { ctx, out } = getCtx('?assignee=nincs-ilyen-agens-xyz')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('OWNER_NAME and BOT_NAME are accepted (kanban assignees can be owner/bot, not just fleet agents)', async () => {
    createKanbanCard({ id: 'c2', title: 'Owner card', assignee: OWNER_NAME })
    const owner = getCtx(`?agent=${encodeURIComponent(OWNER_NAME)}`)
    expect(await tryHandleKanban(owner.ctx)).toBe(true)
    expect(owner.out.status).toBe(200)

    const bot = getCtx(`?agent=${encodeURIComponent(BOT_NAME)}`)
    expect(await tryHandleKanban(bot.ctx)).toBe(true)
    expect(bot.out.status).toBe(200)
  })

  it('no agent= at all still works (unfiltered board, unchanged behaviour)', async () => {
    createKanbanCard({ id: 'c3', title: 'Unfiltered' })
    const { ctx, out } = getCtx('')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })
})
