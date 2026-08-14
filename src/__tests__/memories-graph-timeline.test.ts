import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Fixtures use neutral agent-a / agent-b names (no internal identifiers per persona rule)
const NODE_A = { id: 1, content: 'Node A content here', agent_id: 'agent-a', category: 'warm', created_at: 1000, accessed_at: 2000 }
const NODE_B = { id: 2, content: 'Node B content here', agent_id: 'agent-a', category: 'cold', created_at: 1200, accessed_at: 1900 }
const NODE_C = { id: 3, content: 'Node C belongs to agent-b and has a long content string exceeding forty chars', agent_id: 'agent-b', category: 'hot', created_at: 1500, accessed_at: 1800 }

const EDGE_AB = { src_id: 1, dst_id: 2, weight: 0.9, created_at: 1300 }
const EDGE_GHOST = { src_id: 3, dst_id: 99, weight: 0.85, created_at: 1600 }  // dst_id 99 absent

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

function makeCtx(path: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as any
  req.method = 'GET'
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
  const ctx = { req, res, path: url.pathname, method: 'GET', url } as RouteContext
  return { ctx, out }
}

describe('GET /api/memories/graph/timeline', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns nodes, edges, events, time_range structure', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B]) })   // nodes
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([EDGE_AB]) })           // edges
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([{ src_id: 1, degree: 1 }]) }) // degree

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.nodes)).toBe(true)
    expect(Array.isArray(out.body.edges)).toBe(true)
    expect(Array.isArray(out.body.events)).toBe(true)
    expect(out.body.time_range).toBeDefined()
    expect(typeof out.body.time_range.min_ts).toBe('number')
    expect(typeof out.body.time_range.max_ts).toBe('number')
  })

  it('events contain created entries for each node', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    await tryHandleMemories(ctx)
    const createdEvents = out.body.events.filter((e: any) => e.type === 'created')
    expect(createdEvents).toHaveLength(2)
    expect(createdEvents.map((e: any) => e.memory_id).sort()).toEqual([1, 2])
  })

  it('events contain linked entries for each edge', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([EDGE_AB]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    await tryHandleMemories(ctx)
    const linkedEvents = out.body.events.filter((e: any) => e.type === 'linked')
    expect(linkedEvents).toHaveLength(1)
    expect(linkedEvents[0].memory_id).toBe(EDGE_AB.src_id)
    expect(linkedEvents[0].ts).toBe(EDGE_AB.created_at)
  })

  it('events are sorted by ts ascending', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([EDGE_AB]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    await tryHandleMemories(ctx)
    const ts = out.body.events.map((e: any) => e.ts)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })

  it('time_range reflects min/max of node created_at', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B, NODE_C]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    await tryHandleMemories(ctx)
    // NODE_A.created_at=1000, NODE_B=1200, NODE_C=1500
    expect(out.body.time_range.min_ts).toBe(1000)
    expect(out.body.time_range.max_ts).toBe(1500)
  })

  it('edges with dst absent from nodes are filtered out (AND filter)', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_C]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([EDGE_GHOST]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=1400&to=2000')
    await tryHandleMemories(ctx)
    // EDGE_GHOST.dst_id=99 not in node set -> filtered
    expect(out.body.edges).toHaveLength(0)
  })

  it('agent filter is forwarded to node query', async () => {
    const nodeAllMock = vi.fn().mockReturnValue([NODE_A])
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: nodeAllMock })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?agent=agent-a&from=900&to=2000')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    // agent-filtered query receives agent as first arg
    expect(nodeAllMock).toHaveBeenCalledWith('agent-a', expect.any(Number), expect.any(Number))
  })

  it('returns 400 when from > to', async () => {
    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=9999&to=1000')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
  })

  it('returns empty nodes/edges/events when no memories in window', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=1&to=2')
    await tryHandleMemories(ctx)
    expect(out.body.nodes).toHaveLength(0)
    expect(out.body.edges).toHaveLength(0)
    expect(out.body.events).toHaveLength(0)
  })

  it('weight_min defaults to 0.75 and is forwarded to edge query', async () => {
    const edgeAllMock = vi.fn().mockReturnValue([])
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_A, NODE_B]) })
      .mockReturnValueOnce({ all: edgeAllMock })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx } = makeCtx('/api/memories/graph/timeline?from=900&to=2000')
    await tryHandleMemories(ctx)
    const callArgs = edgeAllMock.mock.calls[0]
    expect(callArgs[callArgs.length - 1]).toBe(0.75)
  })

  it('node labels are truncated to 40 chars + ellipsis when longer', async () => {
    mockDb.prepare = vi.fn()
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([NODE_C]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })
      .mockReturnValueOnce({ all: vi.fn().mockReturnValue([]) })

    const { ctx, out } = makeCtx('/api/memories/graph/timeline?from=1400&to=2000')
    await tryHandleMemories(ctx)
    const node = out.body.nodes[0]
    expect(node.label.length).toBeLessThanOrEqual(43)  // 40 + '...'
    expect(node.label).toMatch(/\.\.\.$/)
  })
})
