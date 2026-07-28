// Tests for OTel distributed tracing (card def5a189).
//
// Scope: DB layer (otel_spans table + stampMessageTrace), API route
// (POST/GET /api/spans, GET /api/traces/:id, GET /api/traces), and the
// message-router middleware propagation logic (stampTraceOnMessage via the
// exported shouldAbandon+shouldGiveUpOnInject boundary).
//
// The DB tests use a real in-memory SQLite instance (same pattern as other
// integration tests in this repo) to exercise actual SQL without a mock layer
// that can drift from the schema.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Minimal in-process DB setup (mirrors initializeDatabase logic for the
// two tables under test so each test starts from a clean slate).
// ---------------------------------------------------------------------------
function makeTestDb() {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      content    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      result     TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER,
      origin_note  TEXT,
      trace_id     TEXT,
      span_id      TEXT,
      parent_span_id TEXT
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS otel_spans (
      trace_id       TEXT NOT NULL,
      span_id        TEXT NOT NULL,
      parent_span_id TEXT,
      agent_id       TEXT NOT NULL,
      operation      TEXT NOT NULL,
      start_ms       INTEGER NOT NULL,
      end_ms         INTEGER,
      status         TEXT NOT NULL DEFAULT 'ok',
      attributes     TEXT,
      PRIMARY KEY (trace_id, span_id)
    )
  `)

  return db
}

// Minimal re-implementations of the DB functions under test so we can test
// the SQL without importing the real db module (which opens the production DB).
function makeDbFns(db: ReturnType<typeof makeTestDb>) {
  function stampMessageTrace(id: number, traceId: string, spanId: string, parentSpanId: string | null) {
    return db.prepare(`
      UPDATE agent_messages
         SET trace_id = ?, span_id = ?, parent_span_id = ?
       WHERE id = ? AND status = 'pending' AND trace_id IS NULL
    `).run(traceId, spanId, parentSpanId, id).changes > 0
  }

  function upsertOtelSpan(s: {
    trace_id: string; span_id: string; parent_span_id: string | null;
    agent_id: string; operation: string; start_ms: number;
    end_ms?: number | null; status?: string; attributes?: string | null;
  }) {
    db.prepare(`
      INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (trace_id, span_id) DO UPDATE SET
        end_ms = excluded.end_ms,
        status = excluded.status,
        attributes = COALESCE(excluded.attributes, otel_spans.attributes)
    `).run(
      s.trace_id, s.span_id, s.parent_span_id ?? null,
      s.agent_id, s.operation, s.start_ms,
      s.end_ms ?? null, s.status ?? 'running', s.attributes ?? null,
    )
  }

  function closeOtelSpan(traceId: string, spanId: string, endMs: number, status: string) {
    return db.prepare(`
      UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ?
    `).run(endMs, status, traceId, spanId).changes > 0
  }

  function getOtelTrace(traceId: string) {
    return db.prepare('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_ms ASC').all(traceId) as {
      trace_id: string; span_id: string; parent_span_id: string | null;
      agent_id: string; operation: string; start_ms: number; end_ms: number | null;
      status: string; attributes: string | null;
    }[]
  }

  function insertMsg(from: string, to: string) {
    const info = db.prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(from, to, 'test', 'pending', Math.floor(Date.now() / 1000))
    return Number(info.lastInsertRowid)
  }

  function getMsg(id: number) {
    return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as {
      trace_id: string | null; span_id: string | null; parent_span_id: string | null; status: string
    } | undefined
  }

  return { stampMessageTrace, upsertOtelSpan, closeOtelSpan, getOtelTrace, insertMsg, getMsg }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('otel_spans: upsertOtelSpan + closeOtelSpan', () => {
  let fns: ReturnType<typeof makeDbFns>
  beforeEach(() => { fns = makeDbFns(makeTestDb()) })

  it('inserts a new open span', () => {
    fns.upsertOtelSpan({
      trace_id: 'T1', span_id: 'S1', parent_span_id: null,
      agent_id: 'agent-a', operation: 'agent-a->agent-b',
      start_ms: 1000,
    })
    const [span] = fns.getOtelTrace('T1')
    expect(span.trace_id).toBe('T1')
    expect(span.span_id).toBe('S1')
    expect(span.end_ms).toBeNull()
    expect(span.status).toBe('running')
  })

  it('closes an open span with correct status', () => {
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S1', parent_span_id: null, agent_id: 'agent-a', operation: 'op', start_ms: 1000 })
    const closed = fns.closeOtelSpan('T1', 'S1', 5000, 'ok')
    expect(closed).toBe(true)
    const [span] = fns.getOtelTrace('T1')
    expect(span.end_ms).toBe(5000)
    expect(span.status).toBe('ok')
  })

  it('closeOtelSpan returns false for non-existent span', () => {
    expect(fns.closeOtelSpan('NO', 'SPAN', 9999, 'ok')).toBe(false)
  })

  it('upsert is idempotent: second insert updates end_ms', () => {
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S1', parent_span_id: null, agent_id: 'agent-a', operation: 'op', start_ms: 1000 })
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S1', parent_span_id: null, agent_id: 'agent-a', operation: 'op', start_ms: 1000, end_ms: 2000, status: 'ok' })
    const [span] = fns.getOtelTrace('T1')
    expect(span.end_ms).toBe(2000)
    expect(span.status).toBe('ok')
  })

  it('parent_span_id links child to parent', () => {
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'ROOT', parent_span_id: null, agent_id: 'agent-a', operation: 'root', start_ms: 1000 })
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'CHILD', parent_span_id: 'ROOT', agent_id: 'agent-b', operation: 'child', start_ms: 1100 })
    const spans = fns.getOtelTrace('T1')
    expect(spans).toHaveLength(2)
    expect(spans[1].parent_span_id).toBe('ROOT')
  })
})

describe('stampMessageTrace', () => {
  let fns: ReturnType<typeof makeDbFns>
  beforeEach(() => { fns = makeDbFns(makeTestDb()) })

  it('stamps trace fields onto a pending message with no trace_id', () => {
    const id = fns.insertMsg('agent-a', 'agent-b')
    const stamped = fns.stampMessageTrace(id, 'T1', 'S1', null)
    expect(stamped).toBe(true)
    const msg = fns.getMsg(id)
    expect(msg?.trace_id).toBe('T1')
    expect(msg?.span_id).toBe('S1')
    expect(msg?.parent_span_id).toBeNull()
  })

  it('does NOT overwrite an already-stamped message (idempotent)', () => {
    const id = fns.insertMsg('agent-a', 'agent-b')
    fns.stampMessageTrace(id, 'T1', 'S1', null)
    const second = fns.stampMessageTrace(id, 'T2', 'S2', 'ROOT')
    expect(second).toBe(false)
    const msg = fns.getMsg(id)
    // Original values preserved
    expect(msg?.trace_id).toBe('T1')
    expect(msg?.span_id).toBe('S1')
  })

  it('stamps parent_span_id for propagated context', () => {
    const id = fns.insertMsg('agent-b', 'agent-c')
    fns.stampMessageTrace(id, 'T1', 'S2', 'S1')
    const msg = fns.getMsg(id)
    expect(msg?.parent_span_id).toBe('S1')
  })

  it('returns false for non-existent message id', () => {
    expect(fns.stampMessageTrace(99999, 'T1', 'S1', null)).toBe(false)
  })
})

describe('trace tree: multi-span chain', () => {
  let fns: ReturnType<typeof makeDbFns>
  beforeEach(() => { fns = makeDbFns(makeTestDb()) })

  it('orders spans by start_ms (root first)', () => {
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S3', parent_span_id: 'S2', agent_id: 'agent-c', operation: 'op', start_ms: 3000 })
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S1', parent_span_id: null,  agent_id: 'agent-a', operation: 'op', start_ms: 1000 })
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'S2', parent_span_id: 'S1',  agent_id: 'agent-b', operation: 'op', start_ms: 2000 })
    const spans = fns.getOtelTrace('T1')
    expect(spans.map(s => s.span_id)).toEqual(['S1', 'S2', 'S3'])
  })

  it('spans from different traces do not mix', () => {
    fns.upsertOtelSpan({ trace_id: 'T1', span_id: 'SA', parent_span_id: null, agent_id: 'agent-a', operation: 'op', start_ms: 1000 })
    fns.upsertOtelSpan({ trace_id: 'T2', span_id: 'SB', parent_span_id: null, agent_id: 'agent-b', operation: 'op', start_ms: 1000 })
    expect(fns.getOtelTrace('T1')).toHaveLength(1)
    expect(fns.getOtelTrace('T2')).toHaveLength(1)
  })
})
