/**
 * Regression test for the memory search's LIKE fallbacks treating `%` and `_`
 * in the query as wildcards.
 *
 * The substring fallback of GET /api/memories (both the agent-scoped and the
 * global branch) and the FTS-error catch in searchAgentMemories() built their
 * pattern as `%${q}%` with q unescaped. So q=% became `%%%` and q=_ became
 * `%_%`, and every memory with at least one character "matched" as a substring
 * hit -- the opposite of what the fallback promises (the query must appear
 * literally, so a query that matches nothing returns nothing).
 *
 * Fix: escape `\`, `%` and `_` in the query and add `ESCAPE '\'` to the LIKE.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDb, saveAgentMemory, searchAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'agent-a',
    ALLOWED_CHAT_ID: 'test-chat',
    OLLAMA_URL: '',
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

async function search(params: Record<string, string>): Promise<any[]> {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let body = ''
  const res = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: (b?: string) => { body = b || '' },
  }
  const ctx: RouteContext = { req: { headers: {} } as any, res: res as any, path: '/api/memories', method: 'GET', url }
  await tryHandleMemories(ctx)
  return JSON.parse(body)
}

const PERCENT = 'the discount is 20% off'
const BACKSLASH = 'path C:\\temp\\x'

beforeAll(() => {
  initDatabase(':memory:')
  saveAgentMemory('agent-a', 'alpha contract detail', 'warm', 'contract')
  saveAgentMemory('agent-a', 'beta note without wildcards', 'hot', 'note')
  saveAgentMemory('agent-a', PERCENT, 'warm', 'discount')
  saveAgentMemory('agent-a', BACKSLASH, 'cold', 'path')
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('memory search LIKE fallback treats % and _ literally', () => {
  it('agent search: q=_ matches nothing (no memory contains "_")', async () => {
    expect(await search({ agent: 'agent-a', q: '_' })).toEqual([])
  })

  it('agent search: q=% returns only the memory that really contains "%"', async () => {
    const rows = await search({ agent: 'agent-a', q: '%' })
    expect(rows.map(r => r.content)).toEqual([PERCENT])
  })

  it('agent search with a tier: q=% returns only literal hits of that tier', async () => {
    expect(await search({ agent: 'agent-a', q: '%', tier: 'hot' })).toEqual([])
    expect((await search({ agent: 'agent-a', q: '%', tier: 'warm' })).map(r => r.content)).toEqual([PERCENT])
  })

  it('global search: q=_ matches nothing, q=% only the literal hit', async () => {
    expect(await search({ q: '_' })).toEqual([])
    expect((await search({ q: '%' })).map(r => r.content)).toEqual([PERCENT])
  })

  it('a backslash in the query is literal too', async () => {
    expect((await search({ agent: 'agent-a', q: '\\' })).map(r => r.content)).toEqual([BACKSLASH])
  })

  it('a plain substring still matches (positive control)', async () => {
    // "ontrac" is a fragment fts5 cannot match, so this goes through the
    // substring fallback and proves the escaped LIKE still finds real hits.
    expect((await search({ agent: 'agent-a', q: 'ontrac' })).map(r => r.content)).toEqual(['alpha contract detail'])
    expect((await search({ q: 'ontrac' })).map(r => r.content)).toEqual(['alpha contract detail'])
  })

  // Runs last: it drops the fts table to force searchAgentMemories into its
  // LIKE catch branch.
  it('searchAgentMemories FTS-error fallback escapes the query as well', () => {
    getDb().exec('DROP TABLE memories_fts')
    // Apparatus check: with FTS gone, a plain word is still found, so the
    // catch branch is really the one answering.
    expect(searchAgentMemories('agent-a', 'alpha').map(r => r.content)).toEqual(['alpha contract detail'])
    // The query needs a word so it reaches the (failing) FTS statement; a
    // punctuation-only query returns [] before any SQL runs. Unescaped, the
    // `_` here matched the space in "alpha contract".
    expect(searchAgentMemories('agent-a', 'alpha_contract')).toEqual([])
    expect(searchAgentMemories('agent-a', 'alpha_contract', 10, undefined, true, 'warm')).toEqual([])
    expect(searchAgentMemories('agent-a', '20% off').map(r => r.content)).toEqual([PERCENT])
  })
})
