import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db.js', () => ({
  getDashboardUser: vi.fn(),
  getTenant: vi.fn(),
  adminPatchDashboardUser: vi.fn(),
}))

vi.mock('../web/auth-sessions.js', () => ({
  listUserSessions: vi.fn(),
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import * as db from '../db.js'
import * as sessions from '../web/auth-sessions.js'
import { tryHandleMe } from '../web/routes/me.js'
import { normalizePath } from '../web/routes/versioning.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_USER = {
  id: 1, username: 'jane.doe', password_hash: 'x', role: 'viewer',
  tenant_id: 'acme-corp', email: 'jane@acme.com', display_name: 'Jane Doe',
  created_at: 1000000, updated_at: 1000000, disabled: 0,
}

const SAMPLE_TENANT = { id: 'acme-corp', display_name: 'Acme Corporation', created_at: 1000000, disabled_at: null }

function makeCtx(
  method: string,
  rawPath: string,
  body?: object,
  opts: { authKind?: string; authUser?: string } = {}
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
  const authKind = opts.authKind ?? 'session'
  const authUser = opts.authUser ?? 'jane.doe'
  const auth = authKind === 'session' ? { kind: 'session' as const, user: authUser } : { kind: authKind as any }
  return {
    ctx: { req, res, path, method, url, role: 'viewer' as any, tenantId: 'acme-corp', auth } as RouteContext,
    out,
  }
}

beforeEach(() => { vi.clearAllMocks() })

// ── GET /api/v1/me ────────────────────────────────────────────────────────────

describe('GET /api/v1/me', () => {
  it('returns profile for session caller', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)
    vi.mocked(db.getTenant).mockReturnValue(SAMPLE_TENANT as any)
    vi.mocked(sessions.listUserSessions).mockReturnValue([{} as any, {} as any, {} as any])

    const { ctx, out } = makeCtx('GET', '/api/v1/me')
    await tryHandleMe(ctx)

    expect(out.status).toBe(200)
    expect(out.body.username).toBe('jane.doe')
    expect(out.body.display_name).toBe('Jane Doe')
    expect(out.body.email).toBe('jane@acme.com')
    expect(out.body.role).toBe('viewer')
    expect(out.body.tenant_id).toBe('acme-corp')
    expect(out.body.tenant_display_name).toBe('Acme Corporation')
    expect(out.body.session_count).toBe(3)
  })

  it('returns null tenant_display_name for global admin (no tenant)', async () => {
    const globalAdminUser = { ...SAMPLE_USER, tenant_id: null }
    vi.mocked(db.getDashboardUser).mockReturnValue(globalAdminUser as any)
    vi.mocked(sessions.listUserSessions).mockReturnValue([])

    const { ctx, out } = makeCtx('GET', '/api/v1/me')
    await tryHandleMe(ctx)

    expect(out.status).toBe(200)
    expect(out.body.tenant_id).toBeNull()
    expect(out.body.tenant_display_name).toBeNull()
    expect(vi.mocked(db.getTenant)).not.toHaveBeenCalled()
  })

  it('returns 401 for token caller', async () => {
    const { ctx, out } = makeCtx('GET', '/api/v1/me', undefined, { authKind: 'token' })
    await tryHandleMe(ctx)
    expect(out.status).toBe(401)
  })

  it('returns 404 if user not found in db', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(undefined)
    const { ctx, out } = makeCtx('GET', '/api/v1/me')
    await tryHandleMe(ctx)
    expect(out.status).toBe(404)
  })

  it('does not handle other paths', async () => {
    const { ctx } = makeCtx('GET', '/api/v1/memories')
    const handled = await tryHandleMe(ctx)
    expect(handled).toBe(false)
  })
})

// ── PATCH /api/v1/me ─────────────────────────────────────────────────────────

describe('PATCH /api/v1/me', () => {
  it('updates display_name', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)
    vi.mocked(db.adminPatchDashboardUser).mockReturnValue({ ...SAMPLE_USER, display_name: 'Jane Updated' } as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { display_name: 'Jane Updated' })
    await tryHandleMe(ctx)

    expect(out.status).toBe(200)
    expect(out.body.display_name).toBe('Jane Updated')
    expect(vi.mocked(db.adminPatchDashboardUser)).toHaveBeenCalledWith(1, { display_name: 'Jane Updated' })
  })

  it('updates email', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)
    vi.mocked(db.adminPatchDashboardUser).mockReturnValue({ ...SAMPLE_USER, email: 'new@acme.com' } as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { email: 'New@Acme.com' })
    await tryHandleMe(ctx)

    expect(out.status).toBe(200)
    // email is lowercased
    expect(vi.mocked(db.adminPatchDashboardUser)).toHaveBeenCalledWith(1, { email: 'new@acme.com' })
  })

  it('clears display_name when null', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)
    vi.mocked(db.adminPatchDashboardUser).mockReturnValue({ ...SAMPLE_USER, display_name: null } as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { display_name: null })
    await tryHandleMe(ctx)

    expect(out.status).toBe(200)
    expect(vi.mocked(db.adminPatchDashboardUser)).toHaveBeenCalledWith(1, { display_name: null })
  })

  it('rejects invalid email', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { email: 'not-an-email' })
    await tryHandleMe(ctx)

    expect(out.status).toBe(400)
    expect(out.body.field).toBe('email')
  })

  it('rejects display_name over 128 chars', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { display_name: 'x'.repeat(129) })
    await tryHandleMe(ctx)

    expect(out.status).toBe(400)
    expect(out.body.field).toBe('display_name')
  })

  it('rejects empty patch body', async () => {
    vi.mocked(db.getDashboardUser).mockReturnValue(SAMPLE_USER as any)

    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', {})
    await tryHandleMe(ctx)

    expect(out.status).toBe(400)
  })

  it('returns 401 for non-session caller', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/v1/me', { display_name: 'X' }, { authKind: 'token' })
    await tryHandleMe(ctx)
    expect(out.status).toBe(401)
  })
})
