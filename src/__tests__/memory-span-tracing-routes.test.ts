import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  updateMemory: vi.fn().mockReturnValue(true),
  runMemoryMaintenance: vi.fn().mockReturnValue({ warmToCold: 2, coldToWarm: 1, prunedVersions: 5 }),
  getDb: vi.fn(),
}))

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn().mockReturnValue({ id: 1 }),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  updateMemory: mocks.updateMemory,
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(0),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: mocks.recordMemoryRead,
  recordMemoryReadBatch: mocks.recordMemoryReadBatch,
  getStaleMemories: mocks.getStaleMemories,
  getMemoryVersions: mocks.getMemoryVersions,
  runMemoryMaintenance: mocks.runMemoryMaintenance,
  getDb: mocks.getDb,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  ALLOWED_CHAT_ID: '123',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function makeCtx(
  method: string,
  path: string,
  body?: object,
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

beforeEach(() => { vi.clearAllMocks() })

// ── POST /api/memories/read-event ──────────────────────────────────────────

describe('POST /api/memories/read-event', () => {
  it('records a single read event and returns ok', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/read-event', {
      agent_id: 'agent-a', memory_id: 7, context: 'heartbeat',
    })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    expect(mocks.recordMemoryRead).toHaveBeenCalledWith('agent-a', 7, 'heartbeat')
  })

  it('defaults unknown context to direct', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/read-event', {
      agent_id: 'agent-a', memory_id: 8, context: 'unknown-ctx',
    })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(mocks.recordMemoryRead).toHaveBeenCalledWith('agent-a', 8, 'direct')
  })

  it('returns 400 when agent_id missing (single mode)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/read-event', { memory_id: 9 })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
  })

  it('returns 400 when memory_id missing (single mode)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/read-event', { agent_id: 'agent-a' })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
  })

  it('batch mode: records multiple reads and returns count', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/read-event', {
      reads: [
        { agent_id: 'agent-a', memory_id: 1, context: 'heartbeat' },
        { agent_id: 'agent-a', memory_id: 2, context: 'heartbeat' },
        { agent_id: 'agent-b', memory_id: 3, context: 'direct' },
      ],
    })
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    expect((out.body as any).recorded).toBe(3)
    expect(mocks.recordMemoryReadBatch).toHaveBeenCalled()
  })
})

// ── GET /api/memories/stale ────────────────────────────────────────────────

describe('GET /api/memories/stale', () => {
  it('returns stale list for agent', async () => {
    mocks.getStaleMemories.mockReturnValue([
      { id: 1, content: 'stale', category: 'warm', agent_id: 'agent-a', embedding: null },
    ])
    const { ctx, out } = makeCtx('GET', '/api/memories/stale?agent_id=agent-a')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(mocks.getStaleMemories).toHaveBeenCalledWith('agent-a')
    const body = out.body as any[]
    expect(body).toHaveLength(1)
    expect(body[0].content).toBe('stale')
    expect(body[0].embedding).toBeUndefined()
  })

  it('accepts agent query param as alias', async () => {
    mocks.getStaleMemories.mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/memories/stale?agent=agent-b')
    await tryHandleMemories(ctx)
    expect(mocks.getStaleMemories).toHaveBeenCalledWith('agent-b')
    expect(out.status).toBe(200)
  })

  it('returns 400 when no agent_id given', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories/stale')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
  })
})

// ── GET /api/memories/:id/versions ────────────────────────────────────────

describe('GET /api/memories/:id/versions', () => {
  it('returns version history for the memory', async () => {
    mocks.getMemoryVersions.mockReturnValue([
      { id: 1, memory_id: 42, content: 'old', category: 'warm', changed_at: 1000, changed_by: 'agent-a', change_type: 'update' },
    ])
    const { ctx, out } = makeCtx('GET', '/api/memories/42/versions')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(mocks.getMemoryVersions).toHaveBeenCalledWith(42)
    expect((out.body as any[])[0].content).toBe('old')
  })

  it('returns empty array when no versions exist', async () => {
    mocks.getMemoryVersions.mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/memories/99/versions')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})

// ── GET /api/memories/:id ─────────────────────────────────────────────────

describe('GET /api/memories/:id', () => {
  it('returns memory without embedding', async () => {
    mocks.getDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({
          id: 5, content: 'hello', category: 'warm', agent_id: 'agent-a', embedding: 'BLOB',
        }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn().mockReturnValue({ changes: 0 }),
      }),
    })
    const { ctx, out } = makeCtx('GET', '/api/memories/5')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as any).content).toBe('hello')
    expect((out.body as any).embedding).toBeUndefined()
  })

  it('returns 404 for unknown id', async () => {
    mocks.getDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn().mockReturnValue({ changes: 0 }),
      }),
    })
    const { ctx, out } = makeCtx('GET', '/api/memories/9999')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('includes versions when ?include=versions', async () => {
    mocks.getDb.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(
          { id: 10, content: 'mem', category: 'warm', agent_id: 'agent-a', embedding: null }
        ),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn().mockReturnValue({ changes: 0 }),
      }),
    })
    mocks.getMemoryVersions.mockReturnValue([
      { id: 1, memory_id: 10, content: 'old', category: 'warm', changed_at: 999, changed_by: 'agent-a', change_type: 'update' },
    ])
    const { ctx, out } = makeCtx('GET', '/api/memories/10?include=versions&agent_id=agent-a')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect((out.body as any).versions).toHaveLength(1)
    expect(mocks.recordMemoryRead).toHaveBeenCalledWith('agent-a', 10, 'direct')
  })
})

// ── POST /api/memories/resort ─────────────────────────────────────────────

describe('POST /api/memories/resort', () => {
  it('calls runMemoryMaintenance and returns stats', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/resort', {})
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as any).ok).toBe(true)
    expect((out.body as any).warmToCold).toBe(2)
    expect((out.body as any).coldToWarm).toBe(1)
    expect((out.body as any).prunedVersions).toBe(5)
    expect(mocks.runMemoryMaintenance).toHaveBeenCalled()
  })

  it('passes custom thresholds to runMemoryMaintenance', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/resort', {
      warm_to_cold_days: 14,
      cold_to_warm_hours: 48,
      min_agents: 3,
      version_ttl_days: 90,
    })
    await tryHandleMemories(ctx)
    expect(mocks.runMemoryMaintenance).toHaveBeenCalledWith({
      warmToColdDays: 14,
      coldToWarmHours: 48,
      minAgents: 3,
      versionTtlDays: 90,
    })
  })

  it('accepts empty body (uses defaults)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/memories/resort')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })
})
