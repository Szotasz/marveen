/**
 * F4 tests: POST /api/memories/links/maintain route and runLinkMaintenance.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockRunLinkMaintenance, mockGetLinksForMemories } = vi.hoisted(() => ({
  mockRunLinkMaintenance: vi.fn(),
  mockGetLinksForMemories: vi.fn(),
}))

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn().mockReturnValue({ id: 1 }),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  updateMemory: vi.fn().mockReturnValue(true),
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(0),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ changes: 0 }),
    }),
  }),
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  runMemoryMaintenance: vi.fn().mockReturnValue({ warmToCold: 0, coldToWarm: 0, prunedVersions: 0 }),
  runLinkMaintenance: mockRunLinkMaintenance,
  getLinksForMemories: mockGetLinksForMemories,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: 'chat-1',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function makeCtx(method: string, path: string, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('POST /api/memories/links/maintain', () => {
  it('calls runLinkMaintenance and returns ok with result', async () => {
    mockRunLinkMaintenance.mockResolvedValueOnce({
      reembedded: 3, linksCreated: 12, linksPruned: 2, orphans: 1,
    })
    const { ctx, out } = makeCtx('POST', '/api/memories/links/maintain')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.reembedded).toBe(3)
    expect(out.body.linksCreated).toBe(12)
    expect(out.body.linksPruned).toBe(2)
    expect(out.body.orphans).toBe(1)
  })

  it('passes weight_threshold from body to runLinkMaintenance', async () => {
    mockRunLinkMaintenance.mockResolvedValueOnce({ reembedded: 0, linksCreated: 0, linksPruned: 5, orphans: 0 })
    const { ctx, out } = makeCtx('POST', '/api/memories/links/maintain', { weight_threshold: 0.2 })
    await tryHandleMemories(ctx)
    expect(mockRunLinkMaintenance).toHaveBeenCalledWith(expect.objectContaining({ weightThreshold: 0.2 }))
    expect(out.body.ok).toBe(true)
  })

  it('returns 500 when runLinkMaintenance throws', async () => {
    mockRunLinkMaintenance.mockRejectedValueOnce(new Error('DB error'))
    const { ctx, out } = makeCtx('POST', '/api/memories/links/maintain')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

describe('GET /api/memories/links', () => {
  it('returns links for ids param', async () => {
    const fakeLinks = [{ id: 1, src_id: 10, dst_id: 20, link_type: 'semantic', weight: 0.9 }]
    mockGetLinksForMemories.mockReturnValueOnce(fakeLinks)
    const { ctx, out } = makeCtx('GET', '/api/memories/links?ids=10,20')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body[0].src_id).toBe(10)
  })

  it('returns empty array for empty ids', async () => {
    mockGetLinksForMemories.mockReturnValueOnce([])
    const { ctx, out } = makeCtx('GET', '/api/memories/links?ids=')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})
