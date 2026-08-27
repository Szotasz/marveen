import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockRecallByDateRange, mockRecallSearch, mockGetDailyLogDates } = vi.hoisted(() => ({
  mockRecallByDateRange: vi.fn().mockReturnValue({
    logs: [{ id: 1, agent_id: 'jarvis', date: '2026-07-01', content: 'test log', created_at: 1750000000 }],
    memories: [{ id: 1, agent_id: 'jarvis', content: 'test memory', keywords: 'test', category: 'warm', created_at: 1750000000, accessed_at: 1750000001 }],
    dateRange: { from: '2026-07-01', to: '2026-07-01' },
  }),
  mockRecallSearch: vi.fn().mockReturnValue({
    logs: [{ id: 2, agent_id: 'jarvis', date: '2026-07-02', content: 'search result log', created_at: 1750100000 }],
    memories: [],
    dateRange: { from: '2026-07-01', to: '2026-07-02' },
  }),
  mockGetDailyLogDates: vi.fn().mockReturnValue(['2026-07-01', '2026-07-02', '2026-07-03']),
}))

vi.mock('../db.js', () => ({
  recallByDateRange: mockRecallByDateRange,
  recallSearch: mockRecallSearch,
  getDailyLogDates: mockGetDailyLogDates,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  APP_TZ: 'Europe/Budapest',
}))

import { tryHandleRecall } from '../web/routes/recall.js'

function makeCtx(method: string, path: string, params?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || 'null') } catch { out.body = b } },
    setHeader: vi.fn(),
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  if (params) { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v) }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleRecall', () => {
  it('GET /api/recall with q and no date calls recallSearch', async () => {
    const { ctx, out } = makeCtx('GET', '/api/recall', { q: 'integration tests' })
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(mockRecallSearch).toHaveBeenCalledWith('integration tests', undefined, 50)
    expect(out.body.dateRange).toBeDefined()
    expect(Array.isArray(out.body.logs)).toBe(true)
  })

  it('GET /api/recall with q and agent param passes agent to recallSearch', async () => {
    mockRecallSearch.mockClear()
    const { ctx, out } = makeCtx('GET', '/api/recall', { q: 'kanban', agent: 'jarvis' })
    await tryHandleRecall(ctx)
    expect(mockRecallSearch).toHaveBeenCalledWith('kanban', 'jarvis', 50)
  })

  it('GET /api/recall with date calls recallByDateRange', async () => {
    const { ctx, out } = makeCtx('GET', '/api/recall', { date: '2026-07-01' })
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(mockRecallByDateRange).toHaveBeenCalled()
    expect(out.body.summary.logCount).toBe(1)
  })

  it('GET /api/recall with no params uses today as date range', async () => {
    mockRecallByDateRange.mockClear()
    const { ctx, out } = makeCtx('GET', '/api/recall')
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(mockRecallByDateRange).toHaveBeenCalled()
  })

  it('GET /api/recall with invalid date returns 400', async () => {
    const { ctx, out } = makeCtx('GET', '/api/recall', { date: 'not-a-date' })
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.hint).toContain('not-a-date')
  })

  it('GET /api/recall with both date and q filters results', async () => {
    mockRecallByDateRange.mockReturnValueOnce({
      logs: [
        { id: 1, agent_id: 'jarvis', date: '2026-07-01', content: 'matching log content', created_at: 1750000000 },
        { id: 2, agent_id: 'jarvis', date: '2026-07-01', content: 'other log', created_at: 1750000001 },
      ],
      memories: [
        { id: 1, agent_id: 'jarvis', content: 'matching memory', keywords: '', category: 'warm', created_at: 1750000000, accessed_at: 1750000000 },
        { id: 2, agent_id: 'jarvis', content: 'no match memory', keywords: '', category: 'cold', created_at: 1750000000, accessed_at: 1750000000 },
      ],
      dateRange: { from: '2026-07-01', to: '2026-07-01' },
    })
    const { ctx, out } = makeCtx('GET', '/api/recall', { date: '2026-07-01', q: 'matching' })
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.logs.length).toBe(1)
    expect(out.body.memories.length).toBe(1)
  })

  it('GET /api/recall/dates returns date list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/recall/dates')
    expect(await tryHandleRecall(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body).toContain('2026-07-01')
    expect(mockGetDailyLogDates).toHaveBeenCalledWith('marveen', 90)
  })

  it('GET /api/recall/dates respects agent and limit params', async () => {
    mockGetDailyLogDates.mockClear()
    const { ctx, out } = makeCtx('GET', '/api/recall/dates', { agent: 'jarvis', limit: '30' })
    await tryHandleRecall(ctx)
    expect(mockGetDailyLogDates).toHaveBeenCalledWith('jarvis', 30)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleRecall(ctx)).toBe(false)
  })
})
