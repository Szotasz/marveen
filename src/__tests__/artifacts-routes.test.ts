import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mock the DB layer so the route test never touches SQLite ─────────────────

const mockCreate   = vi.fn()
const mockList     = vi.fn()
const mockGet      = vi.fn()
const mockDelete   = vi.fn()

vi.mock('../artifacts-db.js', () => ({
  ARTIFACT_KINDS: new Set(['html', 'markdown', 'json', 'text', 'binary']),
  createArtifact: (...a: unknown[]) => mockCreate(...a),
  listArtifacts:  (...a: unknown[]) => mockList(...a),
  getArtifact:    (...a: unknown[]) => mockGet(...a),
  deleteArtifact: (...a: unknown[]) => mockDelete(...a),
}))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))

import { tryHandleArtifacts } from '../web/routes/artifacts.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

beforeEach(() => { vi.clearAllMocks() })

// ── POST /api/artifacts ───────────────────────────────────────────────────────

describe('POST /api/artifacts', () => {
  it('returns 400 when agent_id is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/artifacts', { title: 'T', kind: 'text', content: 'hi' })
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/agent_id/)
  })

  it('returns 400 when title is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/artifacts', { agent_id: 'agent-a', kind: 'text', content: 'hi' })
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/title/)
  })

  it('returns 400 for invalid kind', async () => {
    const { ctx, out } = makeCtx('POST', '/api/artifacts', { agent_id: 'agent-a', title: 'T', kind: 'word', content: 'x' })
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/kind/)
  })

  it('returns 400 when content is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/artifacts', { agent_id: 'agent-a', title: 'T', kind: 'text' })
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/content/)
  })

  it('calls createArtifact and returns 201 with id', async () => {
    mockCreate.mockReturnValue({ id: 'abc-123' })
    const { ctx, out } = makeCtx('POST', '/api/artifacts', {
      agent_id: 'agent-a', title: 'My artifact', kind: 'html', content: '<h1>hi</h1>',
    })
    const handled = await tryHandleArtifacts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(201)
    expect((out.body as { ok: boolean; id: string }).id).toBe('abc-123')
    expect(mockCreate).toHaveBeenCalledOnce()
    const call = mockCreate.mock.calls[0][0] as { agent_id: string; kind: string; content: Buffer }
    expect(call.agent_id).toBe('agent-a')
    expect(call.kind).toBe('html')
    expect(Buffer.isBuffer(call.content)).toBe(true)
    expect(call.content.toString('utf-8')).toBe('<h1>hi</h1>')
  })

  it('encodes binary content from base64', async () => {
    mockCreate.mockReturnValue({ id: 'bin-1' })
    const raw = Buffer.from([0x00, 0xff])
    const { ctx, out } = makeCtx('POST', '/api/artifacts', {
      agent_id: 'agent-a', title: 'Bin', kind: 'binary', content: raw.toString('base64'),
    })
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(201)
    const call = mockCreate.mock.calls[0][0] as { content: Buffer }
    expect(Buffer.compare(call.content, raw)).toBe(0)
  })
})

// ── GET /api/artifacts ────────────────────────────────────────────────────────

describe('GET /api/artifacts', () => {
  it('returns list from listArtifacts', async () => {
    const rows = [{ id: '1', title: 'A', kind: 'text' }]
    mockList.mockReturnValue(rows)
    const { ctx, out } = makeCtx('GET', '/api/artifacts?agent=agent-a&kind=text')
    const handled = await tryHandleArtifacts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual(rows)
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agent-a', kind: 'text' }))
  })

  it('does not call createArtifact', async () => {
    mockList.mockReturnValue([])
    const { ctx } = makeCtx('GET', '/api/artifacts')
    await tryHandleArtifacts(ctx)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ── GET /api/artifacts/:id ───────────────────────────────────────────────────

describe('GET /api/artifacts/:id', () => {
  it('returns 404 for unknown id', async () => {
    mockGet.mockReturnValue(undefined)
    const { ctx, out } = makeCtx('GET', '/api/artifacts/no-such-id')
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(404)
  })

  it('returns artifact with decoded content for text kind', async () => {
    mockGet.mockReturnValue({
      id: 'x1', agent_id: 'agent-a', title: 'T', kind: 'text', mime: 'text/plain',
      content: Buffer.from('hello', 'utf-8'), meta: '{}', source: null,
      created_at: 1000, updated_at: 1001,
    })
    const { ctx, out } = makeCtx('GET', '/api/artifacts/x1')
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(200)
    const body = out.body as Record<string, unknown>
    expect(body.content).toBe('hello')
    expect(body.kind).toBe('text')
    expect(body.mime).toBe('text/plain')
  })

  it('returns binary content as base64', async () => {
    const raw = Buffer.from([0xca, 0xfe])
    mockGet.mockReturnValue({
      id: 'b1', agent_id: 'agent-a', title: 'B', kind: 'binary', mime: 'application/octet-stream',
      content: raw, meta: '{}', source: null, created_at: 0, updated_at: 0,
    })
    const { ctx, out } = makeCtx('GET', '/api/artifacts/b1')
    await tryHandleArtifacts(ctx)
    expect((out.body as Record<string, unknown>).content).toBe(raw.toString('base64'))
  })
})

// ── DELETE /api/artifacts/:id ─────────────────────────────────────────────────

describe('DELETE /api/artifacts/:id', () => {
  it('returns 200 ok when found', async () => {
    mockDelete.mockReturnValue(true)
    const { ctx, out } = makeCtx('DELETE', '/api/artifacts/del-id')
    const handled = await tryHandleArtifacts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as { ok: boolean }).ok).toBe(true)
    expect(mockDelete).toHaveBeenCalledWith('del-id')
  })

  it('returns 404 when not found', async () => {
    mockDelete.mockReturnValue(false)
    const { ctx, out } = makeCtx('DELETE', '/api/artifacts/ghost')
    await tryHandleArtifacts(ctx)
    expect(out.status).toBe(404)
  })
})

// ── Non-matching paths ────────────────────────────────────────────────────────

describe('non-matching paths', () => {
  it('returns false for /api/other', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    const handled = await tryHandleArtifacts(ctx)
    expect(handled).toBe(false)
  })

  it('returns false for unsupported method on /api/artifacts', async () => {
    const { ctx } = makeCtx('PATCH', '/api/artifacts')
    const handled = await tryHandleArtifacts(ctx)
    expect(handled).toBe(false)
  })
})
