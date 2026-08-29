import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../workspace-store.js', () => ({
  WORKSPACE_DOC_SIZE_LIMITS: { text: 2097152, code: 4194304, binary: 16777216 },
  saveWorkspaceDoc: vi.fn(),
  getWorkspaceDoc: vi.fn(),
  getWorkspaceDocBlob: vi.fn(),
  listWorkspaceDocs: vi.fn(),
  patchWorkspaceDoc: vi.fn(),
  deleteWorkspaceDoc: vi.fn(),
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import * as store from '../workspace-store.js'
import { tryHandleWorkspace } from '../web/routes/workspace.js'
import { normalizePath } from '../web/routes/versioning.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  rawPath: string,
  body?: object,
  opts: { role?: string; tenantId?: string | null; authKind?: string } = {}
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
  const role = (opts.role ?? 'admin') as any
  const tenantId = opts.tenantId !== undefined ? opts.tenantId : null
  const authKind = opts.authKind ?? 'token'
  return {
    ctx: { req, res, path, method, url, role, tenantId, auth: { kind: authKind as any } } as RouteContext,
    out,
  }
}

const SAMPLE_DOC = {
  id: 'abc123', agent_id: 'rick', tenant_id: 'acme-corp',
  doc_key: '668-plan', title: 'RBAC plan', content: 'content here',
  content_type: 'text', type: 'plan', task_ref: null,
  size_bytes: 12, last_accessed_at: null, created_at: 1787000000, updated_at: 1787000000,
}

beforeEach(() => { vi.clearAllMocks() })

// ── GET /api/workspace ────────────────────────────────────────────────────────

describe('GET /api/workspace', () => {
  it('returns list of docs', async () => {
    vi.mocked(store.listWorkspaceDocs).mockReturnValue([SAMPLE_DOC as any])
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(200)
    expect(out.body.items).toHaveLength(1)
    expect(out.body.total).toBe(1)
  })

  it('passes tenant filter to listWorkspaceDocs for non-admin', async () => {
    vi.mocked(store.listWorkspaceDocs).mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace', undefined, { role: 'agent', tenantId: 'acme-corp' })
    await tryHandleWorkspace(ctx)
    expect(vi.mocked(store.listWorkspaceDocs)).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'acme-corp' })
    )
    expect(out.status).toBe(200)
  })

  it('passes agent filter', async () => {
    vi.mocked(store.listWorkspaceDocs).mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace?agent=rick')
    await tryHandleWorkspace(ctx)
    expect(vi.mocked(store.listWorkspaceDocs)).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'rick' })
    )
    expect(out.status).toBe(200)
  })

  it('returns false for unrelated path', async () => {
    const { ctx } = makeCtx('GET', '/api/memories')
    expect(await tryHandleWorkspace(ctx)).toBe(false)
  })
})

// ── POST /api/workspace ───────────────────────────────────────────────────────

describe('POST /api/workspace', () => {
  it('creates a text doc and returns 201', async () => {
    vi.mocked(store.saveWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'RBAC plan', content_type: 'text', type: 'plan',
      content: 'content here', doc_key: '668-plan',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(201)
    expect(out.body.id).toBe('abc123')
    expect(vi.mocked(store.saveWorkspaceDoc)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: 'rick', content_type: 'text', doc_key: '668-plan' })
    )
  })

  it('returns 403 for session-auth (user token)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'x', content_type: 'text', type: 'plan',
    }, { authKind: 'session' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(403)
    expect(vi.mocked(store.saveWorkspaceDoc)).not.toHaveBeenCalled()
  })

  it('returns 400 for missing agent_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      title: 'x', content_type: 'text', type: 'plan',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('agent_id')
  })

  it('returns 400 for missing title', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', content_type: 'text', type: 'plan',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('title')
  })

  it('returns 400 for invalid content_type', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'x', content_type: 'xml', type: 'plan',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('content_type')
  })

  it('returns 400 for invalid type', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'x', content_type: 'text', type: 'todo',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('type')
  })

  it('returns 413 when content exceeds limit', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'x', content_type: 'text', type: 'plan',
      content: 'x'.repeat(3 * 1024 * 1024),
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(413)
    expect(out.body.error).toBe('limit_exceeded')
  })

  it('returns 400 for binary without content_blob_b64', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'diagram.png', content_type: 'binary', type: 'notes',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('content_blob_b64')
  })

  it('creates a binary doc with base64 blob', async () => {
    const binaryDoc = { ...SAMPLE_DOC, content_type: 'binary', content_blob_b64: null }
    vi.mocked(store.saveWorkspaceDoc).mockReturnValue(binaryDoc as any)
    vi.mocked(store.getWorkspaceDocBlob).mockReturnValue(Buffer.from('PNG'))
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'diagram.png', content_type: 'binary', type: 'notes',
      content_blob_b64: Buffer.from('PNG').toString('base64'),
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(201)
    expect(vi.mocked(store.saveWorkspaceDoc)).toHaveBeenCalledWith(
      expect.objectContaining({ content_type: 'binary', content_blob: expect.any(Buffer) })
    )
  })

  it('accepts code content_type', async () => {
    vi.mocked(store.saveWorkspaceDoc).mockReturnValue({ ...SAMPLE_DOC, content_type: 'code' } as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/workspace', {
      agent_id: 'rick', title: 'migration', content_type: 'code', type: 'notes',
      content: 'CREATE TABLE foo (id INTEGER PRIMARY KEY); -- rm -rf is fine in code',
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(201)
  })
})

// ── GET /api/workspace/:id ────────────────────────────────────────────────────

describe('GET /api/workspace/:id', () => {
  it('returns doc by id', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace/abc123')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe('abc123')
  })

  it('returns 404 for unknown id', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(null)
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace/ghost')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(404)
  })

  it('returns 403 when non-admin accesses a different tenant doc', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue({ ...SAMPLE_DOC, tenant_id: 'other-tenant' } as any)
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace/abc123', undefined, { role: 'agent', tenantId: 'acme-corp' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(403)
  })

  it('includes content_blob_b64 for binary docs', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue({ ...SAMPLE_DOC, content_type: 'binary' } as any)
    vi.mocked(store.getWorkspaceDocBlob).mockReturnValue(Buffer.from('PNG'))
    const { ctx, out } = makeCtx('GET', '/api/v1/workspace/abc123')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(200)
    expect(out.body.content_blob_b64).toBe(Buffer.from('PNG').toString('base64'))
  })
})

// ── PATCH /api/workspace/:id ──────────────────────────────────────────────────

describe('PATCH /api/workspace/:id', () => {
  it('patches title and returns updated doc', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    vi.mocked(store.patchWorkspaceDoc).mockReturnValue({ ...SAMPLE_DOC, title: 'New title' } as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/workspace/abc123', { title: 'New title' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(200)
    expect(out.body.title).toBe('New title')
  })

  it('returns 403 for session-auth caller', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/v1/workspace/abc123', { title: 'x' }, { authKind: 'session' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(403)
  })

  it('returns 404 for unknown doc', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(null)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/workspace/ghost', { title: 'x' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(404)
  })

  it('returns 400 for empty body', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/workspace/abc123', {})
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(400)
  })

  it('returns 413 when patched content exceeds limit', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/workspace/abc123', {
      content: 'x'.repeat(3 * 1024 * 1024),
    })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(413)
  })
})

// ── DELETE /api/workspace/:id ─────────────────────────────────────────────────

describe('DELETE /api/workspace/:id', () => {
  it('deletes doc and returns ok', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(SAMPLE_DOC as any)
    vi.mocked(store.deleteWorkspaceDoc).mockReturnValue(true)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/workspace/abc123')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('returns 403 for session-auth caller', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/v1/workspace/abc123', undefined, { authKind: 'session' })
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(403)
  })

  it('returns 404 for unknown doc', async () => {
    vi.mocked(store.getWorkspaceDoc).mockReturnValue(null)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/workspace/ghost')
    await tryHandleWorkspace(ctx)
    expect(out.status).toBe(404)
  })
})
