import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn().mockReturnValue({ id: 1 }),
  getPendingMessages: vi.fn().mockReturnValue([]),
  listAgentMessages: vi.fn().mockReturnValue([]),
  getAgentConversation: vi.fn().mockReturnValue([]),
  getAgentConversationThreads: vi.fn().mockReturnValue([]),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  markMessageDone: vi.fn().mockReturnValue(true),
  markMessageFailed: vi.fn().mockReturnValue(true),
  getAgentMessage: vi.fn().mockReturnValue(null),
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

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
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
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleMessages', () => {
  it('POST /api/messages returns 400 when fields missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: 'rick' })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/required/i)
  })

  it('POST /api/messages returns 403 when from is coordinator id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'telegram-coordinator',
      to: 'jarvis',
      content: 'test',
    })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/reserved/i)
  })

  it('POST /api/messages returns 403 when from contains slash (federation spoof)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'external/attacker',
      to: 'jarvis',
      content: 'hijack',
    })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/federation/i)
  })

  it('POST /api/messages creates message for known agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'rick',
      to: 'jarvis',
      content: 'Hello!',
    })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe(1)
  })

  it('GET /api/messages returns 200 with list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/messages?agent=jarvis')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/messages with status=pending returns pending list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/messages?agent=jarvis&status=pending')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/messages/threads returns thread list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/messages/threads?agent=jarvis')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other-route')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(false)
  })
})
