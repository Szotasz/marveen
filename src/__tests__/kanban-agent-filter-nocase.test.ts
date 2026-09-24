// Review on PR #1408: the unknown-agent 400 compared the raw `agent=` value case-sensitively
// against {OWNER_NAME, BOT_NAME, ...listAgentNames()}, and the SQL filter was a case-sensitive
// `assignee = ?`. A real install configures capitalised names (BOT_NAME=Marveen,
// OWNER_NAME=Szabolcs) while the board stores lowercase assignees (`marveen`, `szabolcs`), so
// the main bot and the owner could not filter their own board with either spelling, and an
// assignee that exists on the board but is not an agent (an external contributor) could never
// be filtered at all. A genuinely unknown name must still 400.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, BOT_NAME: 'Marveen', OWNER_NAME: 'Szabolcs' }
})

import { initDatabase, createKanbanCard, archiveKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
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

async function get(query: string) {
  const { ctx, out } = getCtx(query)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

describe('GET /api/kanban?agent= -- case-insensitive, and any assignee on the board is filterable', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'bot', title: 'Bot card', assignee: 'marveen' })
    createKanbanCard({ id: 'own', title: 'Owner card', assignee: 'szabolcs' })
    createKanbanCard({ id: 'ext', title: 'External card', assignee: 'mogganhun' })
  })

  it.each(['marveen', 'Marveen', 'MARVEEN'])('capitalised BOT_NAME, lowercase stored assignee: ?agent=%s -> 200 with that card', async (name) => {
    const out = await get(`?agent=${name}`)
    expect(out.status).toBe(200)
    expect(out.body.map((c: any) => c.id)).toEqual(['bot'])
  })

  it.each(['szabolcs', 'Szabolcs'])('capitalised OWNER_NAME, lowercase stored assignee: ?agent=%s -> 200 with that card', async (name) => {
    const out = await get(`?agent=${name}`)
    expect(out.status).toBe(200)
    expect(out.body.map((c: any) => c.id)).toEqual(['own'])
  })

  it('an assignee that exists on the board but is not an agent -> 200 with its card', async () => {
    for (const name of ['mogganhun', 'MogganHun']) {
      const out = await get(`?assignee=${name}`)
      expect(out.status).toBe(200)
      expect(out.body.map((c: any) => c.id)).toEqual(['ext'])
    }
  })

  it('an archived-only assignee still counts as existing on the board', async () => {
    createKanbanCard({ id: 'old', title: 'Old card', assignee: 'regi-kozremukodo' })
    expect(archiveKanbanCard('old')).toBe(true)
    const out = await get('?agent=regi-kozremukodo&includeArchived=1')
    expect(out.status).toBe(200)
    expect(out.body.map((c: any) => c.id)).toEqual(['old'])
  })

  it('a genuinely unknown name still 400s', async () => {
    const out = await get('?agent=nincs-ilyen-agens-xyz')
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('unknown agent')
  })
})
