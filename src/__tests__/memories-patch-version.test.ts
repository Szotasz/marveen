/**
 * MEMVERSION930: optimistic concurrency and server-side prepend on
 * PATCH /api/memories/:id.
 *
 * The fleet edits shared memories read-modify-write (GET, put a dated header on
 * top, send the whole content back). Two agents doing that within seconds lost
 * one edit silently. `if_version` turns the lost update into a 409 the loser
 * can see; `prepend` removes the read-modify-write for the common case.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { Readable } from 'stream'
import { initDatabase, saveAgentMemory } from '../db.js'
import { tryHandleMemories, memoryVersion } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

async function call(path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    setHeader: () => {},
    end: (b?: string) => { responseBody = b || '' },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method, url }
  await tryHandleMemories(ctx)
  return { status: statusCode, body: responseBody ? JSON.parse(responseBody) : null }
}

let id = 0
beforeAll(() => {
  initDatabase(':memory:')
  id = saveAgentMemory('agent-a', 'original body', 'shared', 'k').id
})
afterAll(() => { vi.restoreAllMocks() })

describe('PATCH /api/memories/:id versioning', () => {
  it('GET returns a version that matches the content', async () => {
    const r = await call(`/api/memories/${id}`, 'GET')
    expect(r.body.version).toBe(memoryVersion('original body'))
  })

  it('a PATCH with the current if_version succeeds and returns the new version', async () => {
    const v = (await call(`/api/memories/${id}`, 'GET')).body.version
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: 'edit one', if_version: v })
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(memoryVersion('edit one'))
  })

  it('a PATCH with a stale if_version is refused with 409 and leaves the row alone', async () => {
    const stale = memoryVersion('original body')
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: 'lost update', if_version: stale })
    expect(r.status).toBe(409)
    expect(r.body.current_version).toBe(memoryVersion('edit one'))
    expect((await call(`/api/memories/${id}`, 'GET')).body.content).toBe('edit one')
  })

  it('prepend puts the text above the CURRENT content, without a read-modify-write', async () => {
    const r1 = await call(`/api/memories/${id}`, 'PATCH', { prepend: '[A] first header' })
    const r2 = await call(`/api/memories/${id}`, 'PATCH', { prepend: '[B] second header\n' })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect((await call(`/api/memories/${id}`, 'GET')).body.content).toBe('[B] second header\n[A] first header\nedit one')
  })

  it('two edits of one row in the same second both land (no "database disk image is malformed")', async () => {
    // Regression: memories_touch fired when the second write's updated_at equalled
    // the first's, and its nested UPDATE broke the FTS index mid-write.
    const a = await call(`/api/memories/${id}`, 'PATCH', { content: 'burst one' })
    const b = await call(`/api/memories/${id}`, 'PATCH', { content: 'burst two' })
    const c = await call(`/api/memories/${id}`, 'PATCH', { prepend: 'burst three' })
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect((await call(`/api/memories/${id}`, 'GET')).body.content).toBe('burst three\nburst two')
  })

  it('refuses content and prepend together', async () => {
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: 'x', prepend: 'y' })
    expect(r.status).toBe(400)
  })

  it('a PATCH without if_version keeps the old last-writer-wins behaviour', async () => {
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: 'plain overwrite' })
    expect(r.status).toBe(200)
    expect((await call(`/api/memories/${id}`, 'GET')).body.content).toBe('plain overwrite')
  })
})
