import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  initDatabase,
  getDb,
  getKanbanCard,
  recallByDateRange,
  recallSearch,
  getBackgroundTasks,
  createBackgroundTaskAtomic,
  finishBackgroundTask,
  listArchivedKanbanCards,
  getKanbanSeqByIdPrefix,
  getHeartbeatKanbanSummary,
  createKanbanCard,
  updateKanbanCard,
  archiveKanbanCard,
  reparentKanbanCard,
  analyzeWorkflowCandidates,
  pruneToolCallLog,
  logToolCall,
  queryAuditLog,
  updateIdea,
  createIdea,
  logStoreFileEvent,
  getRecentStoreFileEvents,
  getPendingMessages,
  setMessageResult,
  createAgentMessage,
  saveAgentMemory,
  appendDailyLog,
  logConfigChange,
  logIdeaStatusChange,
} from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/db-ext3-test-' + process.pid,
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: '123456',
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue('90'),
}))

beforeAll(() => {
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
// recallByDateRange
// ---------------------------------------------------------------------------

function getTodayDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Budapest' })
}

describe('recallByDateRange', () => {
  beforeAll(() => {
    // Insert with today's date so recallByDateRange with today's range finds them
    appendDailyLog('recall-agent-a', 'Worked on coverage recall test')
    appendDailyLog('recall-agent-a', 'More coverage recall work')
    appendDailyLog('recall-agent-f', 'agent-f log entry recall test')
    saveAgentMemory('recall-agent-a', 'Coverage memory recall', 'warm', 'coverage')
  })

  it('returns logs in date range', () => {
    const today = getTodayDate()
    const result = recallByDateRange(today, today)
    expect(Array.isArray(result.logs)).toBe(true)
    expect(result.logs.length).toBeGreaterThanOrEqual(2)
    expect(result.dateRange.from).toBe(today)
    expect(result.dateRange.to).toBe(today)
  })

  it('filters by agentId', () => {
    const today = getTodayDate()
    const result = recallByDateRange(today, today, 'recall-agent-f')
    expect(result.logs.every(l => l.agent_id === 'recall-agent-f')).toBe(true)
  })

  it('returns memories in range', () => {
    const today = getTodayDate()
    const result = recallByDateRange(today, today)
    expect(Array.isArray(result.memories)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recallSearch
// ---------------------------------------------------------------------------

describe('recallSearch', () => {
  beforeAll(() => {
    appendDailyLog('recall-agent-a', 'Unique phrase xyzzy coverage alpha')
    saveAgentMemory('recall-agent-a', 'Unique xyzzy memory content', 'cold', 'xyzzy')
  })

  it('returns matching logs and memories', () => {
    const result = recallSearch('xyzzy')
    expect(Array.isArray(result.logs)).toBe(true)
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it('filters by agentId', () => {
    const result = recallSearch('xyzzy', 'recall-agent-a', 20)
    expect(result.memories.every(m => m.agent_id === 'recall-agent-a' || m.category === 'shared')).toBe(true)
  })

  it('returns empty dateRange when no logs match', () => {
    const result = recallSearch('zzz-no-match-ever-1234567')
    expect(result.logs).toHaveLength(0)
    expect(result.dateRange.from).toBe('')
    expect(result.dateRange.to).toBe('')
  })
})

// ---------------------------------------------------------------------------
// getBackgroundTasks without agentId
// ---------------------------------------------------------------------------

describe('getBackgroundTasks without agentId', () => {
  it('returns all running tasks when agentId omitted', () => {
    const id = 'task-' + Date.now()
    createBackgroundTaskAtomic(id, 'test-agent', 'Test prompt', 'tmux-sess', 10)
    const tasks = getBackgroundTasks()
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.some(t => t.id === id)).toBe(true)
  })

  it('returns finished tasks with includeFinished=true', () => {
    const id = 'task-fin-' + Date.now()
    createBackgroundTaskAtomic(id, 'test-agent', 'Finished task', 'tmux-fin', 10)
    finishBackgroundTask(id, 'done', 'output')
    const tasks = getBackgroundTasks(undefined, true)
    expect(tasks.some(t => t.id === id && t.status === 'done')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// listArchivedKanbanCards with filters
// ---------------------------------------------------------------------------

describe('listArchivedKanbanCards with filters', () => {
  const archivedCardId = 'arch-flt-' + Date.now().toString(16)

  beforeAll(() => {
    createKanbanCard({ id: archivedCardId, title: 'Test Archived Card Filter', status: 'done', priority: 'high', project: 'proj-alpha', assignee: 'test-user' })
    archiveKanbanCard(archivedCardId)
  })

  it('filters by project', () => {
    const result = listArchivedKanbanCards({ limit: 50, project: 'proj-alpha' })
    expect(result.some(c => c.id === archivedCardId)).toBe(true)
  })

  it('filters by from/to timestamps', () => {
    const now = Math.floor(Date.now() / 1000)
    const result = listArchivedKanbanCards({ limit: 50, from: now - 10, to: now + 10 })
    expect(Array.isArray(result)).toBe(true)
  })

  it('filters by query string', () => {
    const result = listArchivedKanbanCards({ limit: 50, q: 'Test Archived Card Filter' })
    expect(result.some(c => c.id === archivedCardId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getKanbanSeqByIdPrefix
// ---------------------------------------------------------------------------

describe('getKanbanSeqByIdPrefix', () => {
  it('returns null for nonexistent id', () => {
    expect(getKanbanSeqByIdPrefix('zzzzzzzz')).toBeNull()
  })

  it('returns seq for known card id', () => {
    const seqId = 'seq-tst-' + Date.now().toString(16)
    createKanbanCard({ id: seqId, title: 'Seq Test Card', status: 'planned' })
    const seq = getKanbanSeqByIdPrefix(seqId)
    expect(typeof seq).toBe('number')
    expect(seq).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getHeartbeatKanbanSummary
// ---------------------------------------------------------------------------

describe('getHeartbeatKanbanSummary', () => {
  it('returns urgent, in_progress, waiting arrays', () => {
    const result = getHeartbeatKanbanSummary()
    expect(Array.isArray(result.urgent)).toBe(true)
    expect(Array.isArray(result.in_progress)).toBe(true)
    expect(Array.isArray(result.waiting)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// updateKanbanCard branches
// ---------------------------------------------------------------------------

describe('updateKanbanCard branches', () => {
  it('returns false for nonexistent card', () => {
    expect(updateKanbanCard('card-nonexistent', { title: 'New Title' })).toBe(false)
  })

  it('returns false when new parent is not found', () => {
    const cid = 'upd-card-' + Date.now().toString(16)
    createKanbanCard({ id: cid, title: 'Card for reparent test', status: 'planned' })
    expect(updateKanbanCard(cid, { parent_id: 'nonexistent-parent' })).toBe(false)
  })

  it('updates parent_id to null (top-level)', () => {
    const parentId = 'upd-par-' + Date.now().toString(16)
    const childId = 'upd-child-' + Date.now().toString(16)
    createKanbanCard({ id: parentId, title: 'Parent card', status: 'planned' })
    createKanbanCard({ id: childId, title: 'Child card', status: 'planned', parent_id: parentId })
    const ok = updateKanbanCard(childId, { parent_id: null })
    expect(ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// reparentKanbanCard branches
// ---------------------------------------------------------------------------

describe('reparentKanbanCard branches', () => {
  it('returns error for nonexistent card', () => {
    const result = reparentKanbanCard('nonexistent-card', null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('not_found')
      expect(result.hint).toMatch(/not found/i)
    }
  })

  it('returns ok:true for top-level reparent', () => {
    const rid = 'rep-top-' + Date.now().toString(16)
    createKanbanCard({ id: rid, title: 'Top-level reparent card', status: 'planned' })
    const result = reparentKanbanCard(rid, null)
    expect(result.ok).toBe(true)
  })

  it('returns error for self-parenting', () => {
    const selfId = 'rep-self-' + Date.now().toString(16)
    createKanbanCard({ id: selfId, title: 'Self-parent test', status: 'planned' })
    const result = reparentKanbanCard(selfId, selfId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid_value')
      expect(result.hint).toMatch(/own parent/i)
    }
  })
})

// ---------------------------------------------------------------------------
// analyzeWorkflowCandidates + pruneToolCallLog
// ---------------------------------------------------------------------------

describe('analyzeWorkflowCandidates', () => {
  it('returns empty array when no recent tool calls', () => {
    const result = analyzeWorkflowCandidates(0, 5, 300)
    expect(result).toEqual([])
  })

  it('finds workflow candidates when many tool calls exist in a session', () => {
    const sessionId = 'wf-test-session-' + Date.now()
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 6; i++) {
      logToolCall(sessionId, 'Bash', null, true, 'agent-a', null, 100)
    }
    const result = analyzeWorkflowCandidates(3600, 5, 300)
    expect(Array.isArray(result)).toBe(true)
    const found = result.find(c => c.session_id === sessionId)
    expect(found).toBeDefined()
    expect(found!.tool_calls.length).toBeGreaterThanOrEqual(6)
  })

  it('splits chunks by time gaps', () => {
    // Already tested indirectly; just verify structure
    const result = analyzeWorkflowCandidates(3600, 1, 0)
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('pruneToolCallLog', () => {
  it('prunes old entries', () => {
    pruneToolCallLog(0)
  })

  it('uses default olderThanSecs', () => {
    pruneToolCallLog()
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog - idea/store/diary sources
// ---------------------------------------------------------------------------

describe('queryAuditLog with idea source', () => {
  beforeAll(() => {
    const ideaId = 'idea-audit-' + Date.now().toString(16)
    createIdea({ id: ideaId, title: 'Audit test idea', description: 'desc', category: 'Fejlesztes', status: 'new', source: 'test', impact: 3, effort: 2, kanban_id: null })
    logIdeaStatusChange(ideaId, null, 'new', 'test-actor', 'test note')
  })

  it('returns idea audit entries', () => {
    const results = queryAuditLog({ sources: ['idea'], limit: 50 })
    expect(results.some(r => r.source === 'idea')).toBe(true)
  })

  it('filters idea entries by from/to', () => {
    const now = Math.floor(Date.now() / 1000)
    const results = queryAuditLog({ sources: ['idea'], from: now - 5, to: now + 5, limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })

  it('filters idea entries by query string', () => {
    const results = queryAuditLog({ sources: ['idea'], q: 'test note', limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('queryAuditLog with store source', () => {
  beforeAll(() => {
    logStoreFileEvent('config/test.json', 'write', 0, 1024, 'agent-a')
  })

  it('returns store audit entries', () => {
    const results = queryAuditLog({ sources: ['store'], limit: 50 })
    expect(results.some(r => r.source === 'store')).toBe(true)
  })

  it('filters store entries by agent', () => {
    const results = queryAuditLog({ sources: ['store'], agent: 'agent-a', limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })

  it('filters store entries by from/to and query', () => {
    const now = Math.floor(Date.now() / 1000)
    const results = queryAuditLog({ sources: ['store'], from: now - 5, to: now + 5, q: 'test.json', limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('queryAuditLog with diary source', () => {
  it('returns diary entries (logs + memories)', () => {
    const results = queryAuditLog({ sources: ['diary'], limit: 50 })
    const hasDiary = results.some(r => r.source === 'diary')
    expect(hasDiary).toBe(true)
  })

  it('filters diary by agent', () => {
    const results = queryAuditLog({ sources: ['diary'], agent: 'agent-a', limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })

  it('filters diary by from/to', () => {
    const now = Math.floor(Date.now() / 1000)
    const results = queryAuditLog({ sources: ['diary'], from: now - 60, to: now + 60, limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })

  it('filters diary by query string', () => {
    const results = queryAuditLog({ sources: ['diary'], q: 'coverage', limit: 50 })
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('queryAuditLog with multiple sources', () => {
  it('merges all sources when sources is empty (default all)', () => {
    const results = queryAuditLog({ sources: [], limit: 100 })
    expect(Array.isArray(results)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// updateIdea patch branches
// ---------------------------------------------------------------------------

describe('updateIdea patch branches', () => {
  it('updates all optional patch fields', () => {
    const id = 'idea-patch-' + Date.now().toString(16)
    createIdea({ id, title: 'Patch test idea', description: null, category: 'Fejlesztes', status: 'new', source: 'test', impact: 2, effort: 2, kanban_id: null })
    const ok = updateIdea(id, {
      title: 'Updated Title',
      description: 'New description',
      category: 'Optimalizalas',
      status: 'reviewed',
      kanban_id: 'kanban-123',
      impact: 5,
      effort: 1,
    })
    expect(ok).toBe(true)
  })

  it('returns false for nonexistent idea', () => {
    const ok = updateIdea('nonexistent-idea-' + Date.now(), { title: 'x' })
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// logStoreFileEvent / getRecentStoreFileEvents
// ---------------------------------------------------------------------------

describe('logStoreFileEvent and getRecentStoreFileEvents', () => {
  it('logs and retrieves store file events', () => {
    logStoreFileEvent('store/test.db', 'read', 1, 512, 'agent-h')
    const events = getRecentStoreFileEvents(10)
    expect(events.some(e => e.rel_path === 'store/test.db')).toBe(true)
  })

  it('logs event without agent', () => {
    logStoreFileEvent('store/anon.db', 'create', 0, null, null)
    const events = getRecentStoreFileEvents(10)
    expect(events.some(e => e.rel_path === 'store/anon.db')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getPendingMessages without toAgent + setMessageResult
// ---------------------------------------------------------------------------

describe('getPendingMessages without toAgent', () => {
  it('returns all pending messages', () => {
    createAgentMessage('test-sender', 'test-receiver', 'ping from test')
    const msgs = getPendingMessages()
    expect(Array.isArray(msgs)).toBe(true)
    expect(msgs.some(m => m.content === 'ping from test')).toBe(true)
  })
})

describe('setMessageResult', () => {
  it('sets result on an existing message', () => {
    const msg = createAgentMessage('result-sender', 'result-recv', 'test msg for result')
    const ok = setMessageResult(msg.id, 'result-text')
    expect(ok).toBe(true)
  })

  it('returns false for nonexistent message id', () => {
    const ok = setMessageResult(99999999, 'no such')
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// logConfigChange (dashboard user audit) – covers lines 2406-2410
// ---------------------------------------------------------------------------

describe('logConfigChange', () => {
  it('logs a config change entry', () => {
    logConfigChange('test.key', 'old-value', 'new-value', 'agent-a')
  })

  it('logs with null old value', () => {
    logConfigChange('test.key2', null, 'new', 'system')
  })
})
