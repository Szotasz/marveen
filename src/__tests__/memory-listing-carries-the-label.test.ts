// #1374 gave the search branches an `X-Memory-Search` label, because a relaxed
// answer and a real hit are byte-identical in the BODY. The listing branches
// (no `q`) were left without one.
//
// That gap is the same silence in a second place. A caller that reads the
// header cannot tell "this endpoint does not label its answers" from "this
// answer carries no relaxation", because BOTH look like a missing header --
// and the first reading is the one that makes a caller stop trusting the
// label everywhere else. Measured on the live endpoint 2026-09-20:
// `?agent=<no-such-agent>` answered 45 rows with NO header at all, while the
// same listing with a `q=` answered with one.
//
// The listing cannot honestly say `relaxed=false`: there was no query, so
// relaxation never applied, and that wording would imply a match nobody asked
// for. It says `listing=true` instead, plus the one thing a listing can lose
// without a trace -- `truncated`, true when the answer filled `limit` exactly
// and more rows may sit behind the cut.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, clearMemoryCache } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'labeller'

function call(qs: string): { headers: Record<string, string>; body: any } {
  const headers: Record<string, string> = {}
  const out: { body: any } = { body: null }
  const res: any = {
    writeHead() { return res },
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420/api/memories?${qs}`)
  const req: any = Readable.from([])
  req.headers = {}
  void tryHandleMemories({ req, res, path: url.pathname, method: 'GET', url } as RouteContext)
  return { headers, body: out.body }
}

describe('GET /api/memories: every answer carries a label', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    clearMemoryCache()
    for (let i = 0; i < 12; i++) saveAgentMemory(AGENT, `memory ${i}`, 'warm', `kw${i}`)
    clearMemoryCache()
  })

  // Guard the guard: if the search branch ever stopped labelling, the listing
  // assertions below would still pass while the endpoint got QUIETER overall.
  it('still labels a search (the behaviour this extends)', () => {
    const { headers } = call(`agent=${AGENT}&q=memory`)
    expect(headers['x-memory-search']).toMatch(/relaxed=/)
  })

  it('labels an agent listing, and does not claim relaxation it never did', () => {
    const { headers, body } = call(`agent=${AGENT}`)
    const label = headers['x-memory-search']
    expect(label, 'a listing answered with no label at all').toBeTruthy()
    expect(label).toContain('listing=true')
    expect(label).toContain(`hits=${body.length}`)
    // The wording matters, not just the presence: `relaxed=false` here would
    // assert a match against a query that was never sent.
    expect(label).not.toMatch(/relaxed=/)
  })

  it('says truncated=true exactly when the answer filled the limit', () => {
    const cut = call(`agent=${AGENT}&limit=5`)
    expect(cut.body.length).toBe(5)
    expect(cut.headers['x-memory-search']).toContain('truncated=true')

    const whole = call(`agent=${AGENT}&limit=50`)
    expect(whole.body.length).toBeLessThan(50)
    expect(whole.headers['x-memory-search']).toContain('truncated=false')
  })

  it('labels the chat listing too (the branch with no agent and no q)', () => {
    const { headers } = call('limit=50')
    expect(headers['x-memory-search']).toContain('listing=true')
  })
})
