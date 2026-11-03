/**
 * Regression test for the agent-less memory search dropping the `keywords`
 * column (MEMKWSEARCH1018).
 *
 * Root cause, two halves of the same path:
 *   - `searchMemories()` (src/db.ts) matched `f.content MATCH ?`, a
 *     COLUMN-specific fts5 query, so only `content` was searched -- even though
 *     the memories_fts table indexes `content` AND `keywords`;
 *   - the LIKE fallback in `GET /api/memories` (the branch taken when no
 *     `agent=` is given) filtered on `content LIKE ?` alone.
 *
 * The agent-scoped branch had neither problem: it uses the table-level
 * `f.memories_fts MATCH ?` and `(content LIKE ? OR keywords LIKE ?)`.
 *
 * Why it was expensive: a memory that exists and is indexed answered with zero
 * hits, and the response header still said `strict=false; relaxed=false`, which
 * reads as "I searched properly and there is nothing". That is the shape of a
 * false negative that gets believed, and it is worst exactly where it is used
 * most -- an absence claim ("do we have any memory about X?").
 *
 * Fix: parity with the agent-scoped branch, in both halves.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDb, saveAgentMemory } from '../db.js'
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

function makeCtx(path: string, searchParams: Record<string, string> = {}): { ctx: RouteContext; getBody: () => any } {
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v)

  let responseBody = ''
  const res = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: (body?: string) => { responseBody = body || '' },
  }

  return {
    ctx: { req: {} as any, res: res as any, path, method: 'GET', url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

// The term lives ONLY in keywords, never in content, so any hit proves the
// keywords column was searched. A second, content-only term is the positive
// control: it must keep working, otherwise a green keywords test could just
// mean "the search returns everything".
const KEYWORD_ONLY = 'zoldfelulet'
const CONTENT_ONLY = 'hidromechanikai'

beforeAll(() => {
  initDatabase(':memory:')
  saveAgentMemory('agent-a', `A ${CONTENT_ONLY} berendezes adatlapja.`, 'warm', `${KEYWORD_ONLY}, tanusitvany`)
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('memory search covers the keywords column', () => {
  it('the fixture really is keyword-only (apparatus check)', () => {
    // Without this, a passing test below could come from the term leaking into
    // content, which would prove nothing about the keywords column.
    const db = getDb()
    const row = db.prepare('SELECT content, keywords FROM memories LIMIT 1').get() as { content: string; keywords: string }
    expect(row.content).not.toContain(KEYWORD_ONLY)
    expect(row.keywords).toContain(KEYWORD_ONLY)
    // And the fts5 table does index both columns on a fresh database.
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string }
    expect(fts.sql).toContain('keywords')
  })

  it('finds a keyword-only memory WITHOUT ?agent= (the global FTS path)', async () => {
    const { ctx, getBody } = makeCtx('/api/memories', { q: KEYWORD_ONLY })
    await tryHandleMemories(ctx)
    const results = getBody() as any[]
    // Before the fix: 0 results, because `f.content MATCH` skipped keywords and
    // the LIKE fallback filtered on content alone.
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].keywords).toContain(KEYWORD_ONLY)
  })

  it('still finds a content-only term WITHOUT ?agent= (positive control)', async () => {
    const { ctx, getBody } = makeCtx('/api/memories', { q: CONTENT_ONLY })
    await tryHandleMemories(ctx)
    const results = getBody() as any[]
    expect(results.length).toBeGreaterThan(0)
  })

  it('agrees with the agent-scoped branch, which was already correct', async () => {
    const { ctx: global, getBody: globalBody } = makeCtx('/api/memories', { q: KEYWORD_ONLY })
    await tryHandleMemories(global)
    const { ctx: scoped, getBody: scopedBody } = makeCtx('/api/memories', { agent: 'agent-a', q: KEYWORD_ONLY })
    await tryHandleMemories(scoped)
    // The parity IS the fix: the two paths must not disagree about whether a
    // memory exists.
    expect((globalBody() as any[]).map((m: any) => m.id)).toEqual((scopedBody() as any[]).map((m: any) => m.id))
  })

  it('finds a keyword-only memory through the LIKE fallback too', async () => {
    // A partial token: fts5 tokenises on word boundaries, so a fragment cannot
    // match the index and the request falls through to the substring fallback.
    // That fallback is the second half of the bug, and a test that only drives
    // the FTS path would leave it uncovered.
    const fragment = KEYWORD_ONLY.slice(2, 9)
    const db = getDb()
    const ftsHits = db.prepare('SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH ?').all(fragment) as { c: number }[]
    expect(ftsHits[0].c).toBe(0) // the fragment really is invisible to FTS

    const { ctx, getBody } = makeCtx('/api/memories', { q: fragment })
    await tryHandleMemories(ctx)
    const results = getBody() as any[]
    expect(results.length).toBeGreaterThan(0)
  })
})
