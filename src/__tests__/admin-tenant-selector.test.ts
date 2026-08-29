// Kanban 669: Tenant-selector server-side support.
//
// 1. GET /api/auth/status returns role and tenant_id for session-auth callers
//    so the dashboard can identify global admins (role=admin, tenant_id=null).
// 2. GET /api/memories, GET /api/kanban, GET /api/recall accept ?tenant=<id>
//    when called by an admin; non-admin callers are unaffected.
//
// Mutation proof (auth/status):
//   Removing the `auth?.kind === 'session'` guard would cause the role/tenant_id
//   to be set for token callers too, failing the "non-session: role=null" tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Shared mock setup ─────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp',
  STORE_DIR: '/tmp/store',
  MAIN_AGENT_ID: 'marveen',
  APP_TZ: 'UTC',
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('../db.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../db.js')>()
  return {
    ...mod,
    countDashboardUsers: vi.fn().mockReturnValue(1),
    getDb: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
        run: vi.fn(),
      }),
      transaction: vi.fn().mockImplementation((fn: () => any) => fn),
    }),
    saveAgentMemory: vi.fn().mockReturnValue({ id: 1 }),
    getAgentMemories: vi.fn().mockReturnValue([]),
    searchAgentMemories: vi.fn().mockReturnValue([]),
    getMemoryStats: vi.fn().mockReturnValue({ total: 0, byCategory: {} }),
    hybridSearch: vi.fn().mockResolvedValue([]),
    backfillEmbeddings: vi.fn(),
    clearMemoryCache: vi.fn(),
    searchMemories: vi.fn().mockReturnValue([]),
    getMemoriesForChat: vi.fn().mockReturnValue([]),
    touchMemoriesAccessed: vi.fn(),
    recordMemoryRead: vi.fn(),
    recordMemoryReadBatch: vi.fn(),
    getStaleMemories: vi.fn().mockReturnValue([]),
    getMemoryVersions: vi.fn().mockReturnValue([]),
    runMemoryMaintenance: vi.fn(),
    runLinkMaintenance: vi.fn(),
    getLinksForMemories: vi.fn().mockReturnValue([]),
    syncVecMemoryDelete: vi.fn(),
    listKanbanCards: vi.fn().mockReturnValue([]),
    getLabelsForAllCards: vi.fn().mockReturnValue(new Map()),
    writeAgentAuditLog: vi.fn(),
  }
})

vi.mock('../web/tenant-scope.js', () => ({
  scopeToTenant: vi.fn().mockReturnValue({
    kanban: { list: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) },
    memories: { list: vi.fn().mockReturnValue([]) },
  }),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readAgentDisplayName: vi.fn().mockReturnValue(''),
  isKnownAgent: vi.fn().mockReturnValue(true),
}))

vi.mock('../web/kanban-ref-normalize.js', () => ({
  normalizeKanbanRefs: vi.fn().mockImplementation((s: string) => s),
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue(100),
}))

vi.mock('../prompt-safety.js', () => ({
  sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '')),
}))

vi.mock('../web/federation/address.js', () => ({
  parseQualifiedId: vi.fn().mockReturnValue(null),
  formatQualifiedId: vi.fn(),
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: vi.fn().mockReturnValue({ enabled: false, peers: [], systemId: 'local' }),
}))

vi.mock('../llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
vi.mock('../channel-coordinator/ingest.js', () => ({ COORDINATOR_AGENT_ID: 'telegram-coordinator' }))
vi.mock('../web/agent-process.js', () => ({ isAgentRunning: vi.fn().mockReturnValue(false) }))
vi.mock('../kanban-dispatch.js', () => ({ resolveKanbanDispatchTarget: vi.fn().mockReturnValue(null) }))

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  pathAndQuery: string,
  auth?: RouteContext['auth'],
  extra: Partial<RouteContext> = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, auth, ...extra } as RouteContext,
    out,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── auth/status ───────────────────────────────────────────────────────────────

import { tryHandleAuth } from '../web/routes/auth.js'

describe('GET /api/auth/status -- role and tenant_id for session callers', () => {
  it('returns role=admin and tenant_id=null for a global-admin session', async () => {
    const { ctx, out } = makeCtx('GET', '/api/auth/status',
      { kind: 'session', user: 'jane.doe' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleAuth(ctx)
    expect(out.status).toBe(200)
    expect(out.body.role).toBe('admin')
    expect(out.body.tenant_id).toBeNull()
  })

  it('returns role=viewer and tenant_id for a tenant-scoped session', async () => {
    const { ctx, out } = makeCtx('GET', '/api/auth/status',
      { kind: 'session', user: 'jane.doe' },
      { role: 'viewer', tenantId: 'acme-corp' },
    )
    await tryHandleAuth(ctx)
    expect(out.body.role).toBe('viewer')
    expect(out.body.tenant_id).toBe('acme-corp')
  })

  it('returns role=null and tenant_id=null for token-auth callers', async () => {
    const { ctx, out } = makeCtx('GET', '/api/auth/status',
      { kind: 'token' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleAuth(ctx)
    expect(out.body.role).toBeNull()
    expect(out.body.tenant_id).toBeNull()
  })

  it('mutation proof: non-session callers must not leak role', async () => {
    const { ctx, out } = makeCtx('GET', '/api/auth/status',
      { kind: 'token' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleAuth(ctx)
    // If the session guard were removed, role would be 'admin' (from ctx.role).
    // It must be null for non-session auth.
    expect(out.body.role).toBeNull()
  })
})

// ── kanban ?tenant ────────────────────────────────────────────────────────────

import * as tenantScope from '../web/tenant-scope.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

describe('GET /api/kanban -- admin ?tenant filter', () => {
  it('calls scopeToTenant when admin passes ?tenant=acme-corp', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban?tenant=acme-corp',
      { kind: 'session', user: 'jane.doe' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(tenantScope.scopeToTenant)).toHaveBeenCalledWith(expect.anything(), 'acme-corp')
  })

  it('does not scope when admin omits ?tenant (bypass -- all tenants)', async () => {
    const { ctx } = makeCtx('GET', '/api/kanban',
      { kind: 'session', user: 'jane.doe' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleKanban(ctx)
    expect(vi.mocked(tenantScope.scopeToTenant)).not.toHaveBeenCalled()
  })

  it('ignores ?tenant for non-admin callers (uses their own tenantId)', async () => {
    const { ctx } = makeCtx('GET', '/api/kanban?tenant=acme-corp',
      { kind: 'session', user: 'jane.doe' },
      { role: 'viewer', tenantId: 'own-tenant' },
    )
    await tryHandleKanban(ctx)
    // scopeToTenant called with own-tenant, not the spoofed acme-corp
    expect(vi.mocked(tenantScope.scopeToTenant)).toHaveBeenCalledWith(expect.anything(), 'own-tenant')
  })
})

// ── memories ?tenant (BUG 1 regression) ──────────────────────────────────────
// Mutation proof: removing the `tenantParam ??` prefix from the recallTenantId
// assignment would cause BUG 1 to return: admin+?tenant would bypass tenant
// filter (undefined) instead of scoping to the requested tenant.

import * as dbMod from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'

// Default mode is 'hybrid', so ?q without mode= hits hybridSearch(agentId, q, limit, tenantId).
// tenantId is the 4th arg (index 3).
describe('GET /api/memories -- admin ?tenant filter', () => {
  it('scopes to ?tenant when admin passes tenant param', async () => {
    const { ctx, out } = makeCtx('GET', '/api/memories?q=test&tenant=alpha',
      { kind: 'session', user: 'jane.doe' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    // hybridSearch 4th arg must be 'alpha' (not undefined -- BUG 1 regression)
    const mock = vi.mocked(dbMod.hybridSearch)
    expect(mock).toHaveBeenCalled()
    expect(mock.mock.calls[0][3]).toBe('alpha')
  })

  it('bypasses tenant filter (undefined) when admin omits ?tenant', async () => {
    const { ctx } = makeCtx('GET', '/api/memories?q=test',
      { kind: 'session', user: 'jane.doe' },
      { role: 'admin', tenantId: null },
    )
    await tryHandleMemories(ctx)
    const mock = vi.mocked(dbMod.hybridSearch)
    expect(mock).toHaveBeenCalled()
    expect(mock.mock.calls[0][3]).toBeUndefined()
  })

  it('non-admin cannot spoof ?tenant -- uses own tenantId (IDOR guard)', async () => {
    // A viewer passing ?tenant=other-tenant must NOT gain access to that tenant's memories.
    // recallTenantId must equal the caller's own tenantId, not the spoofed param.
    const { ctx } = makeCtx('GET', '/api/memories?q=test&tenant=other-tenant',
      { kind: 'session', user: 'jane.doe' },
      { role: 'viewer', tenantId: 'own-tenant' },
    )
    await tryHandleMemories(ctx)
    const mock = vi.mocked(dbMod.hybridSearch)
    expect(mock).toHaveBeenCalled()
    // Must be called with 'own-tenant', not 'other-tenant'
    expect(mock.mock.calls[0][3]).toBe('own-tenant')
  })
})

// ── tenant-selector.js frontend unit ─────────────────────────────────────────
// Vitest runs under Node (no jsdom), so we shim the four DOM methods the
// selector uses. The module-level auth-status cache is busted by resetModules()
// before each dynamic import.

describe('initTenantSelector -- frontend unit', () => {
  let container: any
  let savedFetch: typeof globalThis.fetch
  let savedDocument: typeof globalThis.document
  let savedWindow: typeof globalThis.window

  beforeEach(() => {
    savedFetch    = globalThis.fetch
    savedDocument = (globalThis as any).document
    savedWindow   = (globalThis as any).window
    container = { hidden: true, append: vi.fn() }
    ;(globalThis as any).window   = {}
    ;(globalThis as any).document = {
      getElementById: vi.fn().mockReturnValue(container),
      createElement: vi.fn().mockImplementation((_tag: string) => ({
        className: '', textContent: '', htmlFor: '', id: '', value: '',
        children: [] as any[],
        addEventListener: vi.fn(),
        appendChild: vi.fn(),
        append: vi.fn(),
      })),
    }
  })

  afterEach(() => {
    globalThis.fetch            = savedFetch
    ;(globalThis as any).document = savedDocument
    ;(globalThis as any).window   = savedWindow
    vi.resetModules()
  })

  it('returns null for non-admin callers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ role: 'viewer', tenant_id: 'acme', authenticated: true }),
    }) as any
    const { initTenantSelector } = await import('../../web/modules/tenant-selector.js')
    const getter = await initTenantSelector('myContainer', vi.fn())
    expect(getter).toBeNull()
  })

  it('renders select and returns getter when admin + tenants available', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('auth/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ role: 'admin', tenant_id: null, authenticated: true }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [{ id: 'alpha', display_name: 'Alpha Co' }], total: 1 }) })
    }) as any
    const { initTenantSelector } = await import('../../web/modules/tenant-selector.js')
    const getter = await initTenantSelector('myContainer', vi.fn())
    expect(getter).not.toBeNull()
    expect(container.hidden).toBe(false)
  })

  it('returns null when tenant list response uses legacy array shape (no .items)', async () => {
    // Regression: old shape was a bare array; .items ?? [] must guard against this
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('auth/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ role: 'admin', tenant_id: null, authenticated: true }) })
      }
      // Legacy bare-array response -- no .items field
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'alpha', display_name: 'Alpha Co' }]) })
    }) as any
    const { initTenantSelector } = await import('../../web/modules/tenant-selector.js')
    const getter = await initTenantSelector('myContainer', vi.fn())
    // .items is undefined -> fallback [] -> tenants.length === 0 -> null
    expect(getter).toBeNull()
  })
})
