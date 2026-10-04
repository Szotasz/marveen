/**
 * PR #1357 merged with #1661 (MEMVERSION930) and #1573: the destructive-write
 * guard and the version snapshot of #1357 now share one PATCH path with
 * if_version, prepend and GET /api/memories/:id. Each side's own tests pass on
 * its own; these pin the places where the two meet, which is where a conflict
 * resolution can drop one side without either suite noticing.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory, getMemoryById, getMemoryVersions, getDb } from '../db.js'
import { tryHandleMemories, memoryVersion } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'
import { Readable } from 'node:stream'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'lean-chief', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

async function call(path: string, method: string, body?: unknown, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  let status = 200
  let responseBody = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (b?: string) => { responseBody = b || '' },
  }
  const req = body === undefined
    ? Readable.from([]) as any
    : Readable.from([Buffer.from(JSON.stringify(body))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method, url, auth: { kind: 'token', agent: undefined } }
  await tryHandleMemories(ctx)
  return { status, body: responseBody ? JSON.parse(responseBody) : null }
}

// The same sizes the destructive-write suite uses: a 1900-char warm row is guarded.
const LONG = 'H'.repeat(1900)
const SHORT = 'k'.repeat(60)

beforeEach(() => {
  initDatabase(':memory:')
})

afterAll(() => { vi.restoreAllMocks() })

describe('#1357 guard + #1661 version on one PATCH path', () => {
  it('a prepend on a guarded row lands, returns the new version, and keeps the pre-image', async () => {
    const { id } = saveAgentMemory('leanscout', LONG, 'warm')
    const r = await call(`/api/memories/${id}`, 'PATCH', { prepend: '## 2026-10-03 -- uj fejlec' })
    expect(r.status).toBe(200)
    const row = getMemoryById(id)!
    expect(row.content.startsWith('## 2026-10-03 -- uj fejlec\n')).toBe(true)
    expect(row.content.endsWith(LONG)).toBe(true)
    expect(r.body.version).toBe(memoryVersion(row.content))
    const versions = getMemoryVersions(id)
    expect(versions).toHaveLength(1)
    expect(versions[0].content).toBe(LONG)
  })

  it('a stale if_version wins over the guard: 409 version conflict, nothing written, no pre-image', async () => {
    const { id } = saveAgentMemory('leanscout', LONG, 'warm')
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: SHORT, if_version: 'stale-version-00' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/version conflict/)
    expect(getMemoryById(id)!.content).toBe(LONG)
    expect(getMemoryVersions(id)).toHaveLength(0)
  })

  it('a current if_version does not open the guard: a shrink is still refused as destructive', async () => {
    const { id } = saveAgentMemory('leanscout', LONG, 'warm')
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: SHORT, if_version: memoryVersion(LONG) })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('destructive_memory_write')
    expect(getMemoryById(id)!.content).toBe(LONG)
  })

  it('a confirmed shrink with a current if_version lands, returns the version, keeps the pre-image', async () => {
    const { id } = saveAgentMemory('leanscout', LONG, 'warm')
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: SHORT, if_version: memoryVersion(LONG) }, { confirm_overwrite: '1' })
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(memoryVersion(SHORT))
    expect(getMemoryById(id)!.content).toBe(SHORT)
    expect(getMemoryVersions(id).map((v) => v.content)).toEqual([LONG])
  })

  it('GET by id carries both sides: the version, the length and the full row', async () => {
    const { id } = saveAgentMemory('leanscout', LONG, 'warm')
    const r = await call(`/api/memories/${id}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.version).toBe(memoryVersion(LONG))
    expect(r.body.length).toBe(1900)
    expect(r.body).toHaveProperty('updated_at')
    expect(r.body.content).toBe(LONG)
  })

  it('two snapshotted edits in the same second both land, with a strictly increasing updated_at', async () => {
    const { id } = saveAgentMemory('leanscout', 'elso valtozat', 'cold')
    const a = await call(`/api/memories/${id}`, 'PATCH', { prepend: 'masodik' })
    const stampA = (getDb().prepare('SELECT updated_at FROM memories WHERE id = ?').get(id) as { updated_at: number }).updated_at
    const b = await call(`/api/memories/${id}`, 'PATCH', { prepend: 'harmadik' })
    const stampB = (getDb().prepare('SELECT updated_at FROM memories WHERE id = ?').get(id) as { updated_at: number }).updated_at
    expect([a.status, b.status]).toEqual([200, 200])
    expect(stampB).toBeGreaterThan(stampA)
    expect(getMemoryById(id)!.content).toBe('harmadik\nmasodik\nelso valtozat')
    expect(getMemoryVersions(id)).toHaveLength(2)
  })
})
