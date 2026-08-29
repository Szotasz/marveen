// Kanban 666: User-level audit trail for session-auth callers on core write routes.
//
// When a session-authenticated B2B user (auth.kind === 'session') calls a core
// write endpoint, an agent_audit_log row must be created with the username as
// agent_id. Token and device callers must produce NO audit row on those paths.
//
// Mutation proof: removing the `ctx.auth?.kind === 'session' && ctx.auth.user`
// condition would cause the "token-auth callers produce no audit row" assertions
// to fail. Removing only `ctx.auth.user` (keeping the kind check) would cause
// the agent_id assertion to fail because undefined would be passed instead of
// the username.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── db.js mock (shared across all three routes) ──────────────────────────────
// NOTE: writeAgentAuditLog is defined inline (not as a top-level const) because
// vi.mock factories are hoisted before variable declarations.

vi.mock('../db.js', () => ({
  // memories
  saveAgentMemory: vi.fn().mockReturnValue({ id: 42 }),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({}),
  updateMemory: vi.fn(),
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn(),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) }),
    transaction: vi.fn().mockImplementation((fn: () => any) => fn),
  }),
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  runMemoryMaintenance: vi.fn(),
  runLinkMaintenance: vi.fn(),
  getLinksForMemories: vi.fn().mockReturnValue([]),
  syncVecMemoryDelete: vi.fn(),

  // kanban
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
  getKanbanCard: vi.fn().mockReturnValue({ id: 'card1', title: 'Test', depth: 0, dispatched_at: null, assignee: null, project: null }),
  getChildCards: vi.fn().mockReturnValue([]),
  getSubtree: vi.fn().mockReturnValue([]),
  reparentKanbanCard: vi.fn().mockReturnValue({ ok: true }),
  propagateStatus: vi.fn(),
  createAgentMessage: vi.fn().mockReturnValue({ id: 1, from_agent: 'jane.doe', to_agent: 'marveen', origin_note: null }),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn().mockReturnValue(null),
  listLabels: vi.fn().mockReturnValue([]),
  getLabel: vi.fn().mockReturnValue(null),
  createLabel: vi.fn().mockReturnValue({ id: 'lbl1', name: 'bug', color: '#e74c3c' }),
  updateLabel: vi.fn().mockReturnValue(true),
  deleteLabel: vi.fn().mockReturnValue(true),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn().mockReturnValue(true),
  getLabelsForAllCards: vi.fn().mockReturnValue(new Map()),
  getLabelsForCard: vi.fn().mockReturnValue([]),
  listArchivedKanbanCards: vi.fn().mockReturnValue([]),
  revertIdeaFromKanban: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn().mockReturnValue(null),
  countNewHotMemories: vi.fn().mockReturnValue(0),
  countPlannedKanbanCards: vi.fn().mockReturnValue(0),

  // messages
  getPendingMessages: vi.fn().mockReturnValue([]),
  listAgentMessages: vi.fn().mockReturnValue([]),
  getAgentConversation: vi.fn().mockReturnValue([]),
  getAgentConversationThreads: vi.fn().mockReturnValue([]),
  markMessageDone: vi.fn().mockReturnValue(true),
  markMessageFailed: vi.fn().mockReturnValue(true),
  getAgentMessage: vi.fn().mockReturnValue(null),
  closeOtelSpan: vi.fn(),
  getPendingBacklogByAgent: vi.fn().mockReturnValue([]),
  COMPLETION_REPORT_PREFIX: '[Eredmény]',
  isAuthorizedPartnerSender: vi.fn().mockReturnValue(true),
  findBlackboardRowByAgent: vi.fn().mockReturnValue(undefined),
  upsertBlackboard: vi.fn(),

  // shared audit
  writeAgentAuditLog: vi.fn(),
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  ALLOWED_CHAT_ID: 'default',
  OLLAMA_URL: '',
  APP_TZ: 'UTC',
  OWNER_NAME: 'test-owner',
  SYSTEM_SENDER_IDS: '',
  parseSystemSenderIds: () => new Set<string>(),
  BOT_NAME: 'marveen',
  STORE_DIR: '/tmp/store',
  WEB_HOST: 'localhost',
  WEB_PORT: 3420,
  KANBAN_LABEL_COLORS: ['#e74c3c'],
}))
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/kanban-ref-normalize.js', () => ({
  normalizeKanbanRefs: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readAgentDisplayName: vi.fn().mockReturnValue(''),
  isKnownAgent: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
}))
vi.mock('../kanban-dispatch.js', () => ({
  resolveKanbanDispatchTarget: vi.fn().mockReturnValue(null),
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue(100),
}))
vi.mock('../web/tenant-scope.js', () => ({
  scopeToTenant: vi.fn().mockReturnValue({ kanban: { get: vi.fn().mockReturnValue({ id: 'card1', title: 'Test' }) } }),
}))
vi.mock('../channel-coordinator/ingest.js', () => ({
  COORDINATOR_AGENT_ID: 'telegram-coordinator',
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
vi.mock('../llm-breakdown.js', () => ({
  generateBreakdown: vi.fn(),
}))
vi.mock('../web/llm-breakdown.js', () => ({
  generateBreakdown: vi.fn(),
}))

import * as db from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { tryHandleMessages } from '../web/routes/messages.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  path: string,
  body: object | undefined,
  auth: RouteContext['auth'],
  extra: Partial<RouteContext> = {},
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
  return {
    ctx: { req, res, path: url.pathname, method, url, role: 'admin', auth, tenantId: null, ...extra } as RouteContext,
    out,
  }
}

const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'jane.doe' }
const TOKEN_AUTH: RouteContext['auth']   = { kind: 'token' }

beforeEach(() => {
  vi.clearAllMocks()
})

// ── POST /api/memories ────────────────────────────────────────────────────────

describe('POST /api/memories -- session-auth audit', () => {
  it('writes audit row with username when session-auth user creates a memory', async () => {
    const { ctx } = makeCtx('POST', '/api/memories', { content: 'test memory', category: 'warm' }, SESSION_AUTH)
    await tryHandleMemories(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledOnce()
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'jane.doe',
      entity: 'memory',
      action: 'create',
      entity_id: 42,
    }))
  })

  it('does NOT write audit row for token-auth callers', async () => {
    const { ctx } = makeCtx('POST', '/api/memories', { content: 'test memory', category: 'warm' }, TOKEN_AUTH)
    await tryHandleMemories(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).not.toHaveBeenCalled()
  })

  it('audit row contains username, not email or display_name', async () => {
    const { ctx } = makeCtx('POST', '/api/memories', { content: 'test', category: 'hot' }, SESSION_AUTH)
    await tryHandleMemories(ctx)
    const call = vi.mocked(db.writeAgentAuditLog).mock.calls[0][0]
    expect(call.agent_id).toBe('jane.doe')
    expect(call.detail).toBeUndefined()
  })
})

// ── POST /api/kanban (card create) ────────────────────────────────────────────

describe('POST /api/kanban -- session-auth audit', () => {
  it('writes audit row with username when session-auth user creates a card', async () => {
    const { ctx } = makeCtx('POST', '/api/kanban', { title: 'New task', status: 'planned' }, SESSION_AUTH)
    await tryHandleKanban(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledOnce()
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'jane.doe',
      entity: 'kanban',
      action: 'create',
    }))
  })

  it('does NOT write audit row for token-auth callers on card create', async () => {
    const { ctx } = makeCtx('POST', '/api/kanban', { title: 'New task' }, TOKEN_AUTH)
    await tryHandleKanban(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).not.toHaveBeenCalled()
  })
})

// ── PUT /api/kanban/:id (card update) ─────────────────────────────────────────

describe('PUT /api/kanban/:id -- session-auth audit', () => {
  it('writes audit row with username when session-auth user updates a card', async () => {
    const { ctx } = makeCtx('PUT', '/api/kanban/card1', { status: 'done' }, SESSION_AUTH)
    await tryHandleKanban(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledOnce()
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'jane.doe',
      entity: 'kanban',
      action: 'update',
      entity_id: 'card1',
    }))
  })

  it('does NOT write audit row for token-auth callers on card update', async () => {
    const { ctx } = makeCtx('PUT', '/api/kanban/card1', { status: 'done' }, TOKEN_AUTH)
    await tryHandleKanban(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).not.toHaveBeenCalled()
  })
})

// ── POST /api/messages ────────────────────────────────────────────────────────

describe('POST /api/messages -- session-auth audit', () => {
  it('writes audit row with username when session-auth user sends a message', async () => {
    const { ctx } = makeCtx(
      'POST', '/api/messages',
      { from: 'marveen', to: 'marveen', content: 'hello' },
      SESSION_AUTH,
      // tenantId null = not a partner tenant, so the existing partner-audit branch is skipped
      { tenantId: null },
    )
    await tryHandleMessages(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledOnce()
    expect(vi.mocked(db.writeAgentAuditLog)).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: 'jane.doe',
      entity: 'message',
      action: 'create',
    }))
  })

  it('does NOT write audit row for token-auth callers on message send', async () => {
    const { ctx } = makeCtx(
      'POST', '/api/messages',
      { from: 'marveen', to: 'marveen', content: 'hello' },
      TOKEN_AUTH,
      { tenantId: null },
    )
    await tryHandleMessages(ctx)
    expect(vi.mocked(db.writeAgentAuditLog)).not.toHaveBeenCalled()
  })

  it('audit row agent_id is the session username, not the message from-field', async () => {
    const { ctx } = makeCtx(
      'POST', '/api/messages',
      { from: 'marveen', to: 'marveen', content: 'a task' },
      SESSION_AUTH,
      { tenantId: null },
    )
    await tryHandleMessages(ctx)
    const call = vi.mocked(db.writeAgentAuditLog).mock.calls[0][0]
    // The human user 'jane.doe' is the audited actor, not the agent 'marveen' they composed as.
    expect(call.agent_id).toBe('jane.doe')
  })
})
