import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockGetCostSummary, mockGetCostSources, mockLoadCostopsConfig } = vi.hoisted(() => ({
  mockGetCostSummary: vi.fn().mockReturnValue({ total: 0, items: [] }),
  mockGetCostSources: vi.fn().mockReturnValue([]),
  mockLoadCostopsConfig: vi.fn().mockReturnValue({
    config: { budgets: [{ name: 'monthly', limit: 100 }] },
    exists: true,
    errors: [],
  }),
}))

vi.mock('../db.js', () => ({ getDb: vi.fn().mockReturnValue({}) }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../costops/config.js', () => ({ loadCostopsConfig: mockLoadCostopsConfig }))
vi.mock('../costops/ledger.js', () => ({
  syncFixedCostsToLedger: vi.fn(),
  getCostSummary: mockGetCostSummary,
  getCostSources: mockGetCostSources,
}))

import { tryHandleCosts } from '../web/routes/costs.js'

function makeCtx(method: string, path: string, params?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  if (params) { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v) }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleCosts', () => {
  it('GET /api/costs/summary returns 200 with summary', async () => {
    const { ctx, out } = makeCtx('GET', '/api/costs/summary')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/costs/summary returns 500 when getCostSummary throws', async () => {
    mockGetCostSummary.mockImplementationOnce(() => { throw new Error('db error') })
    const { ctx, out } = makeCtx('GET', '/api/costs/summary')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toMatch(/summary failed/i)
  })

  it('GET /api/costs/sources returns 200 with sources', async () => {
    const { ctx, out } = makeCtx('GET', '/api/costs/sources')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('GET /api/costs/sources returns 500 when getCostSources throws', async () => {
    mockGetCostSources.mockImplementationOnce(() => { throw new Error('db error') })
    const { ctx, out } = makeCtx('GET', '/api/costs/sources')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toMatch(/sources failed/i)
  })

  it('GET /api/costs/budgets returns 200 with budgets list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/costs/budgets')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body[0].name).toBe('monthly')
  })

  it('GET /api/costs/budgets returns 500 when loadCostopsConfig throws', async () => {
    mockLoadCostopsConfig.mockImplementationOnce(() => { throw new Error('config error') })
    const { ctx, out } = makeCtx('GET', '/api/costs/budgets')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body.error).toMatch(/budgets failed/i)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleCosts(ctx)).toBe(false)
  })
})
