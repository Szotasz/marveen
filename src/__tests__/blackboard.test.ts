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
const mockInsertBlackboardHistory = vi.fn()
const mockListBlackboardHistory = vi.fn<(opts?: unknown) => object[]>(() => [])
vi.mock('../db.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
  insertBlackboardHistory: (a: unknown) => mockInsertBlackboardHistory(a),
  listBlackboardHistory: (a: unknown) => mockListBlackboardHistory(a),
}))

function makeStmt(value: unknown) {
  return { all: vi.fn(() => value), get: vi.fn(() => value), run: vi.fn(() => ({ lastInsertRowid: 1n })) }
}

import { tryHandleBlackboard } from '../web/routes/blackboard.js'

// ---------- history fixtures ----------
const HISTORY_ROWS = [
  { id: 1, agent_id: 'agent-a', task_ref: 'task-001', status: 'active', summary: 'Started', created_at: 1700000000 },
  { id: 2, agent_id: 'agent-a', task_ref: 'task-001', status: 'done',   summary: 'Finished', created_at: 1700001000 },
]

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
    expect(mockInsertBlackboardHistory).toHaveBeenCalledOnce()
    expect(mockInsertBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: 'agent-a', status: 'active' })
    )
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
    expect(mockInsertBlackboardHistory).toHaveBeenCalledOnce()
  })

  it('rejects missing agent_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', { summary: 'No agent' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/agent_id/)
    expect(mockInsertBlackboardHistory).not.toHaveBeenCalled()
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

  it('does not record history on no-op upsert (identical data)', async () => {
    // existing row has the same status, summary, and task_ref as the incoming POST
    const stmtCheck = makeStmt({ ...ROW_A })
    const stmtInsert = makeStmt(undefined)
    const stmtGet = makeStmt({ ...ROW_A })
    mockPrepare
      .mockReturnValueOnce(stmtCheck)
      .mockReturnValueOnce(stmtInsert)
      .mockReturnValueOnce(stmtGet)
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: ROW_A.summary,
      task_ref: ROW_A.task_ref,
      status: ROW_A.status,
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(200)
    expect(mockInsertBlackboardHistory).not.toHaveBeenCalled()
  })

  it('records history when status changes on upsert', async () => {
    const stmtCheck = makeStmt({ ...ROW_A })           // existing: active
    const stmtInsert = makeStmt(undefined)
    const stmtGet = makeStmt({ ...ROW_A, status: 'done' }) // new: done
    mockPrepare
      .mockReturnValueOnce(stmtCheck)
      .mockReturnValueOnce(stmtInsert)
      .mockReturnValueOnce(stmtGet)
    const { ctx } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: ROW_A.summary,
      status: 'done',
    })
    await tryHandleBlackboard(ctx)
    expect(mockInsertBlackboardHistory).toHaveBeenCalledOnce()
    expect(mockInsertBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done' })
    )
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
    expect(mockInsertBlackboardHistory).toHaveBeenCalledOnce()
    expect(mockInsertBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done' })
    )
  })

  it('returns 404 when id does not exist', async () => {
    const stmtGet = makeStmt(undefined)
    mockPrepare.mockReturnValue(stmtGet)
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/nonexistent', { status: 'done' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(404)
    expect(mockInsertBlackboardHistory).not.toHaveBeenCalled()
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

  it('does not record history on no-op PATCH (identical data)', async () => {
    // PATCH body matches existing row exactly -- nothing changes
    const stmtGet1 = makeStmt({ ...ROW_A })
    const stmtUpdate = makeStmt(undefined)
    const stmtGet2 = makeStmt({ ...ROW_A })
    mockPrepare
      .mockReturnValueOnce(stmtGet1)
      .mockReturnValueOnce(stmtUpdate)
      .mockReturnValueOnce(stmtGet2)
    const { ctx, out } = makeCtx('PATCH', '/api/blackboard/bb000001', {
      status: ROW_A.status,
      summary: ROW_A.summary,
      task_ref: ROW_A.task_ref,
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(200)
    expect(mockInsertBlackboardHistory).not.toHaveBeenCalled()
  })
})

describe('GET /api/blackboard/history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListBlackboardHistory.mockReturnValue(HISTORY_ROWS)
  })

  it('returns history rows from db', async () => {
    const { ctx, out } = makeCtx('GET', '/api/blackboard/history')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual(HISTORY_ROWS)
  })

  it('passes agent_id filter to db function', async () => {
    const { ctx } = makeCtx('GET', '/api/blackboard/history?agent_id=agent-a')
    await tryHandleBlackboard(ctx)
    expect(mockListBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: 'agent-a' })
    )
  })

  it('passes since filter as integer to db function', async () => {
    const { ctx } = makeCtx('GET', '/api/blackboard/history?since=1700000000')
    await tryHandleBlackboard(ctx)
    expect(mockListBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ since: 1700000000 })
    )
  })

  it('passes limit filter to db function', async () => {
    const { ctx } = makeCtx('GET', '/api/blackboard/history?limit=5')
    await tryHandleBlackboard(ctx)
    expect(mockListBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 })
    )
  })

  it('clamps limit to 200', async () => {
    const { ctx } = makeCtx('GET', '/api/blackboard/history?limit=999')
    await tryHandleBlackboard(ctx)
    expect(mockListBlackboardHistory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 })
    )
  })

  it('returns empty array when db returns nothing', async () => {
    mockListBlackboardHistory.mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/blackboard/history')
    await tryHandleBlackboard(ctx)
    expect(out.body).toEqual([])
  })

  it('returns 400 when since is not an integer', async () => {
    const { ctx, out } = makeCtx('GET', '/api/blackboard/history?since=abc')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/since/)
    expect(mockListBlackboardHistory).not.toHaveBeenCalled()
  })

  it('does NOT interfere with the existing /api/blackboard GET', async () => {
    mockPrepare.mockReturnValue({ all: vi.fn(() => [ROW_A]) })
    const { ctx, out } = makeCtx('GET', '/api/blackboard')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.body).toEqual([ROW_A])
  })
})
