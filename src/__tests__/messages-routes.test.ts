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
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, OWNER_NAME: 'test-owner' }
})

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
    expect(out.body.error).toBe('missing_required_fields')
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
    expect(out.body.error).toBe('sender_reserved')
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
    expect(out.body.error).toBe('federated_sender_not_allowed')
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

  it('POST /api/messages allows owner as sender even though isKnownAgent returns false', async () => {
    // The human operator (OWNER_NAME) is not a fleet agent (no agents/<id>/ dir)
    // but must be allowed to send from the dashboard Messages page.
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'test-owner',
      to: 'agent-a',
      content: 'Hello from dashboard',
    })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/messages returns 403 for unknown non-owner sender', async () => {
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'unknown-entity',
      to: 'agent-a',
      content: 'inject',
    })
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('unknown_sender')
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other-route')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(false)
  })
})

// Regression guard: error codes must be stable machine tokens, not prose.
// These assertions use strict equality so that restoring any old sentence
// string ("from, to, and content are required" etc.) causes an immediate failure.
describe('POST /api/messages: error codes are snake_case machine tokens', () => {
  it('missing fields → missing_required_fields (not a prose sentence)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', { from: 'agent-a' })
    await tryHandleMessages(ctx)
    expect(out.body.error).toBe('missing_required_fields')
    expect(out.body.hint).toContain('required')
  })

  it('coordinator sender → sender_reserved (not a prose sentence)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'telegram-coordinator',
      to: 'agent-b',
      content: 'test',
    })
    await tryHandleMessages(ctx)
    expect(out.body.error).toBe('sender_reserved')
    expect(out.body.hint).toContain('reserved')
  })

  it('slash in from → federated_sender_not_allowed (not a prose sentence)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'peer/attacker',
      to: 'agent-b',
      content: 'test',
    })
    await tryHandleMessages(ctx)
    expect(out.body.error).toBe('federated_sender_not_allowed')
    expect(out.body.hint).toContain('federation')
  })

  it('unknown sender → unknown_sender (not a prose sentence)', async () => {
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/messages', {
      from: 'stranger',
      to: 'agent-b',
      content: 'inject',
    })
    await tryHandleMessages(ctx)
    expect(out.body.error).toBe('unknown_sender')
    expect(out.body.hint).toContain('stranger')
  })

  // Regression guard for the PUT /api/messages/:id 404 path.
  // Strict equality so restoring the old prose string fails immediately.
  it('PUT /api/messages/:id not found → message_not_found (not a prose sentence)', async () => {
    const { markMessageDone } = await import('../db.js')
    vi.mocked(markMessageDone).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('PUT', '/api/messages/99999', { status: 'done' })
    await tryHandleMessages(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('message_not_found')
    expect(out.body.hint).toContain('not found')
  })
})
