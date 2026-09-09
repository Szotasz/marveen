// #947: GET /api/memories ignored `offset`, so an install with >200 memories
// served the same first page on every request -- silently truncated, no total,
// no hasMore, no error. A paging loop over it never terminated and over-counted
// (measured: 2200 counted for 353 real). These tests pin the fix:
//   1. paging with offset is exhaustive and non-repeating;
//   2. the memory cache key includes offset (page 2 is not page 1's cache);
//   3. paging stays exhaustive when every row shares one accessed_at second
//      (the id DESC tie-break), the shape a bulk import produces;
//   4. category listings paginate too;
//   5. offset combined with a search query (q) is rejected, not dropped.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase, saveAgentMemory, getAgentMemories, getDb, clearMemoryCache,
} from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'pager'

function seed(n: number, opts: { sameSecond?: boolean; category?: string } = {}): void {
  const db = getDb()
  const base = 1_700_000_000
  for (let i = 0; i < n; i++) {
    const { id } = saveAgentMemory(AGENT, `memory ${i}`, opts.category ?? 'warm', `kw${i}`)
    // control accessed_at precisely: distinct-descending by default, or one
    // shared second to exercise the tie-break.
    const accessed = opts.sameSecond ? base : base + i
    db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(accessed, id)
  }
  clearMemoryCache()
}

function getCtx(qs: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420/api/memories?${qs}`)
  const req: any = Readable.from([])
  req.headers = {}
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

describe('#947: GET /api/memories offset paging', () => {
  beforeEach(() => { initDatabase(':memory:'); clearMemoryCache() })

  it('pages exhaustively and never repeats a row (distinct accessed_at)', () => {
    seed(250)
    const seen = new Set<number>()
    let offset = 0
    let pages = 0
    for (;;) {
      const page = getAgentMemories(AGENT, 100, undefined, offset)
      if (page.length === 0) break
      for (const m of page) {
        expect(seen.has(m.id), `row ${m.id} returned twice`).toBe(false)
        seen.add(m.id)
      }
      offset += 100
      if (++pages > 10) throw new Error('paging did not terminate')
    }
    expect(seen.size).toBe(250)
  })

  it('the cache key includes offset -- page 2 is not served page 1 rows', () => {
    seed(250)
    const p1 = getAgentMemories(AGENT, 100, undefined, 0)   // populates cache
    const p2 = getAgentMemories(AGENT, 100, undefined, 100) // must NOT hit p1's cache
    expect(p1[0].id).not.toBe(p2[0].id)
    expect(new Set([...p1, ...p2].map(m => m.id)).size).toBe(200)
  })

  it('stays exhaustive when every row shares one accessed_at second', () => {
    seed(250, { sameSecond: true })
    const seen = new Set<number>()
    for (let offset = 0; offset < 250; offset += 50) {
      for (const m of getAgentMemories(AGENT, 50, undefined, offset)) {
        expect(seen.has(m.id), `row ${m.id} repeated across a tied page`).toBe(false)
        seen.add(m.id)
      }
    }
    expect(seen.size).toBe(250)
  })

  it('category listings paginate too', () => {
    seed(120, { category: 'cold' })
    const p1 = getAgentMemories(AGENT, 50, 'cold', 0)
    const p2 = getAgentMemories(AGENT, 50, 'cold', 50)
    const p3 = getAgentMemories(AGENT, 50, 'cold', 100)
    const ids = new Set([...p1, ...p2, ...p3].map(m => m.id))
    expect(p1.length).toBe(50)
    expect(p3.length).toBe(20)
    expect(ids.size).toBe(120)
  })

  it('rejects offset combined with q (400), rather than dropping it', async () => {
    seed(10)
    const { ctx, out } = getCtx('agent=pager&q=memory&offset=5')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(String(out.body.error)).toContain('offset')
  })

  it('the HTTP listing honours offset end to end', async () => {
    seed(250)
    const p1 = getCtx('agent=pager&limit=100&offset=0')
    const p2 = getCtx('agent=pager&limit=100&offset=100')
    await tryHandleMemories(p1.ctx)
    await tryHandleMemories(p2.ctx)
    expect(Array.isArray(p1.out.body)).toBe(true)
    expect(p1.out.body[0].id).not.toBe(p2.out.body[0].id)
  })
})
