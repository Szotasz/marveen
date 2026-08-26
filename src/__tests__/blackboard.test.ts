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
const mockUpsertBlackboard = vi.fn<(agent_id: unknown, data: unknown) => object>(() => ({ ...ROW_A }))
vi.mock('../db.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
  insertBlackboardHistory: (a: unknown) => mockInsertBlackboardHistory(a),
  listBlackboardHistory: (a: unknown) => mockListBlackboardHistory(a),
  upsertBlackboard: (agent_id: unknown, data: unknown) => mockUpsertBlackboard(agent_id, data),
}))

// ---------- settings-store mock (default thresholds) ----------
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => {
    if (key === 'BB_SIGNAL_A_MSG_HOURS') return 2
    if (key === 'BB_SIGNAL_A_BB_HOURS') return 4
    if (key === 'BB_SIGNAL_B_ACTIVE_HOURS') return 24
    return 0
  }),
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
    // Three prepare calls: fleet_blackboard rows, agent_messages (empty), fleet_blackboard_history (empty).
    // Empty history -> lastChangedAt falls back to row.updated_at.
    mockPrepare
      .mockReturnValueOnce(makeStmt([ROW_A, ROW_B]))
      .mockReturnValueOnce(makeStmt([]))
      .mockReturnValueOnce(makeStmt([]))
    const { ctx, out } = makeCtx('GET', '/api/blackboard')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // ROW_A: active + updated_at 1700000000 far in the past (>24h) -> signal 'b'
    // ROW_B: done -> no signal
    expect(out.body).toEqual([{ ...ROW_A, signal: 'b' }, { ...ROW_B, signal: null }])
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

  it('creates new row and calls upsertBlackboard with correct args', async () => {
    mockUpsertBlackboard.mockReturnValueOnce({ ...ROW_A })
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
    expect(mockUpsertBlackboard).toHaveBeenCalledOnce()
    expect(mockUpsertBlackboard).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ status: 'active', summary: 'Working on feature X', task_ref: 'task-001' })
    )
  })

  it('upserts when agent already has a row', async () => {
    mockUpsertBlackboard.mockReturnValueOnce({ ...ROW_A, summary: 'Updated' })
    const { ctx, out } = makeCtx('POST', '/api/blackboard', {
      agent_id: 'agent-a',
      summary: 'Updated',
    })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { row: { summary: string } }).row.summary).toBe('Updated')
    expect(mockUpsertBlackboard).toHaveBeenCalledOnce()
  })

  it('rejects missing agent_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/blackboard', { summary: 'No agent' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toMatch(/agent_id/)
    expect(mockUpsertBlackboard).not.toHaveBeenCalled()
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
      mockUpsertBlackboard.mockReturnValueOnce({ ...ROW_A, status })
      const { ctx, out } = makeCtx('POST', '/api/blackboard', { agent_id: 'agent-a', summary: 'ok', status })
      await tryHandleBlackboard(ctx)
      expect(out.status).toBe(200)
    }
  })

  // No-op detection and history writes are implemented inside upsertBlackboard (db.ts),
  // which is tested against real SQLite in db-blackboard-history.test.ts.
  // The route's responsibility is forwarding valid input to upsertBlackboard.
  it('passes task_ref=null when omitted from POST body', async () => {
    mockUpsertBlackboard.mockReturnValueOnce({ ...ROW_A, task_ref: null })
    const { ctx, out } = makeCtx('POST', '/api/blackboard', { agent_id: 'agent-a', summary: 'ok' })
    await tryHandleBlackboard(ctx)
    expect(out.status).toBe(200)
    expect(mockUpsertBlackboard).toHaveBeenCalledWith(
      'agent-a',
      expect.objectContaining({ task_ref: null })
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
    mockPrepare
      .mockReturnValueOnce(makeStmt([ROW_A]))
      .mockReturnValueOnce(makeStmt([]))
      .mockReturnValueOnce(makeStmt([]))
    const { ctx, out } = makeCtx('GET', '/api/blackboard')
    const handled = await tryHandleBlackboard(ctx)
    expect(handled).toBe(true)
    expect(out.body).toEqual([{ ...ROW_A, signal: 'b' }])
  })
})
