import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Neutral fixtures -- no internal agent names per persona rule
const MEM_A = {
  id: 1,
  content: 'Memory alpha content for agent-a',
  category: 'warm',
  agent_id: 'agent-a',
  keywords: 'alpha, test',
  created_at: 1000,
  accessed_at: 2000,
}

const MEM_B = {
  id: 2,
  content: 'Memory beta content that is longer than sixty characters so it gets truncated in labels',
  category: 'cold',
  agent_id: 'agent-b',
  keywords: null,
  created_at: 1200,
  accessed_at: 1900,
}

const NEIGHBOR_OUT = {
  id: 2,
  content: MEM_B.content,
  category: 'cold',
  weight: 0.88,
  direction: 'outgoing',
}

const NEIGHBOR_IN = {
  id: 3,
  content: 'Short neighbor label',
  category: 'hot',
  weight: 0.92,
  direction: 'incoming',
}

const VERSION_WARM_TO_COLD = { category: 'cold', changed_at: 1500, changed_by: 'system:maintenance' }
const VERSION_COLD_TO_WARM = { category: 'warm', changed_at: 1800, changed_by: 'system:maintenance' }

const mockDb = { prepare: vi.fn() }

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn(),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  updateMemory: vi.fn().mockReturnValue(true),
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(0),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  getDb: vi.fn(() => mockDb),
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  runMemoryMaintenance: vi.fn().mockResolvedValue({}),
  runLinkMaintenance: vi.fn().mockResolvedValue({}),
  getLinksForMemories: vi.fn().mockReturnValue([]),
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: '0',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function makeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) {
      try { out.body = JSON.parse(b || '{}') } catch { out.body = b }
    },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

// Helper: mock the 4 sequential .prepare() calls for /detail
// 1: base memory (.get), 2: read_count (.get), 3: neighbors (.all), 4: versions (.all)
function mockDetail(mem: any, readCount: number, neighbors: any[], versions: any[]) {
  mockDb.prepare = vi.fn()
    .mockReturnValueOnce({ get: vi.fn().mockReturnValue(mem) })
    .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ cnt: readCount }) })
    .mockReturnValueOnce({ all: vi.fn().mockReturnValue(neighbors) })
    .mockReturnValueOnce({ all: vi.fn().mockReturnValue(versions) })
}

describe('GET /api/memories/:id/detail', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns full detail structure for existing memory', async () => {
    mockDetail(MEM_A, 5, [], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe(1)
    expect(out.body.content).toBe(MEM_A.content)
    expect(out.body.category).toBe('warm')
    expect(out.body.agent_id).toBe('agent-a')
    expect(out.body.keywords).toBe('alpha, test')
    expect(out.body.created_at).toBe(1000)
    expect(out.body.accessed_at).toBe(2000)
    expect(out.body.read_count).toBe(5)
    expect(Array.isArray(out.body.neighbors)).toBe(true)
    expect(Array.isArray(out.body.tier_history)).toBe(true)
  })

  it('returns 404 for non-existent memory', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ get: vi.fn().mockReturnValue(undefined) })
    const { ctx, out } = makeCtx('/api/memories/999/detail')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('Memory not found')
  })

  it('includes neighbors with correct shape', async () => {
    mockDetail(MEM_A, 0, [NEIGHBOR_OUT, NEIGHBOR_IN], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.neighbors).toHaveLength(2)
    const outN = out.body.neighbors.find((n: any) => n.direction === 'outgoing')
    expect(outN).toBeDefined()
    expect(outN.id).toBe(2)
    expect(outN.weight).toBe(0.88)
    expect(outN.tier).toBe('cold')
    const inN = out.body.neighbors.find((n: any) => n.direction === 'incoming')
    expect(inN).toBeDefined()
    expect(inN.id).toBe(3)
    expect(inN.tier).toBe('hot')
  })

  it('truncates neighbor labels longer than 60 chars', async () => {
    mockDetail(MEM_A, 0, [NEIGHBOR_OUT], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    const n = out.body.neighbors[0]
    // MEM_B.content is > 60 chars
    expect(n.label.length).toBeLessThanOrEqual(63)  // 60 + '...'
    expect(n.label).toMatch(/\.\.\.$/)
  })

  it('does not truncate neighbor labels of 60 chars or fewer', async () => {
    mockDetail(MEM_A, 0, [NEIGHBOR_IN], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    const n = out.body.neighbors[0]
    expect(n.label).toBe('Short neighbor label')
    expect(n.label).not.toMatch(/\.\.\.$/)
  })

  it('returns empty neighbors array when no links exist', async () => {
    mockDetail(MEM_A, 0, [], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.neighbors).toHaveLength(0)
  })

  it('returns tier_history with from_tier inferred for first warm->cold entry', async () => {
    mockDetail(MEM_A, 0, [], [VERSION_WARM_TO_COLD])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.tier_history).toHaveLength(1)
    const entry = out.body.tier_history[0]
    expect(entry.to_tier).toBe('cold')
    expect(entry.from_tier).toBe('warm')
    expect(entry.changed_at).toBe(1500)
    expect(entry.changed_by).toBe('system:maintenance')
  })

  it('returns tier_history with from_tier inferred for first cold->warm entry', async () => {
    mockDetail(MEM_B, 0, [], [VERSION_COLD_TO_WARM])
    const { ctx, out } = makeCtx('/api/memories/2/detail')
    await tryHandleMemories(ctx)
    const entry = out.body.tier_history[0]
    expect(entry.to_tier).toBe('warm')
    expect(entry.from_tier).toBe('cold')
  })

  it('derives from_tier from previous row for subsequent tier_history entries', async () => {
    mockDetail(MEM_A, 0, [], [VERSION_WARM_TO_COLD, VERSION_COLD_TO_WARM])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.tier_history).toHaveLength(2)
    const second = out.body.tier_history[1]
    // Second entry's from_tier must match first entry's to_tier (cold)
    expect(second.from_tier).toBe('cold')
    expect(second.to_tier).toBe('warm')
  })

  it('returns empty tier_history when no category_change versions exist', async () => {
    mockDetail(MEM_A, 7, [], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.tier_history).toHaveLength(0)
  })

  it('read_count is 0 when no span_reads exist', async () => {
    mockDetail(MEM_A, 0, [], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    expect(out.body.read_count).toBe(0)
  })

  it('is not matched by GET /api/memories/:id (no false-positive on base route)', async () => {
    // The /detail path must match the detail handler, not the base /:id handler.
    // If detail returns 200 with full shape, the base handler's embedding exclusion is not triggered here.
    mockDetail(MEM_A, 2, [], [])
    const { ctx, out } = makeCtx('/api/memories/1/detail')
    await tryHandleMemories(ctx)
    // Embedding fields must be absent
    expect(out.body.embedding).toBeUndefined()
    expect(out.body.embedding_blob).toBeUndefined()
  })
})
