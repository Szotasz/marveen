// Mutation-verified test: PATCH /api/kanban/:id/parent HTTP status code mapping.
//
// The status code MUST come from result.code, not from string inspection of
// result.hint or result.error. The mutation proof: replacing `result.code ===
// 'not_found'` with the old `result.error?.includes('not found')` makes the
// not_found cases return 400 instead of 404, turning both 404 assertions red.

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn().mockReturnValue([]),
  createKanbanCard: vi.fn(),
  updateKanbanCard: vi.fn().mockReturnValue(true),
  deleteKanbanCard: vi.fn().mockReturnValue(true),
  moveKanbanCard: vi.fn().mockReturnValue(true),
  archiveKanbanCard: vi.fn().mockReturnValue(true),
  unarchiveKanbanCard: vi.fn().mockReturnValue(true),
  getKanbanComments: vi.fn().mockReturnValue([]),
  addKanbanComment: vi.fn(),
  getKanbanCardEvents: vi.fn().mockReturnValue([]),
  listKanbanProjects: vi.fn().mockReturnValue([]),
  getKanbanCard: vi.fn().mockReturnValue({ id: 'card1', title: 'T', description: '', depth: 0, dispatched_at: null, assignee: null, project: null }),
  getChildCards: vi.fn().mockReturnValue([]),
  getSubtree: vi.fn().mockReturnValue([]),
  reparentKanbanCard: vi.fn().mockReturnValue({ ok: true }),
  propagateStatus: vi.fn(),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) }),
    transaction: vi.fn().mockImplementation((fn: () => unknown) => fn),
  }),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  listLabels: vi.fn().mockReturnValue([]),
  getLabel: vi.fn().mockReturnValue(null),
  createLabel: vi.fn(),
  updateLabel: vi.fn().mockReturnValue(true),
  deleteLabel: vi.fn().mockReturnValue(true),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn().mockReturnValue(true),
  getCardLabels: vi.fn().mockReturnValue([]),
  getLabelByName: vi.fn().mockReturnValue(null),
  writeAgentAuditLog: vi.fn(),
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: vi.fn().mockReturnValue([]), readAgentDisplayName: vi.fn().mockReturnValue('') }))
vi.mock('../config.js', () => ({
  OWNER_NAME: 'owner',
  BOT_NAME: 'bot',
  MAIN_AGENT_ID: 'agent-a',
  STORE_DIR: '/tmp',
  WEB_HOST: 'localhost',
  WEB_PORT: 3420,
  KANBAN_LABEL_COLORS: [],
}))
vi.mock('../web/agent-process.js', () => ({ isAgentRunning: vi.fn().mockReturnValue(false) }))
vi.mock('../kanban-dispatch.js', () => ({ resolveKanbanDispatchTarget: vi.fn().mockReturnValue(null) }))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: vi.fn().mockReturnValue(100) }))
vi.mock('../web/tenant-scope.js', () => ({ scopeToTenant: vi.fn().mockReturnValue(null) }))
vi.mock('../web/kanban-ref-normalize.js', () => ({ normalizeKanbanRefs: vi.fn().mockReturnValue([]) }))

import { tryHandleKanban } from '../web/routes/kanban.js'
import * as db from '../db.js'

function makeCtx(
  method: string,
  path: string,
  body?: object,
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(s) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

describe('PATCH /api/kanban/:id/parent -- status code from code, not string', () => {
  it('returns 404 when code is not_found (card missing)', async () => {
    vi.mocked(db.reparentKanbanCard).mockReturnValueOnce({
      ok: false, code: 'not_found', hint: 'Card not found',
    })
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/missing/parent', { parent_id: null })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 404 when code is not_found (parent missing)', async () => {
    vi.mocked(db.reparentKanbanCard).mockReturnValueOnce({
      ok: false, code: 'not_found', hint: 'Parent card not found',
    })
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/card1/parent', { parent_id: 'ghost' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    // hint is passed through
    expect(out.body.hint).toBe('Parent card not found')
  })

  it('returns 400 when code is invalid (self-parent)', async () => {
    vi.mocked(db.reparentKanbanCard).mockReturnValueOnce({
      ok: false, code: 'invalid_value', hint: 'Card cannot be its own parent',
    })
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/card1/parent', { parent_id: 'card1' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
  })

  it('returns 400 when code is limit_exceeded (depth)', async () => {
    vi.mocked(db.reparentKanbanCard).mockReturnValueOnce({
      ok: false, code: 'limit_exceeded', hint: 'Reparenting would exceed max depth of 3 levels',
    })
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/card1/parent', { parent_id: 'deep' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('limit_exceeded')
  })
})
