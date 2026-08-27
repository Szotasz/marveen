import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db.js', () => ({
  getDb: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import * as db from '../db.js'
import { tryHandleAdminTokens } from '../web/routes/tokens.js'
import { normalizePath } from '../web/routes/versioning.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors the web.ts dispatch flow: normalizePath strips /v1 before ctx.path
// is set so the handler always sees /api/admin/... not /api/v1/admin/...
// This is the regression test for the path-normalization bug: if tokens.ts still matches /api/v1/...,
// every case below would return false (unhandled) and all expects would fail.
function makeCtx(method: string, rawPath: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
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
    ctx: { req, res, path, method, url, role: 'admin', auth: { kind: 'session', user: 'admin-user' } } as RouteContext,
    out,
  }
}

// Minimal token row as returned from SQLite.
const SAMPLE_TOKEN_ROW = {
  id: 1,
  token_hash: 'abc123hash',
  name: 'ci-token',
  role: 'agent',
  tenant_id: 'default',
  created_at: 1800000000,
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  rotated_from: null,
}

function makeMockDb(overrides: {
  all?: any[]
  get?: any
  runResult?: any
} = {}) {
  const mockStmt = {
    all: vi.fn().mockReturnValue(overrides.all ?? []),
    get: vi.fn().mockReturnValue(overrides.get ?? null),
    run: vi.fn().mockReturnValue(overrides.runResult ?? { lastInsertRowid: 1 }),
  }
  return { prepare: vi.fn().mockReturnValue(mockStmt), transaction: vi.fn().mockImplementation((fn: () => void) => fn) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── GET /api/v1/admin/tokens ──────────────────────────────────────────────────

describe('GET /api/v1/admin/tokens', () => {
  it('returns token list without token_hash field', async () => {
    const mockDb = makeMockDb({ all: [SAMPLE_TOKEN_ROW] })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('GET', '/api/v1/admin/tokens')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body).toHaveLength(1)
    expect(out.body[0].token_hash).toBeUndefined()
    expect(out.body[0].name).toBe('ci-token')
  })

  it('returns empty list when no tokens exist', async () => {
    const mockDb = makeMockDb({ all: [] })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('GET', '/api/v1/admin/tokens')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})

// ── POST /api/v1/admin/tokens (create) ───────────────────────────────────────

describe('POST /api/v1/admin/tokens', () => {
  it('creates a token and returns 201 with raw token value', async () => {
    const mockDb = makeMockDb({ runResult: { lastInsertRowid: 1 }, get: SAMPLE_TOKEN_ROW })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens', { name: 'ci-token', role: 'agent' })
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(201)
    // Raw token must be present once; hash must never be returned.
    expect(typeof out.body.token).toBe('string')
    expect(out.body.token.length).toBeGreaterThan(0)
    expect(out.body.token_hash).toBeUndefined()
    expect(out.body.name).toBe('ci-token')
  })

  it('returns 400 when name is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens', { role: 'agent' })
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('name')
  })

  it('returns 400 for invalid role', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens', { name: 'ci-token', role: 'superuser' })
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('role')
    expect(out.body.hint).toMatch(/role must be one of/)
  })

  it('returns 400 for invalid JSON body', async () => {
    const buf = Buffer.from('not-json')
    const req = new EventEmitter() as any
    req.method = 'POST'
    req.headers = {}
    setImmediate(() => { req.emit('data', buf); req.emit('end') })
    const out = { status: 200, body: null as any }
    const res = {
      writeHead(s: number) { out.status = s },
      end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
    } as any
    const url = new URL('http://localhost:3420/api/v1/admin/tokens')
    const { path } = normalizePath(url.pathname)
    const ctx = { req, res, path, method: 'POST', url, role: 'admin', auth: { kind: 'session', user: 'admin-user' } } as RouteContext

    const handled = await tryHandleAdminTokens(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
  })
})

// ── POST /api/v1/admin/tokens/:id/rotate ─────────────────────────────────────

describe('POST /api/v1/admin/tokens/:id/rotate', () => {
  it('rotates a valid token and returns new raw token', async () => {
    const newRow = { ...SAMPLE_TOKEN_ROW, id: 2, rotated_from: 1 }
    // prepare().get() for the old token lookup, then for the new row fetch
    const mockStmt = {
      all: vi.fn(),
      get: vi.fn()
        .mockReturnValueOnce(SAMPLE_TOKEN_ROW)  // SELECT old token
        .mockReturnValueOnce(newRow),             // SELECT new token after insert
      run: vi.fn(),
    }
    const txFn = vi.fn().mockImplementation((fn: () => void) => () => fn())
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), transaction: txFn }
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens/1/rotate')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(typeof out.body.token).toBe('string')
    expect(out.body.token_hash).toBeUndefined()
    expect(out.body.rotated_from).toBe(1)
  })

  it('returns 404 when token not found', async () => {
    const mockDb = makeMockDb({ get: null })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens/999/rotate')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 409 when token already revoked', async () => {
    const revoked = { ...SAMPLE_TOKEN_ROW, revoked_at: 1800000001 }
    const mockDb = makeMockDb({ get: revoked })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tokens/1/rotate')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })
})

// ── DELETE /api/v1/admin/tokens/:id/revoke ───────────────────────────────────

describe('DELETE /api/v1/admin/tokens/:id/revoke', () => {
  it('revokes a valid token and returns { revoked: true, id }', async () => {
    const mockDb = makeMockDb({ get: SAMPLE_TOKEN_ROW })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/tokens/1/revoke')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.revoked).toBe(true)
    expect(out.body.id).toBe(1)
  })

  it('returns 404 when token not found', async () => {
    const mockDb = makeMockDb({ get: null })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/tokens/999/revoke')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 409 when token already revoked', async () => {
    const revoked = { ...SAMPLE_TOKEN_ROW, revoked_at: 1800000001 }
    const mockDb = makeMockDb({ get: revoked })
    vi.mocked(db.getDb).mockReturnValue(mockDb as any)

    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/tokens/1/revoke')
    const handled = await tryHandleAdminTokens(ctx)

    expect(handled).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })
})

// ── Unmatched routes ──────────────────────────────────────────────────────────

describe('unmatched routes', () => {
  it('returns false for unknown path', async () => {
    const { ctx } = makeCtx('GET', '/api/v1/other-resource')
    const handled = await tryHandleAdminTokens(ctx)
    expect(handled).toBe(false)
  })

  it('returns false for GET on a token id path (no such route)', async () => {
    const { ctx } = makeCtx('GET', '/api/v1/admin/tokens/1')
    const handled = await tryHandleAdminTokens(ctx)
    expect(handled).toBe(false)
  })
})
