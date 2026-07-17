/**
 * Regression test for GET /api/memories agent_id alias bug.
 *
 * Root cause: the GET handler only read `?agent=`, so callers using `?agent_id=`
 * (which matches the POST body field name) got the global `searchMemories()` path
 * instead — silently returning every agent's memories. Zero error, wrong data.
 *
 * Fix: accept `agent_id` as a deprecated alias for `agent` in GET query params.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory } from '../db.js'
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
    end: (body?: string) => { responseBody = body || '' },
  }

  return {
    ctx: { req: {} as any, res: res as any, path, method: 'GET', url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

beforeAll(() => {
  initDatabase(':memory:')
  // agent-a memory -- canonical owner
  saveAgentMemory('agent-a', 'alpha contract detail', 'warm', 'contract')
  // agent-b memory with overlapping keyword -- without the fix, the global search
  // would return this row too, causing the same-results test to diverge.
  saveAgentMemory('agent-b', 'alpha data owned by b', 'warm', 'contract')
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('GET /api/memories agent_id alias', () => {
  it('?agent_id= returns same results as ?agent= for a keyword search', async () => {
    const { ctx: ctxAgent, getBody: getBodyAgent } = makeCtx('/api/memories', { agent: 'agent-a', q: 'alpha' })
    await tryHandleMemories(ctxAgent)
    const byAgent = getBodyAgent() as any[]

    const { ctx: ctxAlias, getBody: getBodyAlias } = makeCtx('/api/memories', { agent_id: 'agent-a', q: 'alpha' })
    await tryHandleMemories(ctxAlias)
    const byAlias = getBodyAlias() as any[]

    expect(byAlias.length).toBeGreaterThan(0)
    expect(byAlias.map((m: any) => m.id).sort()).toEqual(byAgent.map((m: any) => m.id).sort())
  })

  it('?agent_id=agent-a does NOT return agent-b memories', async () => {
    // Both agents have 'alpha' content, so the global path would return both.
    const { ctx, getBody } = makeCtx('/api/memories', { agent_id: 'agent-a', q: 'alpha' })
    await tryHandleMemories(ctx)
    const results = getBody() as any[]
    // Without the fix, the handler falls through to global searchMemories() and
    // agent-b's 'alpha data owned by b' row leaks in.
    const agentBLeaked = results.some((m: any) => m.agent_id === 'agent-b')
    expect(agentBLeaked).toBe(false)
  })

  it('?agent_id= without q lists only that agent memories', async () => {
    const { ctx, getBody } = makeCtx('/api/memories', { agent_id: 'agent-a' })
    await tryHandleMemories(ctx)
    const results = getBody() as any[]
    expect(results.length).toBeGreaterThan(0)
    for (const m of results) {
      expect(m.agent_id).toBe('agent-a')
    }
  })
})
