// Kanban 667: Approval attribution for session-auth callers.
//
// When a session-authenticated B2B user resolves an approval via the dashboard,
// resolved_by must be set to ctx.auth.user (the session username), not the
// body-supplied value. Token-auth callers (fleet agents) continue to use the
// body-supplied resolved_by unchanged.
//
// Mutation proof: removing the `ctx.auth?.kind === 'session' && ctx.auth.user`
// condition causes the session-auth test to pass the body value ('dashboard')
// to resolveApproval instead of the username, failing the argument assertion.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp',
  STORE_DIR: '/tmp/store',
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const mockResolveApproval = vi.fn()
const mockGetApproval = vi.fn()
const mockCreateApproval = vi.fn()
const mockListApprovals = vi.fn()
const mockExpireTimedOutApprovals = vi.fn()
const mockCreateAgentMessage = vi.fn()

vi.mock('../db.js', () => ({
  get createApproval() { return mockCreateApproval },
  get getApproval() { return mockGetApproval },
  get resolveApproval() { return mockResolveApproval },
  get listApprovals() { return mockListApprovals },
  get expireTimedOutApprovals() { return mockExpireTimedOutApprovals },
  get createAgentMessage() { return mockCreateAgentMessage },
}))

import { tryHandleApprovals } from '../web/routes/approvals.js'

function makeCtx(
  method: string,
  path: string,
  body: object | undefined,
  auth?: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
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
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
}

const PENDING_APPROVAL = {
  id: 'appr-001', agent_id: 'agent-d', category: 'file_write',
  action_description: 'Write to /etc', status: 'pending',
  created_at: 0, timeout_at: null, resolved_by: null, resolved_at: null,
}
const RESOLVED_APPROVAL = {
  ...PENDING_APPROVAL, status: 'approved', resolved_by: 'alice', resolved_at: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetApproval.mockReturnValue(PENDING_APPROVAL)
  mockResolveApproval.mockReturnValue(RESOLVED_APPROVAL)
  mockListApprovals.mockReturnValue([])
  mockExpireTimedOutApprovals.mockReturnValue(0)
})

describe('PATCH /api/approvals/:id -- session-auth attribution', () => {
  it('uses ctx.auth.user as resolved_by when session-auth, ignoring body value', async () => {
    mockGetApproval
      .mockReturnValueOnce(PENDING_APPROVAL)
      .mockReturnValueOnce({ ...RESOLVED_APPROVAL, resolved_by: 'alice' })

    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved', resolved_by: 'dashboard' },
      { kind: 'session', user: 'alice' },
    )
    await tryHandleApprovals(ctx)

    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'alice', null)
  })

  it('resolved_by in response reflects the session username, not the body value', async () => {
    mockGetApproval
      .mockReturnValueOnce(PENDING_APPROVAL)
      .mockReturnValueOnce({ ...RESOLVED_APPROVAL, resolved_by: 'alice' })

    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved', resolved_by: 'dashboard' },
      { kind: 'session', user: 'alice' },
    )
    await tryHandleApprovals(ctx)
    expect(out.body.resolved_by).toBe('alice')
  })
})

describe('PATCH /api/approvals/:id -- token-auth attribution unchanged', () => {
  it('uses body resolved_by when token-auth (fleet agent)', async () => {
    mockGetApproval
      .mockReturnValueOnce(PENDING_APPROVAL)
      .mockReturnValueOnce({ ...RESOLVED_APPROVAL, resolved_by: 'jane.doe' })

    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved', resolved_by: 'jane.doe' },
      { kind: 'token' },
    )
    await tryHandleApprovals(ctx)

    expect(out.status).toBe(200)
    expect(mockResolveApproval).toHaveBeenCalledWith('appr-001', 'approved', 'jane.doe', null)
  })

  it('returns 400 when resolved_by missing and not session-auth', async () => {
    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved' },
      { kind: 'token' },
    )
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('resolved_by')
  })
})

describe('PATCH /api/approvals/:id -- no auth (legacy fleet call)', () => {
  it('returns 400 when resolved_by missing and no auth context', async () => {
    const { ctx, out } = makeCtx(
      'PATCH', '/api/approvals/appr-001',
      { status: 'approved' },
      undefined,
    )
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('resolved_by')
  })
})
