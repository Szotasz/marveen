/**
 * "the /api/memories PATCH answers silently and acks
 * silently".
 *
 * Measured three times in the fleet (2026-10-02 a sub-agent,
 * 2026-10-08 and 2026-10-09 here): a PATCH body built around a field that does
 * not exist -- {"content_append": "...1000 chars..."} -- returned HTTP 200
 * {"ok":true} and wrote NOTHING. The route destructures the six fields it
 * knows, every other key vanishes, and the partial-update backfill then
 * rewrites the row onto itself. The caller sees exactly what success looks
 * like; only a read-back tells the difference, so what caught it was a RULE in
 * CLAUDE.md, not the system.
 *
 * Two properties are pinned here:
 *   1. a body with no recognised field is a 400 and names the unknown keys, and
 *   2. a real write that also carried unknown keys names them as
 *      ignored_fields; a clean write keeps the { ok, version } shape.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function call(path: string, method: string, payload: unknown): Promise<{ handled: boolean; status: number; body: any }> {
  const req = Readable.from([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))]) as any
  let responseBody = ''
  let status = 200
  const res = {
    writeHead: (code: number) => { status = code },
    end: (body?: string) => { responseBody = body || '' },
    setHeader: () => {},
  }
  const ctx: RouteContext = {
    req, res: res as any, path, method, url: new URL(`http://localhost:3420${path}`),
  }
  return tryHandleMemories(ctx).then((handled) => ({
    handled, status, body: responseBody ? JSON.parse(responseBody) : null,
  }))
}

const patchMemory = (id: number, payload: unknown) => call(`/api/memories/${id}`, 'PATCH', payload)

function contentOf(id: number): string {
  return (getDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }).content
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { vi.restoreAllMocks() })

describe('PATCH /api/memories/:id -- an unrecognised body is not a success', () => {
  it('rejects the measured content_append body with 400 and leaves the row alone', async () => {
    const { id } = saveAgentMemory('agent-a', 'the original text', 'hot', 'kulcs')
    const before = contentOf(id)

    const r = await patchMemory(id, { content_append: 'a block the caller believed it saved' })

    expect(r.status).toBe(400)
    expect(r.body.unknown_fields).toEqual(['content_append'])
    expect(String(r.body.error)).toContain('nothing was written')
    expect(contentOf(id)).toBe(before)
  })

  it('rejects an empty body, which is the same no-op in a quieter costume', async () => {
    const { id } = saveAgentMemory('agent-a', 'untouched', 'warm', '')
    const r = await patchMemory(id, {})
    expect(r.status).toBe(400)
    expect(contentOf(id)).toBe('untouched')
  })

  it('rejects a body that is valid JSON but not an object', async () => {
    const { id } = saveAgentMemory('agent-a', 'untouched too', 'warm', '')
    const r = await patchMemory(id, '"just a string"')
    expect(r.status).toBe(400)
    expect(contentOf(id)).toBe('untouched too')
  })

  it('still performs a real write when one recognised field is present, and reports what changed', async () => {
    const { id } = saveAgentMemory('agent-a', 'short', 'hot', '')
    const r = await patchMemory(id, { content: 'a considerably longer replacement text' })

    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(typeof r.body.version).toBe('string')
    expect(r.body).not.toHaveProperty('ignored_fields')
    expect(contentOf(id)).toBe('a considerably longer replacement text')
  })

  it('a tier-only move still works', async () => {
    const { id } = saveAgentMemory('agent-a', 'tier move subject', 'hot', '')
    const r = await patchMemory(id, { tier: 'cold' })

    expect(r.status).toBe(200)
    expect(contentOf(id)).toBe('tier move subject')
    const row = getDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('an unknown field NEXT TO a real one does not fail the good write -- it is reported as ignored', async () => {
    const { id } = saveAgentMemory('agent-a', 'before', 'hot', '')
    const r = await patchMemory(id, { content: 'after', content_append: 'ignored by the route' })

    expect(r.status).toBe(200)
    expect(r.body.ignored_fields).toEqual(['content_append'])
    expect(contentOf(id)).toBe('after')
  })
})
