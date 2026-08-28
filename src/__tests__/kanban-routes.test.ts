import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn().mockReturnValue([]),
  createKanbanCard: vi.fn().mockReturnValue({ id: 'card1' }),
  updateKanbanCard: vi.fn().mockReturnValue(true),
  deleteKanbanCard: vi.fn().mockReturnValue(true),
  moveKanbanCard: vi.fn().mockReturnValue(true),
  archiveKanbanCard: vi.fn().mockReturnValue(true),
  unarchiveKanbanCard: vi.fn().mockReturnValue(true),
  getKanbanComments: vi.fn().mockReturnValue([]),
  addKanbanComment: vi.fn().mockReturnValue({ id: 1 }),
  getKanbanCardEvents: vi.fn().mockReturnValue([]),
  listKanbanProjects: vi.fn().mockReturnValue([]),
  getKanbanCard: vi.fn().mockReturnValue({ id: 'card1', title: 'Test', description: '', depth: 0, dispatched_at: null, assignee: null, project: null }),
  getChildCards: vi.fn().mockReturnValue([]),
  getSubtree: vi.fn().mockReturnValue([]),
  reparentKanbanCard: vi.fn().mockReturnValue({ ok: true }),
  propagateStatus: vi.fn(),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) }),
    transaction: vi.fn().mockImplementation((fn: () => any) => fn),
  }),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  listLabels: vi.fn().mockReturnValue([{ id: 'lbl1', name: 'bug', color: '#e74c3c' }]),
  getLabel: vi.fn().mockReturnValue({ id: 'lbl1', name: 'bug', color: '#e74c3c' }),
  createLabel: vi.fn().mockReturnValue({ id: 'lbl1', name: 'bug', color: '#e74c3c' }),
  updateLabel: vi.fn().mockReturnValue(true),
  deleteLabel: vi.fn().mockReturnValue(true),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn().mockReturnValue(true),
  getLabelsForAllCards: vi.fn().mockReturnValue(new Map()),
  getLabelsForCard: vi.fn().mockReturnValue([]),
  listArchivedKanbanCards: vi.fn().mockReturnValue([]),
  revertIdeaFromKanban: vi.fn(),
}))
vi.mock('../web/kanban-ref-normalize.js', () => ({
  normalizeKanbanRefs: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../config.js', () => ({
  OWNER_NAME: 'Jonas',
  BOT_NAME: 'marveen',
  MAIN_AGENT_ID: 'marveen',
  STORE_DIR: '/tmp/store',
  WEB_HOST: 'localhost',
  WEB_PORT: 3420,
  KANBAN_LABEL_COLORS: ['#e74c3c', '#3498db', '#2ecc71'],
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readAgentDisplayName: vi.fn().mockReturnValue(''),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
}))
vi.mock('../kanban-dispatch.js', () => ({
  resolveKanbanDispatchTarget: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/llm-breakdown.js', () => ({
  generateBreakdown: vi.fn().mockResolvedValue({ subtasks: [{ title: 'Sub 1', description: '', assignee: null, priority: 'normal' }] }),
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue(100),
}))

import * as db from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
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
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: 'admin' } as RouteContext, out }
}

describe('tryHandleKanban', () => {
  it('GET /api/kanban returns card list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/kanban creates card', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban', { title: 'New task', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban returns 500 on DB error without leaking exception text', async () => {
    const db = await import('../db.js')
    vi.mocked(db.createKanbanCard).mockImplementationOnce(() => { throw new Error('FK violation') })
    const { ctx, out } = makeCtx('POST', '/api/kanban', { title: 'x' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    // Raw DB exception text must never reach the HTTP response.
    expect(JSON.stringify(out.body)).not.toContain('FK violation')
  })

  it('PUT /api/kanban/:id updates card', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/kanban/card1', { title: 'Updated' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PUT /api/kanban/:id returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.updateKanbanCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('PUT', '/api/kanban/ghost', { title: 'x' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('DELETE /api/kanban/:id deletes card', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/card1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('DELETE /api/kanban/:id returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.deleteKanbanCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/ghost')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('POST /api/kanban/:id/move moves card to done', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/move', { status: 'done', sort_order: 1 })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/move to in_progress fires dispatch', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/move', { status: 'in_progress', sort_order: 1 })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/move returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.moveKanbanCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/move', { status: 'done' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('POST /api/kanban/:id/archive archives card', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/archive')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/archive returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.archiveKanbanCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/archive')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('GET /api/kanban/archived returns archived cards', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/archived')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.cards).toBeDefined()
  })

  it('POST /api/kanban/:id/unarchive unarchives card', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/unarchive')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/unarchive returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.unarchiveKanbanCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/unarchive')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('GET /api/kanban/:id/comments returns comment list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/card1/comments')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/kanban/:id/comments adds comment', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/comments', { author: 'agent-a', content: 'Done!' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/kanban/:id/comments returns 400 when fields missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/comments', { author: 'agent-a' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
  })

  it('GET /api/kanban/:id/events returns event list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/card1/events')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/kanban/assignees returns assignee list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/assignees')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('GET /api/kanban-projects returns project list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban-projects')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/kanban/labels returns label list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/labels')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('POST /api/kanban/labels creates label', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/labels', { name: 'bug' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.id).toBe('lbl1')
  })

  it('POST /api/kanban/labels returns 400 when name missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/labels', {})
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
  })

  it('PUT /api/kanban/labels/:id updates label', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/kanban/labels/lbl1', { name: 'feature' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PUT /api/kanban/labels/:id returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.updateLabel).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('PUT', '/api/kanban/labels/ghost', { name: 'x' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('DELETE /api/kanban/labels/:id deletes label', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/labels/lbl1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('DELETE /api/kanban/labels/:id returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.deleteLabel).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/labels/ghost')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('GET /api/kanban/:id/labels returns card labels', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/card1/labels')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('POST /api/kanban/:id/labels adds label to card', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/labels', { labelId: 'lbl1' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/labels returns 404 when card not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getKanbanCard).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/labels', { labelId: 'lbl1' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('POST /api/kanban/:id/labels returns 400 when labelId missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/labels', {})
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
  })

  it('POST /api/kanban/:id/labels returns 404 when label not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getLabel).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/labels', { labelId: 'ghost' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('DELETE /api/kanban/:id/labels/:labelId removes label', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/card1/labels/lbl1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('DELETE /api/kanban/:id/labels/:labelId returns 404 when not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.removeLabelFromCard).mockReturnValueOnce(false)
    const { ctx, out } = makeCtx('DELETE', '/api/kanban/card1/labels/ghost')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('GET /api/kanban/:id/children returns children', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/card1/children')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/kanban/:id/subtree returns tree', async () => {
    const { ctx, out } = makeCtx('GET', '/api/kanban/card1/subtree')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET /api/kanban/:id/subtree returns 404 when card not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getKanbanCard).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('GET', '/api/kanban/ghost/subtree')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('PATCH /api/kanban/:id/parent reparents card', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/card1/parent', { parent_id: null })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PATCH /api/kanban/:id/parent returns 400 on error', async () => {
    const db = await import('../db.js')
    vi.mocked(db.reparentKanbanCard).mockReturnValueOnce({ ok: false, code: 'limit_exceeded', hint: 'Reparenting would exceed max depth of 3 levels' })
    const { ctx, out } = makeCtx('PATCH', '/api/kanban/card1/parent', { parent_id: 'other' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('limit_exceeded')
  })

  it('POST /api/kanban/:id/breakdown returns subtasks', async () => {
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/breakdown')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.subtasks).toBeDefined()
  })

  it('POST /api/kanban/:id/breakdown returns 404 when card not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getKanbanCard).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/breakdown')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('POST /api/kanban/:id/breakdown returns 409 when children exist', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getChildCards).mockReturnValueOnce([{ id: 'sub1' } as any])
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/breakdown')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(409)
  })

  it('POST /api/kanban/:id/breakdown/accept creates subtasks', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getDb).mockReturnValueOnce({
      transaction: vi.fn().mockImplementation((fn: () => any) => () => ['sub1', 'sub2']),
    } as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/breakdown/accept', {
      subtasks: [{ title: 'Sub', description: '', assignee: null, priority: 'normal' }],
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('POST /api/kanban/:id/breakdown/accept returns 404 when card not found', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getKanbanCard).mockReturnValueOnce(null as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/ghost/breakdown/accept', { subtasks: [] })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('POST /api/kanban/:id/breakdown/accept returns 400 when depth 2', async () => {
    const db = await import('../db.js')
    vi.mocked(db.getKanbanCard).mockReturnValueOnce({ id: 'card1', depth: 2 } as any)
    const { ctx, out } = makeCtx('POST', '/api/kanban/card1/breakdown/accept', { subtasks: [{ title: 'x' }] })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleKanban(ctx)).toBe(false)
  })
})

// ── Tenant isolation (non-admin scoped callers) ───────────────────────────────

function makeScopedCtx(
  method: string,
  path: string,
  tenantId: string,
  body?: object,
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
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: 'viewer', tenantId } as RouteContext, out }
}

describe('tryHandleKanban -- tenant isolation for scoped callers', () => {
  it('GET /api/kanban uses scoped list and does not call listKanbanCards', async () => {
    vi.mocked(db.listKanbanCards).mockClear()
    const { ctx, out } = makeScopedCtx('GET', '/api/kanban', 'acme')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.listKanbanCards)).not.toHaveBeenCalled()
  })

  it('PUT /api/kanban/:id returns 404 when card does not belong to caller tenant', async () => {
    // scopeToTenant.kanban.get → null (getDb mock: prepare().get = null)
    const { ctx, out } = makeScopedCtx('PUT', '/api/kanban/card1', 'acme', { title: 'Updated' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })

  it('DELETE /api/kanban/:id returns 404 when card does not belong to caller tenant', async () => {
    const { ctx, out } = makeScopedCtx('DELETE', '/api/kanban/card1', 'acme')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(404)
  })
})
