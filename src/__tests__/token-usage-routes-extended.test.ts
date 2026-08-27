import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/token-usage.js', () => ({
  collectTokenUsage: vi.fn().mockResolvedValue({ collected: 5, agents: ['marveen'] }),
  getTokenSummary: vi.fn().mockReturnValue({ total: 100, byAgent: {} }),
  getTokenTimeline: vi.fn().mockReturnValue([]),
  getTokenDetails: vi.fn().mockReturnValue({ rows: [], total: 0 }),
  getModelDistribution: vi.fn().mockReturnValue({ models: [] }),
  getToolStats: vi.fn().mockReturnValue({ tools: [] }),
  correlateWithKanban: vi.fn(),
}))

vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...actual, jsonMaybeGzip: vi.fn().mockImplementation((_req: unknown, res: any, data: unknown) => {
    res.writeHead(200)
    res.end(JSON.stringify(data))
  }) }
})

vi.mock('../../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { tryHandleTokenUsage } from '../web/routes/token-usage.js'

function makeCtx(method: string, path: string, params: Record<string, string> = {}): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const em = new EventEmitter() as any
  em.method = method
  em.headers = {}
  setImmediate(() => { em.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead: (s: number) => { out.status = s },
    end: (b?: string) => { try { out.body = JSON.parse(b ?? 'null') } catch { out.body = b } },
    setHeader: vi.fn(),
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { ctx: { req: em, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleTokenUsage -- extended coverage', () => {
  it('POST /api/token-usage/collect returns 200 on success', async () => {
    const { ctx, out } = makeCtx('POST', '/api/token-usage/collect')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.collected).toBe(5)
  })

  it('POST /api/token-usage/collect returns 500 on failure', async () => {
    const { collectTokenUsage } = await import('../web/token-usage.js')
    vi.mocked(collectTokenUsage).mockRejectedValueOnce(new Error('DB error'))
    const { ctx, out } = makeCtx('POST', '/api/token-usage/collect')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    expect(out.body.hint).toContain('Collection')
  })

  it('GET /api/token-usage/model-dist returns 200', async () => {
    const { ctx, out } = makeCtx('GET', '/api/token-usage/model-dist')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/token-usage/model-dist passes from/to/agent params', async () => {
    const { getModelDistribution } = await import('../web/token-usage.js')
    const { ctx } = makeCtx('GET', '/api/token-usage/model-dist', { from: '1000', to: '2000', agent: 'rick' })
    await tryHandleTokenUsage(ctx)
    expect(getModelDistribution).toHaveBeenCalledWith(1000, 2000, 'rick')
  })

  it('GET /api/token-usage/tool-stats returns 200', async () => {
    const { ctx, out } = makeCtx('GET', '/api/token-usage/tool-stats')
    expect(await tryHandleTokenUsage(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/token-usage/tool-stats passes params', async () => {
    const { getToolStats } = await import('../web/token-usage.js')
    const { ctx } = makeCtx('GET', '/api/token-usage/tool-stats', { from: '500', to: '1500', agent: 'dave' })
    await tryHandleTokenUsage(ctx)
    expect(getToolStats).toHaveBeenCalledWith(500, 1500, 'dave')
  })

  it('returns false for unknown route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleTokenUsage(ctx)).toBe(false)
  })
})
