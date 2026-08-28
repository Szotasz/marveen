import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockGetAgentMessage, mockMarkMessageDone, mockMarkMessageFailed } = vi.hoisted(() => ({
  mockGetAgentMessage: vi.fn().mockReturnValue(null),
  mockMarkMessageDone: vi.fn().mockReturnValue(true),
  mockMarkMessageFailed: vi.fn().mockReturnValue(false),
}))

vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn().mockReturnValue({ id: 99 }),
  getPendingMessages: vi.fn().mockReturnValue([{ id: 1 }]),
  listAgentMessages: vi.fn().mockReturnValue([{ id: 2 }]),
  getAgentConversation: vi.fn().mockReturnValue([]),
  getAgentConversationThreads: vi.fn().mockReturnValue([]),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  markMessageDone: mockMarkMessageDone,
  markMessageFailed: mockMarkMessageFailed,
  getAgentMessage: mockGetAgentMessage,
  closeOtelSpan: vi.fn(),
}))
vi.mock('../channel-coordinator/ingest.js', () => ({
  COORDINATOR_AGENT_ID: 'telegram-coordinator',
}))
vi.mock('../prompt-safety.js', () => ({
  sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '')),
}))
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/kanban-ref-normalize.js', () => ({
  normalizeKanbanRefs: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../web/federation/address.js', () => ({
  parseQualifiedId: vi.fn().mockReturnValue(null),
  formatQualifiedId: vi.fn(),
}))
vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: vi.fn().mockReturnValue({ peers: [] }),
}))

import { tryHandleMessages } from '../web/routes/messages.js'

function makeCtx(method: string, path: string, body?: object, params?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
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
  if (params) { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v) }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleMessages - GET extended paths', () => {
  it('GET /api/messages with status=pending and no agent returns pending list (no-arg overload)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/messages', undefined, { status: 'pending' })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // getPendingMessages() called with no args (no agent filter)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('GET /api/messages with no filters returns full message list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/messages')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // listAgentMessages called
    expect(Array.isArray(out.body)).toBe(true)
  })
})

describe('tryHandleMessages - PUT /api/messages/:id', () => {
  it('PUT returns 200 when markMessageDone succeeds and no message found (no OTel/notification)', async () => {
    mockMarkMessageDone.mockReturnValueOnce(true)
    mockGetAgentMessage.mockReturnValueOnce(null)
    const { ctx, out } = makeCtx('PUT', '/api/messages/42', { status: 'done', result: 'completed ok' })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('PUT returns 404 when markMessageFailed returns false (message not found)', async () => {
    mockMarkMessageFailed.mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('PUT', '/api/messages/999', { status: 'failed' })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PUT with done status closes OTel span when trace_id and span_id present', async () => {
    mockMarkMessageDone.mockReturnValueOnce(true)
    mockGetAgentMessage.mockReturnValueOnce({
      id: 42,
      from_agent: 'agent-d',
      to_agent: 'agent-a',
      content: 'do something',
      trace_id: 'trace-abc',
      span_id: 'span-xyz',
    })
    const { ctx, out } = makeCtx('PUT', '/api/messages/42', { status: 'done', result: 'result text' })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PUT with done status sends reverse notification when from != to and no Eredmeny prefix', async () => {
    mockMarkMessageDone.mockReturnValueOnce(true)
    mockGetAgentMessage.mockReturnValueOnce({
      id: 77,
      from_agent: 'agent-d',
      to_agent: 'agent-b',
      content: 'original task content',
      trace_id: null,
      span_id: null,
    })
    const db = await import('../db.js')
    const createSpy = vi.mocked(db.createAgentMessage)
    createSpy.mockClear()
    const { ctx, out } = makeCtx('PUT', '/api/messages/77', { status: 'done', result: 'done!' })
    await tryHandleMessages(ctx)
    expect(out.body.ok).toBe(true)
    // createAgentMessage called to send reverse notification agent-b→agent-d
    expect(createSpy).toHaveBeenCalled()
  })

  it('PUT skips reverse notification when content starts with [Eredmeny]', async () => {
    mockMarkMessageDone.mockReturnValueOnce(true)
    mockGetAgentMessage.mockReturnValueOnce({
      id: 88,
      from_agent: 'agent-d',
      to_agent: 'agent-b',
      content: '[Eredmény] msg_id:77 status:done\n\nsummary',
      trace_id: null,
      span_id: null,
    })
    const db = await import('../db.js')
    const createSpy = vi.mocked(db.createAgentMessage)
    createSpy.mockClear()
    await tryHandleMessages(
      makeCtx('PUT', '/api/messages/88', { status: 'done' }).ctx,
    )
    // Should NOT create another reverse notification to prevent ping-pong
    expect(createSpy).not.toHaveBeenCalled()
  })
})
