// Card ca046c9a (#570): nothing moves a hot memory down on its own.
// stale_days=N lists only the rows with no write for N days, and the stats
// count them. (The tier-filter half of the original PR went in as #2035,
// with its own test in memory-tier-listing.test.ts.)
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, saveAgentMemory, getMemoryStats, getAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
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

const DAY = 86400
const HOT_ROWS = 8
const COLD_ROWS = 10 // other-tier rows the stale filter must not pick up

function backdate(id: number, days: number, field: 'created_at' | 'updated_at' = 'created_at') {
  const t = Math.floor(Date.now() / 1000) - days * DAY
  getDb().prepare(`UPDATE memories SET ${field} = ?, accessed_at = ? WHERE id = ?`).run(t, t, id)
}

let hotIds: number[] = []

function seed() {
  hotIds = []
  for (let i = 0; i < HOT_ROWS; i++) {
    const { id } = saveAgentMemory(i % 2 ? 'agent-a' : 'agent-b', `hot ${i}`, 'hot')
    hotIds.push(id)
  }
  // Half the hot rows are 10 days old, half are fresh.
  for (const id of hotIds.slice(0, HOT_ROWS / 2)) backdate(id, 10)
  // One old row that WAS written recently is not stale: the last write counts.
  backdate(hotIds[HOT_ROWS - 1], 30)
  getDb().prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - DAY, hotIds[HOT_ROWS - 1])
  for (let i = 0; i < COLD_ROWS; i++) saveAgentMemory('agent-a', `cold ${i}`, 'cold')
}

describe('stale_days', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('lists only hot rows whose last write is older than N days', async () => {
    const { ctx, out } = fakeCtx('/api/memories?tier=hot&stale_days=7')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body.map((m: any) => m.id).sort()).toEqual(hotIds.slice(0, HOT_ROWS / 2).sort())
  })

  it('works with an agent filter too', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-b&tier=hot&stale_days=7')
    await tryHandleMemories(ctx)
    expect(out.body.length).toBeGreaterThan(0)
    expect(out.body.every((m: any) => m.agent_id === 'agent-b' && m.category === 'hot')).toBe(true)
    const expected = hotIds.slice(0, HOT_ROWS / 2).filter((_, i) => i % 2 === 0)
    expect(out.body.map((m: any) => m.id).sort()).toEqual(expected.sort())
  })

  it('rejects a bad value and the search combination with 400', async () => {
    for (const qs of ['stale_days=0', 'stale_days=-3', 'stale_days=abc', 'stale_days=7&q=hot']) {
      const { ctx, out } = fakeCtx(`/api/memories?tier=hot&${qs}`)
      await tryHandleMemories(ctx)
      expect(out.status, qs).toBe(400)
    }
  })

  it('the stats count the same rows', () => {
    const s = getMemoryStats()
    expect(s.staleHotDays).toBe(7)
    expect(s.staleHot).toBe(HOT_ROWS / 2)
  })

  it('a retracted stale row is neither listed nor counted', async () => {
    getDb().prepare('UPDATE memories SET retracted_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), hotIds[0])
    const { ctx, out } = fakeCtx('/api/memories?tier=hot&stale_days=7')
    await tryHandleMemories(ctx)
    expect(out.body.map((m: any) => m.id)).not.toContain(hotIds[0])
    expect(out.body).toHaveLength(HOT_ROWS / 2 - 1)
    expect(getMemoryStats().staleHot).toBe(HOT_ROWS / 2 - 1)
  })

  // Review of 8552bac0: the staleBefore part of the getAgentMemories cache key
  // had no test. Within the cache TTL, the unfiltered page must not be served
  // as the stale one (or the other way round).
  it('the cache does not serve the unfiltered page as the stale one', () => {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * DAY
    const all = getAgentMemories('agent-b', 50, 'hot', 0)
    const stale = getAgentMemories('agent-b', 50, 'hot', 0, undefined, cutoff)
    const allAgain = getAgentMemories('agent-b', 50, 'hot', 0)
    expect(all).toHaveLength(HOT_ROWS / 2)
    expect(stale.map(m => m.id).sort()).toEqual(hotIds.slice(0, HOT_ROWS / 2).filter((_, i) => i % 2 === 0).sort())
    expect(allAgain).toHaveLength(HOT_ROWS / 2)
  })
})
