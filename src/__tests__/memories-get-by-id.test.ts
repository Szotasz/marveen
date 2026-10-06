/**
 * Contract test for GET /api/memories/:id.
 *
 * Until 2026-09-14 the id-addressed routes were PUT/PATCH/DELETE only: a memory
 * could be referenced by id, edited by id and deleted by id, but never READ by
 * id. The shared tier is full of such pointers ("see shared <id>"), and the only
 * way to follow one was keyword search -- which silently fails when the keywords
 * do not match.
 *
 * A sub-agent hit exactly that and read the 404 as "the record does not exist",
 * when what did not exist was the route. An absent route and an absent row must
 * not look alike, so both cases are pinned here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(path: string, method = 'GET'): { ctx: RouteContext; getBody: () => any; status: () => number } {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (body?: string) => { responseBody = body || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method, url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

let seededId = 0

beforeAll(() => {
  initDatabase(':memory:')
  seededId = saveAgentMemory('agent-a', 'a pointer target the keyword search would miss', 'shared', 'zzz-unrelated').id
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/memories/:id', () => {
  it('returns the row for an existing id, without needing a matching keyword', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories/${seededId}`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.id).toBe(seededId)
    expect(body.agent_id).toBe('agent-a')
    expect(body.category).toBe('shared')
    expect(body.content).toContain('pointer target')
  })

  it('404s for an id that does not exist -- distinct from the route being absent', async () => {
    const { ctx, status } = makeCtx('/api/memories/99999999')
    const handled = await tryHandleMemories(ctx)
    // handled=true is the point: the ROUTE exists and answers. Before the fix
    // this returned false and the caller saw a generic "Not found" from the
    // router, which is indistinguishable from a missing record.
    expect(handled).toBe(true)
    expect(status()).toBe(404)
  })
})
