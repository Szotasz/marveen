// A caller has to be able to tell a real recall from a rescued near-miss.
// Measured on a seeded four-row database: "XYZZY-NINCS-ILYEN-KIFEJEZES-2026"
// came back with a row -- not because any invented term matched, but because
// the OR relaxation dropped them and matched the filler words "nincs" and
// "ilyen" sitting in an unrelated memory.
//
// The first instinct was to make the search strict by default. The existing
// suite refused it, and correctly: the relaxation was added for a measured
// failure where a naturally phrased question found nothing while the memory
// existed. Turning it off by default trades a generous answer for a false
// "we have no memory of this" -- the worse of the two.
//
// So the relaxation stays, the strictness becomes something a caller can ASK
// for, and -- the part that was actually missing -- the answer says which one
// it is.
//
// Written against an in-memory database on purpose: probing the live one would
// mean writing rows into the fleet's working memory to observe a read.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, searchAgentMemories, getAgentMemories } from '../db.js'
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
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

const NONSENSE = 'XYZZY-NINCS-ILYEN-KIFEJEZES-2026'

function seed() {
  saveAgentMemory('agent-a', 'A dashboard nincs fent, ilyen esetben a naplo ures', 'warm', 'dashboard, naplo')
  saveAgentMemory('agent-a', 'A kanban kartya statusza waiting lett', 'hot', 'kanban')
  saveAgentMemory('agent-b', 'Az idegen agens sajat bejegyzese, nincs koze hozzank', 'warm', 'idegen')
  saveAgentMemory('agent-b', 'Megosztott tanulsag mindenkinek', 'shared', 'megosztott')
}

describe('a search that matches nothing returns nothing', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('the measure is not vacuous -- the seeded rows are searchable', () => {
    expect(searchAgentMemories('agent-a', 'kanban', 50).length).toBe(1)
  })

  // The load-bearing case. Every invented term in this query matches nothing;
  // only the filler words do, and only after the relaxation drops the rest.
  it('a caller asking for a strict match gets nothing for a nonsense query', () => {
    expect(searchAgentMemories('agent-a', NONSENSE, 50, undefined, false)).toEqual([])
  })

  it('the default stays forgiving, so a naturally phrased question still finds its memory', () => {
    expect(searchAgentMemories('agent-a', NONSENSE, 50).length).toBeGreaterThan(0)
  })

  it('a single-word nonsense query returns no rows either way -- there is nothing to relax', () => {
    expect(searchAgentMemories('agent-a', 'XYZZYQWERTY', 50)).toEqual([])
    expect(searchAgentMemories('agent-a', 'XYZZYQWERTY', 50, undefined, false)).toEqual([])
  })

  it('a genuine phrase still finds its row, and only its row', () => {
    const r = searchAgentMemories('agent-a', 'kanban', 50)
    expect(r.length).toBe(1)
    expect(r[0].content).toContain('kanban')
  })

  // The forgiving behaviour is not deleted, it is asked for. Without this the
  // fix would trade a false positive for a lost feature.
  it('the strict search is available without taking the forgiving one away', () => {
    expect(searchAgentMemories('agent-a', NONSENSE, 50, undefined, true).length).toBeGreaterThan(0)
    expect(searchAgentMemories('agent-a', NONSENSE, 50, undefined, false)).toEqual([])
  })

  it('the caller can tell which of the two ran', () => {
    const trace: { relaxed: boolean } = { relaxed: false }
    searchAgentMemories('agent-a', NONSENSE, 50, trace, true)
    expect(trace.relaxed).toBe(true)
    const strictTrace: { relaxed: boolean } = { relaxed: false }
    searchAgentMemories('agent-a', 'kanban', 50, strictTrace, true)
    expect(strictTrace.relaxed).toBe(false)
  })
})

// The card described this as foreign rows leaking past the owner filter.
// Measured, it is not that: the owner filter is in the SQL, and the row that
// comes back for an unknown agent is a SHARED one, which every agent is meant
// to read. Pinned so the weaker, true statement cannot drift back into the
// stronger, false one.
describe('listing by agent returns own rows plus shared, never another agent private row', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('an unknown agent sees only shared memories', () => {
    const r = getAgentMemories('nincs-ilyen-agent-xyzzy', 50)
    expect(r.every(m => m.category === 'shared')).toBe(true)
  })

  it('a known agent sees its own rows and the shared one, and no private row of the other', () => {
    const r = getAgentMemories('agent-a', 50)
    expect(r.some(m => m.content.includes('kanban'))).toBe(true)
    expect(r.some(m => m.category === 'shared')).toBe(true)
    expect(r.some(m => m.agent_id === 'agent-b' && m.category !== 'shared')).toBe(false)
  })
})

// The endpoint is where the instructions send every agent, so the rule has to
// hold there and not only in the function underneath it.
describe('the endpoint answers nothing when nothing matched', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('the measure is not vacuous -- a genuine query returns its row', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=kanban')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body.length).toBe(1)
  })

  it('strict=1 returns an empty array for a nonsense query', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?agent=agent-a&q=${encodeURIComponent(NONSENSE)}&strict=1`)
    await tryHandleMemories(ctx)
    expect(out.body).toEqual([])
  })

  it('without strict=1 the rescued rows still come back, but labelled', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?agent=agent-a&q=${encodeURIComponent(NONSENSE)}`)
    await tryHandleMemories(ctx)
    expect(out.body.length).toBeGreaterThan(0)
    expect(out.headers['x-memory-search']).toContain('relaxed=true')
  })

  // Without this the caller cannot tell "nothing matched" from "the search was
  // being generous", which is the whole point of the change.
  it('the response says whether the answer is a strict match', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=kanban')
    await tryHandleMemories(ctx)
    expect(out.headers['x-memory-search']).toContain('strict=false')
    expect(out.headers['x-memory-search']).toContain('hits=1')

    const rescued = fakeCtx(`/api/memories?agent=agent-a&q=${encodeURIComponent(NONSENSE)}`)
    await tryHandleMemories(rescued.ctx)
    expect(rescued.out.headers['x-memory-search']).toContain('strict=false')
    expect(rescued.out.headers['x-memory-search']).toContain('relaxed=true')
  })
})
