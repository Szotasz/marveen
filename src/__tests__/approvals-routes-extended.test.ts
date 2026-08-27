import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockResolveApproval, mockGetApproval } = vi.hoisted(() => ({
  mockResolveApproval: vi.fn().mockReturnValue(false),
  mockGetApproval: vi.fn().mockReturnValue(null),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/approvals-ext-test',
  STORE_DIR: '/tmp/approvals-ext-test/store',
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../db.js', () => ({
  createApproval: vi.fn().mockReturnValue({ id: 'x', agent_id: 'rick', category: 'c', action_description: 'd', status: 'pending', created_at: 0, timeout_at: null, resolved_by: null, resolved_at: null }),
  getApproval: mockGetApproval,
  resolveApproval: mockResolveApproval,
  listApprovals: vi.fn().mockReturnValue([]),
  expireTimedOutApprovals: vi.fn().mockReturnValue(0),
  createAgentMessage: vi.fn(),
}))

import { tryHandleApprovals } from '../web/routes/approvals.js'

function makeRawCtx(method: string, path: string, rawBody?: Buffer): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = rawBody ?? Buffer.alloc(0)
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

function makeCtx(method: string, path: string, body?: object) {
  return makeRawCtx(method, path, body ? Buffer.from(JSON.stringify(body)) : undefined)
}

describe('tryHandleApprovals - PATCH error paths', () => {
  it('PATCH with invalid JSON body returns 400', async () => {
    const { ctx, out } = makeRawCtx('PATCH', '/api/approvals/appr-001', Buffer.from('{ not json %%'))
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
  })

  it('PATCH when resolveApproval returns false and approval not found → 404', async () => {
    mockResolveApproval.mockReturnValueOnce(false)
    mockGetApproval.mockReturnValueOnce({ id: 'appr-001', agent_id: 'rick', status: 'pending', category: 'c', action_description: 'd', created_at: 0, timeout_at: null, resolved_by: null, resolved_at: null })
      .mockReturnValueOnce(null) // final getApproval returns null → 404
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-001', {
      status: 'approved',
      resolved_by: 'user',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PATCH when resolveApproval returns false and approval already resolved → 409', async () => {
    mockResolveApproval.mockReturnValueOnce(false)
    const alreadyResolved = { id: 'appr-002', agent_id: 'rick', status: 'approved', category: 'c', action_description: 'd', created_at: 0, timeout_at: null, resolved_by: 'user', resolved_at: 1 }
    // guard check (no self-approval) + final getApproval
    mockGetApproval.mockReturnValueOnce(alreadyResolved).mockReturnValueOnce(alreadyResolved)
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-002', {
      status: 'approved',
      resolved_by: 'admin',
    })
    const handled = await tryHandleApprovals(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.hint).toMatch(/already resolved/i)
  })
})
