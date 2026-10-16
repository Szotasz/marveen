// MEMKERESVAK917 -- `category` is a filter on the QUERY, not on the answer.
//
// It used to be applied by the route AFTER the search had already cut its
// result to `limit`, so a filtered search silently truncated. Measured on the
// owner store before this change: `q=billingo&category=warm` returned 9 rows at
// limit=50 and 39 at limit=200, while 38 warm rows contain the word. The label
// said `relaxed=false` -- "matched as asked" -- on an answer missing three
// quarters of its matches, which is the same failure #1374/#1380 were about:
// an answer that is not what was asked for, with nothing saying so.
//
// The seed is built so the wanted rows are the ones a post-filter would lose,
// and it took a measurement to build it: the obvious version (four short warm
// rows, thirty short cold ones) put ALL FOUR warm rows in the top five, because
// FTS5 rank favours the shorter document. So the warm rows here are long and
// mention the term once, the cold rows are short and mention it twice, and the
// cold rows win the ranking. Measured on this seed: the top ten of an
// unfiltered search contains zero warm rows, so a post-filter returns nothing
// while four warm rows match.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, searchAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(pathAndQuery: string, method = 'GET') {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = String(v)
      return res
    },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = String(v) },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

const WARM_ROWS = 4
const COLD_ROWS = 30

const PAD = 'egyeb reszletek '.repeat(12)

function seed() {
  for (let i = 0; i < WARM_ROWS; i++) {
    saveAgentMemory('agent-a', `${PAD} billingo ${PAD} ${i}`, 'warm', '')
  }
  for (let i = 0; i < COLD_ROWS; i++) {
    saveAgentMemory('agent-a', `billingo billingo hibanaplo ${i}`, 'cold', 'billingo')
  }
  // A row that must never appear in a billingo search, whatever the category.
  saveAgentMemory('agent-a', 'teljesen mas tema, kanban oszlopok', 'warm', 'kanban')
}

describe('a category search is filtered in the query, not after the limit', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('the measure is not vacuous -- the seed really is dominated by the other tier', () => {
    const unfiltered = searchAgentMemories('agent-a', 'billingo', 10)
    expect(unfiltered.length).toBe(10)
    // This is the truncation, stated as a number: filtering this answer AFTER
    // the fact is what used to happen, and it loses most of the warm rows.
    const postFiltered = unfiltered.filter(m => m.category === 'warm')
    expect(postFiltered).toHaveLength(0)
  })

  it('returns every matching row of the asked-for tier, up to the limit', () => {
    const rows = searchAgentMemories('agent-a', 'billingo', 10, undefined, true, 'warm')
    expect(rows.length).toBe(WARM_ROWS)
    expect(rows.every(m => m.category === 'warm')).toBe(true)
  })

  it('does not widen the search: a row of the right tier that does not match stays out', () => {
    const rows = searchAgentMemories('agent-a', 'billingo', 10, undefined, true, 'warm')
    expect(rows.some(m => m.content.includes('kanban'))).toBe(false)
  })

  // The sharper form of the same property, and the one that survives a
  // mutation: search for a term that exists ONLY in the other tier. The right
  // answer is zero rows. A filter written as OR rather than AND turns this into
  // "every warm row", which the kanban assertion above did NOT catch.
  it('a term that lives only in another tier returns nothing for this tier', () => {
    expect(searchAgentMemories('agent-a', 'hibanaplo', 10, undefined, true, 'warm')).toEqual([])
    // Not vacuous: the term really is there, in the tier that owns it.
    expect(searchAgentMemories('agent-a', 'hibanaplo', 10, undefined, true, 'cold').length).toBeGreaterThan(0)
  })

  it('still honours the limit inside the tier', () => {
    const rows = searchAgentMemories('agent-a', 'billingo', 2, undefined, true, 'warm')
    expect(rows.length).toBe(2)
    expect(rows.every(m => m.category === 'warm')).toBe(true)
  })

  it('an unfiltered search is unchanged', () => {
    expect(searchAgentMemories('agent-a', 'billingo', 10).length).toBe(10)
  })

  it('the endpoint takes the same route: category= is no longer a post-filter', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=billingo&category=warm&limit=10')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body).toHaveLength(WARM_ROWS)
    expect(out.headers['x-memory-search']).toContain(`hits=${WARM_ROWS}`)
    expect(out.headers['x-memory-search']).toContain('relaxed=false')
  })

  it('tier= is the same parameter and behaves the same', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=billingo&tier=warm&limit=10')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body).toHaveLength(WARM_ROWS)
  })

  // The relaxation and the filter are independent: a nonsense query inside a
  // tier must not be rescued into looking like a tier hit.
  it('strict=1 inside a tier still answers empty for a query that matches nothing', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=XYZZY-NINCS-ILYEN-2026&category=warm&strict=1')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(out.body).toHaveLength(0)
    expect(out.headers['x-memory-search']).toContain('relaxed=false')
  })
})
