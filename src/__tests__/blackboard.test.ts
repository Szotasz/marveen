import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ---------- fixtures (privacy: no real agent names) ----------
const ROW_A = {
  id: 'bb000001',
  agent_id: 'agent-a',
  task_ref: 'task-001',
  status: 'active',
  summary: 'Working on feature X',
  updated_at: 1700000000,
}
const ROW_B = {
  id: 'bb000002',
  agent_id: 'agent-b',
  task_ref: null,
  status: 'done',
  summary: 'Finished refactor',
  updated_at: 1700001000,
}

// ---------- db mock ----------
const mockPrepare = vi.fn()
vi.mock('../db.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
}))

function makeStmt(value: unknown) {
  return { all: vi.fn(() => value), get: vi.fn(() => value), run: vi.fn(() => ({ lastInsertRowid: 1n })) }
}

import { tryHandleBlackboard } from '../web/routes/blackboard.js'

// ---------- http helpers ----------
function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as unknown as import('node:http').ServerResponse
  const url = new URL('http://localhost' + path)
  const ctx: RouteContext = { req: req as unknown as import('node:http').IncomingMessage, res, path: url.pathname, method, url }
  return { ctx, out }
}

// ---------- tests ----------
describe('GET /api/blackboard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns list from db, max 10 rows', async () => {
    mockPrepare.mockReturnValue(makeStmt([ROW_A, ROW_B]))
    const { ctx, out } = makeCtx('GET', '/api/blackboard')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([ROW_A, ROW_B])
  })

  it('returns empty array when table is empty', async () => {
    mockPrepare.mockReturnValue(makeStmt([]))
    const { ctx, out } = makeCtx('GET', '/api/blackboard')
    await tryHandleBlackboard(ctx)
    expect(out.body).toEqual([])
  })

  it('does not handle unrelated paths', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(false)
  })
})

describe('POST /api/blackboard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates new row when agent has no existing entry', async () => {
    const stmtCheck = makeStmt(undefined)
    const stmtInsert = makeStmt(undefined)
    const stmtGet = makeStmt({ ...ROW_A })
    mockPrepare
      .mockReturnValueOnce(stmtCheck)
      .mockReturnValueOnce(stmtInsert)
      .mockReturnValueOnce(stmtGet)
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: 'Working on feature X',
      task_ref: 'task-001',
      status: 'active',
    })
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as { ok: boolean }).ok).toBe(true)
  })

  it('upserts when agent already has a row', async () => {
    const stmtCheck = makeStmt({ id: 'bb000001' })
    const stmtInsert = makeStmt(undefined)
    const stmtGet = makeStmt({ ...ROW_A, summary: 'Updated' })
    mockPrepare
      .mockReturnValueOnce(stmtCheck)
      .mockReturnValueOnce(stmtInsert)
      .mockReturnValueOnce(stmtGet)
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: 'Updated',
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { row: { summary: string } }).row.summary).toBe('Updated')
  })

  it('rejects missing agent_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', { summary: 'No agent' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/agent_id/)
  })

  it('rejects missing summary', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', { agent_id: 'agent-a' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/summary/)
  })

  it('rejects summary longer than 500 chars', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: 'x'.repeat(501),
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/500/)
  })

  it('rejects invalid status', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: 'ok',
      status: 'pending',
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/status/)
  })

  it('accepts all valid status values', async () => {
    for (const status of ['active', 'done', 'blocked']) {
      vi.clearAllMocks()
      const stmtCheck = makeStmt(undefined)
      const stmtInsert = makeStmt(undefined)
      const stmtGet = makeStmt({ ...ROW_A, status })
      mockPrepare
        .mockReturnValueOnce(stmtCheck)
        .mockReturnValueOnce(stmtInsert)
        .mockReturnValueOnce(stmtGet)
      const { ctx, out } = makeCtx('POST', '/api/blackboard', { agent_id: 'agent-a', summary: 'ok', status })
      await tryHandleBlackboard(ctx)
      expect(out.status).toBe(200)
    }
  })
})

describe('PATCH /api/blackboard/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('updates status and summary', async () => {
    const stmtGet1 = makeStmt({ ...ROW_A })
    const stmtUpdate = makeStmt(undefined)
    const stmtGet2 = makeStmt({ ...ROW_A, status: 'done', summary: 'Finished' })
    mockPrepare
      .mockReturnValueOnce(stmtGet1)
      .mockReturnValueOnce(stmtUpdate)
      .mockReturnValueOnce(stmtGet2)
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/bb000001', { status: 'done', summary: 'Finished' })
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect((out.body as { row: { status: string } }).row.status).toBe('done')
  })

  it('returns 404 when id does not exist', async () => {
    const stmtGet = makeStmt(undefined)
    mockPrepare.mockReturnValue(stmtGet)
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/nonexistent', { status: 'done' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects invalid status in PATCH', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/bb000001', { status: 'paused' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/status/)
  })

  it('rejects summary > 500 chars in PATCH', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/bb000001', { summary: 'y'.repeat(501) })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
  })

  it('does not handle non-matching path', async () => {
    const { ctx } = makeCtx('PATCH', '/api/other/bb000001')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(false)
  })
})
