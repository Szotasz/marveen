import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'approvals-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../db.js', () => ({
  createApproval: vi.fn().mockReturnValue({
    id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write',
    action_description: 'Write to /etc', status: 'pending',
    created_at: 1700000000, timeout_at: null, resolved_by: null, resolved_at: null,
  }),
  getApproval: vi.fn().mockReturnValue({
    id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write',
    action_description: 'Write to /etc', status: 'pending',
    created_at: 1700000000, timeout_at: null, resolved_by: null, resolved_at: null,
  }),
  resolveApproval: vi.fn().mockReturnValue({
    id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write',
    action_description: 'Write to /etc', status: 'approved',
    created_at: 1700000000, timeout_at: null, resolved_by: 'user', resolved_at: 1700001000,
  }),
  listApprovals: vi.fn().mockReturnValue([{
    id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write',
    action_description: 'Write to /etc', status: 'pending',
    created_at: 1700000000, timeout_at: null, resolved_by: null, resolved_at: null,
  }]),
  expireTimedOutApprovals: vi.fn().mockReturnValue(0),
  createAgentMessage: vi.fn(),
}))

import { tryHandleApprovals } from '../web/routes/approvals.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleApprovals', () => {
  it('POST /api/approvals returns 400 when agent_id missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', { category: 'file_write', action_description: 'do thing' })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('agent_id')
  })

  it('POST /api/approvals returns 400 when category missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', { agent_id: 'agent-d', action_description: 'do thing' })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('category')
  })

  it('POST /api/approvals returns 400 when action_description missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', { agent_id: 'agent-d', category: 'file_write' })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('action_description')
  })

  it('POST /api/approvals creates approval and returns 201', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', {
      agent_id: 'agent-d',
      category: 'file_write',
      action_description: 'Write to /etc',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body.id).toBe('appr-uuid-1')
    expect(out.body.status).toBe('pending')
  })

  it('GET /api/approvals lists all approvals', async () => {
    const { ctx, out } = makeCtx('GET', '/api/approvals')
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body[0].id).toBe('appr-uuid-1')
  })

  it('GET /api/approvals/:id returns approval', async () => {
    const { ctx, out } = makeCtx('GET', '/api/approvals/appr-uuid-1')
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe('appr-uuid-1')
  })

  it('GET /api/approvals/:id returns 404 for unknown id', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getApproval).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('GET', '/api/approvals/nonexistent')
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PATCH /api/approvals/:id approves with valid body', async () => {
    const db = await import('../db.js')
    // First call: guard check (pending). Second call: final fetch (approved).
    vi.mocked(db.getApproval)
      .mockReturnValueOnce({ id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write', action_description: 'x', status: 'pending', created_at: 0, timeout_at: null, resolved_by: null, resolved_at: null } as any)
      .mockReturnValueOnce({ id: 'appr-uuid-1', agent_id: 'agent-d', category: 'file_write', action_description: 'x', status: 'approved', created_at: 0, timeout_at: null, resolved_by: 'user', resolved_at: 1 } as any)
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-uuid-1', {
      status: 'approved',
      resolved_by: 'user',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('approved')
  })

  it('PATCH /api/approvals/:id returns 400 for invalid status', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-uuid-1', {
      status: 'maybe',
      resolved_by: 'user',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('status')
    expect(out.body.hint).toMatch(/approved.*rejected.*timeout/i)
  })

  it('PATCH /api/approvals/:id returns 400 when resolved_by missing', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-uuid-1', { status: 'approved' })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('resolved_by')
  })

  it('PATCH /api/approvals/:id returns 403 on self-approval', async () => {
    // getApproval returns agent_id: 'agent-d', so resolved_by: 'agent-d' is self
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-uuid-1', {
      status: 'approved',
      resolved_by: 'agent-d',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(out.body.hint).toMatch(/cannot approve/i)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleApprovals(ctx)).toBe(false)
  })
})
