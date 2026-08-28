// Tests for the partner sender allowlist: DB-backed per-tenant sender auth.
//
// Covers:
//   1. POST /api/messages -- partner-tenant branch (accept, reject, audit)
//   2. POST /api/admin/partner-senders  -- create, duplicate 409, fleet-agent 409
//   3. GET  /api/admin/partner-senders  -- list (all / filtered)
//   4. DELETE /api/admin/partner-senders/:id  -- soft-disable, 404, missing tenant_id
//
// All fixtures are neutral (agent-a, tenant-x, etc.) -- no real agent or user names.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../db.js', () => ({
  // used by messages.ts
  createAgentMessage: vi.fn(),
  getPendingMessages: vi.fn().mockReturnValue([]),
  listAgentMessages: vi.fn().mockReturnValue([]),
  getAgentConversation: vi.fn().mockReturnValue([]),
  getAgentConversationThreads: vi.fn().mockReturnValue([]),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  markMessageDone: vi.fn(),
  markMessageFailed: vi.fn(),
  getAgentMessage: vi.fn(),
  closeOtelSpan: vi.fn(),
  getPendingBacklogByAgent: vi.fn().mockReturnValue([]),
  COMPLETION_REPORT_PREFIX: '[Eredmény]',
  isAuthorizedPartnerSender: vi.fn(),
  writeAgentAuditLog: vi.fn(),
  findBlackboardRowByAgent: vi.fn().mockReturnValue(undefined),
  upsertBlackboard: vi.fn(),
  // used by admin-b2b.ts
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn().mockReturnValue(null),
    }),
  }),
  createTenant: vi.fn(),
  getTenant: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  provisionDashboardUser: vi.fn(),
  getDashboardUserById: vi.fn(),
  listDashboardUsersFiltered: vi.fn(),
  adminPatchDashboardUser: vi.fn(),
  countActiveAdmins: vi.fn(),
  listPartnerSenders: vi.fn(),
  createPartnerSender: vi.fn(),
  disablePartnerSender: vi.fn(),
}))

vi.mock('../channel-coordinator/ingest.js', () => ({
  COORDINATOR_AGENT_ID: 'telegram-coordinator',
}))

vi.mock('../prompt-safety.js', () => ({
  sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '')),
}))

vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: vi.fn().mockReturnValue(false),
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, OWNER_NAME: 'test-owner', SYSTEM_SENDER_IDS: '' }
})

vi.mock('../web/kanban-ref-normalize.js', () => ({
  normalizeKanbanRefs: vi.fn().mockImplementation((s: string) => s),
}))

vi.mock('../web/federation/address.js', () => ({
  parseQualifiedId: vi.fn(),
  formatQualifiedId: vi.fn(),
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: vi.fn().mockReturnValue({ enabled: false, systemId: 'local', peers: [] }),
}))

vi.mock('../web/password-hash.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('$hash$'),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import * as db from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { normalizePath } from '../web/routes/versioning.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  rawPath: string,
  body?: object,
  opts: { role?: string; tenantId?: string | null; auth?: object } = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${rawPath}`)
  const { path } = normalizePath(url.pathname)
  return {
    ctx: {
      req, res, path, method, url,
      role: opts.role ?? 'admin',
      tenantId: opts.tenantId !== undefined ? opts.tenantId : null,
      auth: opts.auth ?? { kind: 'session', user: 'admin-user' },
    } as RouteContext,
    out,
  }
}

const SAMPLE_PS = {
  sender_id: 'partner-bot',
  tenant_id: 'tenant-x',
  display_name: 'Partner Bot',
  created_by: 'admin-user',
  created_at: 1000000,
  disabled_at: null,
}

const SAMPLE_TENANT = { id: 'tenant-x', display_name: 'Tenant X', created_at: 1000000, disabled_at: null }

// ── POST /api/messages -- partner-tenant branch ───────────────────────────────

describe('POST /api/messages -- partner tenant auth', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('accepts a partner send when sender is in allowlist', async () => {
    vi.mocked(db.isAuthorizedPartnerSender).mockReturnValue(true)
    vi.mocked(db.createAgentMessage).mockReturnValue({ id: 7, from_agent: 'partner-bot', to_agent: 'agent-a', origin_note: null } as any)

    const { ctx, out } = makeCtx('POST', '/api/messages',
      { from: 'partner-bot', to: 'agent-a', content: 'hello' },
      { tenantId: 'tenant-x' })
    await tryHandleMessages(ctx)

    expect(out.status).toBe(200)
    expect(db.isAuthorizedPartnerSender).toHaveBeenCalledWith('partner-bot', 'tenant-x')
    expect(db.createAgentMessage).toHaveBeenCalled()
    // Accepted: audit log must record action=create with entity_id=7
    expect(db.writeAgentAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'partner-bot',
      entity: 'message',
      action: 'create',
      entity_id: 7,
    }))
  })

  it('rejects a partner send when sender is NOT in allowlist (403)', async () => {
    vi.mocked(db.isAuthorizedPartnerSender).mockReturnValue(false)

    const { ctx, out } = makeCtx('POST', '/api/messages',
      { from: 'unknown-bot', to: 'agent-a', content: 'hello' },
      { tenantId: 'tenant-x' })
    await tryHandleMessages(ctx)

    expect(out.status).toBe(403)
    expect(db.createAgentMessage).not.toHaveBeenCalled()
    // Rejected: audit log must record action=create with reason in detail
    expect(db.writeAgentAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'unknown-bot',
      entity: 'message',
      action: 'create',
    }))
    const call = vi.mocked(db.writeAgentAuditLog).mock.calls[0][0]
    expect(call.detail).toMatchObject({ reason: 'sender_not_in_allowlist' })
  })

  it('uses fleet-auth path for default-tenant token (no partner check)', async () => {
    // tenantId = null -> not a partner tenant; use fleet auth path
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValueOnce(true)

    vi.mocked(db.createAgentMessage).mockReturnValue({ id: 8, from_agent: 'agent-a', to_agent: 'agent-b', origin_note: null } as any)

    const { ctx, out } = makeCtx('POST', '/api/messages',
      { from: 'agent-a', to: 'agent-b', content: 'fleet msg' },
      { tenantId: null })
    await tryHandleMessages(ctx)

    expect(out.status).toBe(200)
    expect(db.isAuthorizedPartnerSender).not.toHaveBeenCalled()
    // No audit log for non-partner sends
    expect(db.writeAgentAuditLog).not.toHaveBeenCalled()
  })
})

// ── POST /api/admin/partner-senders ──────────────────────────────────────────

describe('POST /api/admin/partner-senders', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValue(false)
  })

  it('creates a partner sender and returns 201', async () => {
    vi.mocked(db.getTenant).mockReturnValue(SAMPLE_TENANT as any)
    vi.mocked(db.listPartnerSenders).mockReturnValue([])
    vi.mocked(db.createPartnerSender).mockReturnValue(SAMPLE_PS as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/partner-senders', {
      sender_id: 'partner-bot', tenant_id: 'tenant-x', display_name: 'Partner Bot',
    })
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(201)
    expect(db.createPartnerSender).toHaveBeenCalledWith('partner-bot', 'tenant-x', 'Partner Bot', 'admin-user')
    expect(out.body.sender_id).toBe('partner-bot')
  })

  it('returns 409 if sender_id already exists for tenant', async () => {
    vi.mocked(db.getTenant).mockReturnValue(SAMPLE_TENANT as any)
    vi.mocked(db.listPartnerSenders).mockReturnValue([SAMPLE_PS] as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/partner-senders', {
      sender_id: 'partner-bot', tenant_id: 'tenant-x', display_name: 'Partner Bot',
    })
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('returns 409 if sender_id collides with a fleet agent name', async () => {
    vi.mocked(db.getTenant).mockReturnValue(SAMPLE_TENANT as any)
    vi.mocked(db.listPartnerSenders).mockReturnValue([])
    const { isKnownAgent } = await import('../web/agent-config.js')
    vi.mocked(isKnownAgent).mockReturnValueOnce(true)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/partner-senders', {
      sender_id: 'agent-a', tenant_id: 'tenant-x', display_name: 'Agent A',
    })
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 400 for invalid sender_id format', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/partner-senders', {
      sender_id: 'bad sender id!', tenant_id: 'tenant-x', display_name: 'Bad',
    })
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('sender_id')
  })

  it('returns 404 if tenant does not exist', async () => {
    vi.mocked(db.getTenant).mockReturnValue(undefined as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/partner-senders', {
      sender_id: 'partner-bot', tenant_id: 'no-such-tenant', display_name: 'X',
    })
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(out.body.field).toBe('tenant_id')
  })
})

// ── GET /api/admin/partner-senders ───────────────────────────────────────────

describe('GET /api/admin/partner-senders', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns all partner senders when no tenant_id filter', async () => {
    vi.mocked(db.listPartnerSenders).mockReturnValue([SAMPLE_PS] as any)

    const { ctx, out } = makeCtx('GET', '/api/v1/admin/partner-senders')
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(200)
    expect(db.listPartnerSenders).toHaveBeenCalledWith(undefined)
    expect(out.body.items).toHaveLength(1)
    expect(out.body.total).toBe(1)
  })

  it('passes tenant_id filter to listPartnerSenders', async () => {
    vi.mocked(db.listPartnerSenders).mockReturnValue([SAMPLE_PS] as any)

    const { ctx, out } = makeCtx('GET', '/api/v1/admin/partner-senders?tenant_id=tenant-x')
    await tryHandleAdminB2b(ctx)

    expect(db.listPartnerSenders).toHaveBeenCalledWith('tenant-x')
    expect(out.body.items[0].tenant_id).toBe('tenant-x')
  })
})

// ── DELETE /api/admin/partner-senders/:id ─────────────────────────────────────

describe('DELETE /api/admin/partner-senders/:id', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('soft-disables an existing partner sender', async () => {
    vi.mocked(db.disablePartnerSender).mockReturnValue(true)

    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/partner-senders/partner-bot?tenant_id=tenant-x')
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(200)
    expect(db.disablePartnerSender).toHaveBeenCalledWith('partner-bot', 'tenant-x')
    expect(out.body.ok).toBe(true)
  })

  it('returns 404 when partner sender not found or already disabled', async () => {
    vi.mocked(db.disablePartnerSender).mockReturnValue(false)

    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/partner-senders/no-such-bot?tenant_id=tenant-x')
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(out.body.field).toBe('senderId')
  })

  it('returns 400 when tenant_id query param is missing', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/partner-senders/partner-bot')
    await tryHandleAdminB2b(ctx)

    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('tenantId')
  })
})
