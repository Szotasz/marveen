// Tenant-scoping tests for approvals:
//   1. GET /api/approvals scopes to session user's tenant (non-admin)
//   2. GET /api/approvals is global for admin session
//   3. POST /api/approvals is forbidden for non-admin session users
//   4. PATCH /api/approvals/:id IDOR-guard: cross-tenant resolve -> 403
//   5. PATCH /api/approvals/:id allows same-tenant resolve
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'approvals-tenant-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../db.js', () => ({
  createApproval: vi.fn(),
  getApproval: vi.fn(),
  resolveApproval: vi.fn(),
  listApprovals: vi.fn(),
  expireTimedOutApprovals: vi.fn(),
  createAgentMessage: vi.fn(),
}))

import { tryHandleApprovals } from '../web/routes/approvals.js'
import * as db from '../db.js'

function makeCtx(
  method: string,
  path: string,
  opts: {
    body?: object
    role?: RouteContext['role']
    authKind?: 'token' | 'session' | 'federation' | 'device'
    tenantId?: string | null
    user?: string
  } = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const { body, role, authKind, tenantId, user } = opts
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
  const auth = authKind ? { kind: authKind, user } : undefined
  return {
    ctx: { req, res, path: url.pathname, method, url, role, tenantId, auth } as RouteContext,
    out,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.getApproval).mockReturnValue(undefined)
  vi.mocked(db.listApprovals).mockReturnValue([])
  vi.mocked(db.resolveApproval).mockReturnValue(true)
  vi.mocked(db.expireTimedOutApprovals).mockReturnValue(0)
})

describe('approvals tenant scoping -- GET', () => {
  it('non-admin session passes tenantId to listApprovals', async () => {
    const { ctx, out } = makeCtx('GET', '/api/approvals', {
      authKind: 'session',
      role: 'viewer',
      tenantId: 'tenant-x',
      user: 'alice',
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.listApprovals)).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-x' }),
    )
  })

  it('admin session passes no tenantId (global view)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/approvals', {
      authKind: 'session',
      role: 'admin',
      tenantId: null,
      user: 'admin',
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    // tenantId must be undefined so listApprovals does not add a WHERE clause
    expect(vi.mocked(db.listApprovals)).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined }),
    )
  })

  it('bearer-token caller (no auth) is treated as global (no tenantId filter)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/approvals')
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.listApprovals)).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: undefined }),
    )
  })
})

describe('approvals tenant scoping -- POST forbidden for session non-admin', () => {
  it('returns 403 when session user with viewer role tries to POST', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', {
      authKind: 'session',
      role: 'viewer',
      tenantId: 'tenant-x',
      user: 'alice',
      body: { agent_id: 'agent-a', category: 'cat', action_description: 'do thing' },
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(vi.mocked(db.createApproval)).not.toHaveBeenCalled()
  })

  it('returns 403 when session user with read_only role tries to POST', async () => {
    const { ctx, out } = makeCtx('POST', '/api/approvals', {
      authKind: 'session',
      role: 'read_only',
      tenantId: 'tenant-x',
      user: 'bob',
      body: { agent_id: 'agent-a', category: 'cat', action_description: 'do thing' },
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(vi.mocked(db.createApproval)).not.toHaveBeenCalled()
  })
})

describe('approvals IDOR guard -- PATCH resolve', () => {
  it('non-admin session cannot resolve a cross-tenant approval (IDOR regression)', async () => {
    // Approval belongs to tenant-y, caller is in tenant-x
    vi.mocked(db.getApproval).mockReturnValue({
      id: 'appr-1',
      agent_id: 'agent-a',
      category: 'cat',
      action_description: 'do thing',
      status: 'pending',
      timeout_at: null,
      resolved_by: null,
      resolved_at: null,
      telegram_message_id: null,
      requested_at: 0,
      tenant_id: 'tenant-y',
    })
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-1', {
      authKind: 'session',
      role: 'viewer',
      tenantId: 'tenant-x',
      user: 'alice',
      body: { status: 'approved' },
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(vi.mocked(db.resolveApproval)).not.toHaveBeenCalled()
  })

  it('non-admin session can resolve an approval that belongs to their own tenant', async () => {
    vi.mocked(db.getApproval)
      .mockReturnValueOnce({
        id: 'appr-2',
        agent_id: 'agent-b',
        category: 'cat',
        action_description: 'do thing',
        status: 'pending',
        timeout_at: null,
        resolved_by: null,
        resolved_at: null,
        telegram_message_id: null,
        requested_at: 0,
        tenant_id: 'tenant-x',
      })
      .mockReturnValueOnce({
        id: 'appr-2',
        agent_id: 'agent-b',
        category: 'cat',
        action_description: 'do thing',
        status: 'approved',
        timeout_at: null,
        resolved_by: 'alice',
        resolved_at: 1,
        telegram_message_id: null,
        requested_at: 0,
        tenant_id: 'tenant-x',
      })
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-2', {
      authKind: 'session',
      role: 'viewer',
      tenantId: 'tenant-x',
      user: 'alice',
      body: { status: 'approved' },
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.resolveApproval)).toHaveBeenCalledOnce()
    expect(out.body.status).toBe('approved')
  })

  it('admin session can resolve any tenant approval without IDOR check', async () => {
    vi.mocked(db.getApproval)
      .mockReturnValueOnce({
        id: 'appr-3',
        agent_id: 'agent-c',
        category: 'cat',
        action_description: 'do thing',
        status: 'pending',
        timeout_at: null,
        resolved_by: null,
        resolved_at: null,
        telegram_message_id: null,
        requested_at: 0,
        tenant_id: 'tenant-z',
      })
      .mockReturnValueOnce({
        id: 'appr-3',
        agent_id: 'agent-c',
        category: 'cat',
        action_description: 'do thing',
        status: 'approved',
        timeout_at: null,
        resolved_by: 'admin',
        resolved_at: 2,
        telegram_message_id: null,
        requested_at: 0,
        tenant_id: 'tenant-z',
      })
    const { ctx, out } = makeCtx('PATCH', '/api/approvals/appr-3', {
      authKind: 'session',
      role: 'admin',
      tenantId: null,
      user: 'admin',
      body: { status: 'approved' },
    })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.resolveApproval)).toHaveBeenCalledOnce()
  })
})
