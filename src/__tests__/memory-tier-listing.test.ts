// With no agent filter, the dashboard tier tab used to filter AFTER the
// 50-row limit had already cut the list. Measured 2026-10-17 on the owner
// store: the Hot tab showed 6 of 115 hot memories (warm 18/365, cold 16/703).
// The tier now goes into the query, so the tab shows the tier's own rows.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getMemoriesForChat } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { ALLOWED_CHAT_ID } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(pathAndQuery: string, method = 'GET') {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() {},
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

const HOT_ROWS = 8
const COLD_ROWS = 60 // more than the 50-row page, all accessed more recently

function seed() {
  for (let i = 0; i < HOT_ROWS; i++) saveAgentMemory(i % 2 ? 'agent-a' : 'agent-b', `hot ${i}`, 'hot')
  for (let i = 0; i < COLD_ROWS; i++) saveAgentMemory('agent-a', `cold ${i}`, 'cold')
}

describe('tier listing without an agent filter', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('the seed is not vacuous: an unfiltered first page holds no hot row', () => {
    const page = getMemoriesForChat(ALLOWED_CHAT_ID, 50)
    expect(page.filter(m => m.category === 'hot')).toHaveLength(0)
  })

  it('returns every hot row on the Hot tab', async () => {
    const { ctx, out } = fakeCtx('/api/memories?tier=hot&limit=50')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body).toHaveLength(HOT_ROWS)
    expect(out.body.every((m: any) => m.category === 'hot')).toBe(true)
  })

  it('still honours the limit inside the tier', async () => {
    const { ctx, out } = fakeCtx('/api/memories?tier=cold&limit=50')
    await tryHandleMemories(ctx)
    expect(out.body).toHaveLength(50)
    expect(out.body.every((m: any) => m.category === 'cold')).toBe(true)
  })
})
