import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase, getDb,
  logSkillUsage, getSkillUsageRows, getSkillUsageStats,
  logConfigChange, getRecentConfigChanges,
  logStoreFileEvent, getRecentStoreFileEvents,
  queryAuditLog,
  pruneAuditLogs,
  stampMessageTrace,
  expireTimedOutApprovals,
  upsertOtelSpan, closeOtelSpan, getOtelTrace, listOtelTraces,
  createAgentMessage,
  createApproval,
} from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  // Clean up test-specific rows
  const db = getDb()
  db.exec("DELETE FROM skill_usage WHERE agent_id LIKE 'test-%'")
  db.exec("DELETE FROM config_change_log WHERE actor LIKE 'test-%'")
  db.exec("DELETE FROM store_file_audit WHERE agent LIKE 'test-%' OR rel_path LIKE 'test/%'")
  db.exec("DELETE FROM otel_spans WHERE trace_id LIKE 'trace-test-%'")
  db.exec("DELETE FROM agent_messages WHERE from_agent = 'test-from'")
  db.exec("DELETE FROM approvals WHERE agent_id = 'test-agent-approvals'")
})

// --- Skill Usage ---

describe('logSkillUsage / getSkillUsageRows / getSkillUsageStats', () => {
  it('logSkillUsage inserts a row', () => {
    logSkillUsage('test-rick', 'fleet-dashboard-api', 'tool_call', 'sess-abc')
    logSkillUsage('test-rick', 'fleet-dashboard-api', 'skill_read', null)
    logSkillUsage('test-rick', 'skill-factory', 'tool_call')
    const rows = getSkillUsageRows({ agentId: 'test-rick' })
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows[0].skill_name).toBeDefined()
  })

  it('getSkillUsageRows filters by skillName', () => {
    const rows = getSkillUsageRows({ agentId: 'test-rick', skillName: 'fleet-dashboard-api' })
    expect(rows.every(r => r.skill_name === 'fleet-dashboard-api')).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('getSkillUsageRows respects limit', () => {
    const rows = getSkillUsageRows({ agentId: 'test-rick', limit: 1 })
    expect(rows.length).toBe(1)
  })

  it('getSkillUsageStats returns aggregated stats', () => {
    const stats = getSkillUsageStats()
    const fa = stats.find(s => s.skill_name === 'fleet-dashboard-api')
    expect(fa).toBeDefined()
    expect(fa!.call_count).toBeGreaterThanOrEqual(1)
    expect(fa!.read_count).toBeGreaterThanOrEqual(1)
  })

  it('getSkillUsageStats with sinceSecs filters old rows', () => {
    // With sinceSecs=86400 (1 day from now) => cutoff = now - 86400 = yesterday
    // Our just-inserted rows should still be included since they're recent
    const stats = getSkillUsageStats(86400)
    expect(Array.isArray(stats)).toBe(true)
  })
})

// --- Config Change Log ---

describe('logConfigChange / getRecentConfigChanges', () => {
  it('inserts a config change and reads it back', () => {
    logConfigChange('CHANNEL_TOKEN', 'old-token', 'new-token', 'test-admin')
    logConfigChange('MAIN_AGENT_ID', null, 'marveen', 'test-admin')
    const changes = getRecentConfigChanges(100)
    const tok = changes.find(c => c.key === 'CHANNEL_TOKEN' && c.actor === 'test-admin')
    expect(tok).toBeDefined()
    expect(tok!.old_value).toBe('old-token')
    expect(tok!.new_value).toBe('new-token')
  })

  it('getRecentConfigChanges respects limit', () => {
    const changes = getRecentConfigChanges(1)
    expect(changes.length).toBe(1)
  })
})

// --- Store File Audit ---

describe('logStoreFileEvent / getRecentStoreFileEvents', () => {
  it('inserts and retrieves store file events', () => {
    logStoreFileEvent('test/myfile.json', 'create', 0, 1024, 'test-rick')
    logStoreFileEvent('test/secret.key', 'create', 1, 256, null)
    const events = getRecentStoreFileEvents(100)
    const mine = events.find(e => e.rel_path === 'test/myfile.json')
    expect(mine).toBeDefined()
    expect(mine!.agent).toBe('test-rick')
    expect(mine!.file_size).toBe(1024)
  })
})

// --- Unified Audit Log Query ---

describe('queryAuditLog', () => {
  it('queries config source', () => {
    const entries = queryAuditLog({ sources: ['config'], limit: 50 })
    expect(entries.some(e => e.source === 'config')).toBe(true)
  })

  it('queries store source', () => {
    const entries = queryAuditLog({ sources: ['store'], limit: 50 })
    expect(entries.some(e => e.source === 'store')).toBe(true)
  })

  it('queries all sources when empty array', () => {
    const entries = queryAuditLog({ sources: [], limit: 50 })
    expect(entries.length).toBeGreaterThan(0)
  })

  it('filters by q (full-text search)', () => {
    const entries = queryAuditLog({ sources: ['config'], q: 'CHANNEL_TOKEN', limit: 10 })
    expect(entries.every(e => JSON.stringify(e).includes('CHANNEL_TOKEN'))).toBe(true)
  })

  it('queries idea source without crashing', () => {
    const entries = queryAuditLog({ sources: ['idea'], limit: 10 })
    expect(Array.isArray(entries)).toBe(true)
  })

  it('queries diary source (daily_logs + memories)', () => {
    const entries = queryAuditLog({ sources: ['diary'], limit: 10 })
    expect(Array.isArray(entries)).toBe(true)
  })

  it('filters by from/to timestamps', () => {
    const now = Math.floor(Date.now() / 1000)
    const entries = queryAuditLog({ sources: ['config'], from: now - 60, to: now + 60, limit: 50 })
    expect(Array.isArray(entries)).toBe(true)
  })
})

// --- Audit Log Prune ---

describe('pruneAuditLogs', () => {
  it('runs without throwing', () => {
    expect(() => pruneAuditLogs()).not.toThrow()
  })
})

// --- Message Trace Stamping ---

describe('stampMessageTrace', () => {
  it('stamps trace on a pending message', () => {
    const msg = createAgentMessage('test-from', 'test-to', 'trace test')
    const ok = stampMessageTrace(msg.id, 'trace-test-001', 'span-001', null)
    expect(ok).toBe(true)
    // Second stamp on same message returns false (already has trace_id)
    const ok2 = stampMessageTrace(msg.id, 'trace-test-002', 'span-002', null)
    expect(ok2).toBe(false)
  })
})

// --- Approval Expiry ---

describe('expireTimedOutApprovals', () => {
  it('expires approvals past their timeout', () => {
    const pastTimeout = Math.floor(Date.now() / 1000) - 10
    getDb().prepare(
      `INSERT INTO approvals (id, agent_id, category, action_description, status, timeout_at, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('test-exp-1', 'test-agent-approvals', 'code_exec', 'run tests', 'pending', pastTimeout, pastTimeout - 100)
    const count = expireTimedOutApprovals()
    expect(count).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare("SELECT status FROM approvals WHERE id = 'test-exp-1'").get() as any
    expect(row.status).toBe('timeout')
  })
})

// --- OTel Spans ---

describe('upsertOtelSpan / closeOtelSpan / getOtelTrace / listOtelTraces', () => {
  const traceId = 'trace-test-otel-1'

  it('upsertOtelSpan inserts a new span', () => {
    upsertOtelSpan({
      trace_id: traceId,
      span_id: 'span-a',
      parent_span_id: null,
      agent_id: 'test-rick',
      operation: 'test-op',
      start_ms: Date.now(),
      attributes: null,
    })
    const trace = getOtelTrace(traceId)
    expect(trace.length).toBe(1)
    expect(trace[0].operation).toBe('test-op')
    expect(trace[0].status).toBe('running')
  })

  it('upsertOtelSpan updates existing span on conflict', () => {
    upsertOtelSpan({
      trace_id: traceId,
      span_id: 'span-a',
      parent_span_id: null,
      agent_id: 'test-rick',
      operation: 'test-op',
      start_ms: Date.now(),
      end_ms: Date.now() + 100,
      status: 'ok',
      attributes: null,
    })
    const trace = getOtelTrace(traceId)
    expect(trace[0].status).toBe('ok')
    expect(trace[0].end_ms).not.toBeNull()
  })

  it('closeOtelSpan updates the span status and end_ms', () => {
    upsertOtelSpan({
      trace_id: traceId,
      span_id: 'span-b',
      parent_span_id: 'span-a',
      agent_id: 'test-rick',
      operation: 'child-op',
      start_ms: Date.now(),
      attributes: null,
    })
    const ok = closeOtelSpan(traceId, 'span-b', Date.now() + 50, 'ok')
    expect(ok).toBe(true)
    const trace = getOtelTrace(traceId)
    const spanB = trace.find(s => s.span_id === 'span-b')
    expect(spanB?.status).toBe('ok')
  })

  it('closeOtelSpan returns false for non-existent span', () => {
    expect(closeOtelSpan('no-trace', 'no-span', 0, 'ok')).toBe(false)
  })

  it('listOtelTraces returns summaries of root spans', () => {
    const traces = listOtelTraces(50)
    expect(Array.isArray(traces)).toBe(true)
    const mine = traces.find(t => t.trace_id === traceId)
    expect(mine).toBeDefined()
    expect(mine!.root_operation).toBe('test-op')
  })
})
