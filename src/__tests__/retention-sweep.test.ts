import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  pruneConversationLog,
  pruneOtelSpans,
  pruneAgentMessages,
  pruneToolCallLogRetention,
  checkpointAndCompact,
} from '../db.js'
import { runDecaySweep } from '../memory.js'

const DAY = 86400

beforeAll(() => {
  // In-memory, so the sweep under test can never delete rows from the real
  // store/claudeclaw.db (these prunes are agent-agnostic DELETEs -- they would
  // happily eat production history).
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const NOW = () => Math.floor(Date.now() / 1000)

describe('pruneConversationLog', () => {
  function insert(messageId: string, ageDays: number) {
    getDb()
      .prepare(
        `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
         VALUES ('test-agent', 'chat-1', 'in', ?, 'x', '2026-01-01T00:00:00Z', ?)`,
      )
      .run(messageId, NOW() - ageDays * DAY)
  }

  beforeEach(() => getDb().exec('DELETE FROM conversation_log'))

  it('deletes rows past the 90 day window and keeps the rest', () => {
    insert('m-ancient', 400)
    insert('m-just-over', 91)
    insert('m-just-under', 89)
    insert('m-today', 0)

    expect(pruneConversationLog()).toBe(2)

    const left = getDb()
      .prepare('SELECT message_id FROM conversation_log ORDER BY message_id')
      .all() as Array<{ message_id: string }>
    expect(left.map((r) => r.message_id)).toEqual(['m-just-under', 'm-today'])
  })

  it('is a no-op on a fresh table', () => {
    insert('m-fresh', 1)
    expect(pruneConversationLog()).toBe(0)
  })
})

describe('pruneOtelSpans', () => {
  // start_ms is MILLISECONDS here, unlike every other table in the sweep --
  // getting that wrong makes the cutoff off by a factor of 1000, which either
  // deletes everything or nothing. These cases pin the unit down.
  function insert(spanId: string, ageDays: number, status = 'ok') {
    getDb()
      .prepare(
        `INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
         VALUES ('trace-1', ?, 'test-agent', 'op', ?, ?)`,
      )
      .run(spanId, Date.now() - ageDays * DAY * 1000, status)
  }

  beforeEach(() => getDb().exec('DELETE FROM otel_spans'))

  it('deletes spans past the 14 day window', () => {
    insert('s-old', 30)
    insert('s-just-over', 15)
    insert('s-just-under', 13)

    expect(pruneOtelSpans()).toBe(2)

    const left = getDb().prepare('SELECT span_id FROM otel_spans').all() as Array<{ span_id: string }>
    expect(left.map((r) => r.span_id)).toEqual(['s-just-under'])
  })

  it("prunes leaked 'running' spans too", () => {
    insert('s-leaked', 30, 'running')
    expect(pruneOtelSpans()).toBe(1)
  })

  it('keeps a recent span that is still running', () => {
    insert('s-live', 0, 'running')
    expect(pruneOtelSpans()).toBe(0)
  })
})

describe('pruneAgentMessages', () => {
  function insert(id: number, ageDays: number, status: string) {
    getDb()
      .prepare(
        `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at)
         VALUES (?, 'a', 'b', 'x', ?, ?)`,
      )
      .run(id, status, NOW() - ageDays * DAY)
  }

  beforeEach(() => getDb().exec('DELETE FROM agent_messages'))

  it('deletes settled messages past the 30 day window', () => {
    insert(1, 60, 'done')
    insert(2, 60, 'failed')
    insert(3, 5, 'done')

    expect(pruneAgentMessages()).toBe(2)
    const left = getDb().prepare('SELECT id FROM agent_messages').all() as Array<{ id: number }>
    expect(left.map((r) => r.id)).toEqual([3])
  })

  it('never deletes pending or delivered rows, however old', () => {
    // A message stuck in flight for a year is evidence of a delivery bug. It
    // has to stay visible, not get quietly swept up with the settled ones.
    insert(10, 365, 'pending')
    insert(11, 365, 'delivered')

    expect(pruneAgentMessages()).toBe(0)
    const cnt = getDb().prepare('SELECT COUNT(*) c FROM agent_messages').get() as { c: number }
    expect(cnt.c).toBe(2)
  })
})

describe('pruneToolCallLogRetention', () => {
  function insert(sessionId: string, ageDays: number) {
    getDb()
      .prepare(
        `INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at)
         VALUES (?, 'Bash', 'x', 1, ?)`,
      )
      .run(sessionId, NOW() - ageDays * DAY)
  }

  beforeEach(() => getDb().exec('DELETE FROM tool_call_log'))

  it('honours the 30 day retention instead of the 24h manual-purge default', () => {
    insert('s-old', 45)
    insert('s-mid', 10) // older than the 86400s default, inside the retention
    insert('s-new', 0)

    expect(pruneToolCallLogRetention()).toBe(1)
    const left = getDb().prepare('SELECT session_id FROM tool_call_log ORDER BY session_id').all() as Array<{
      session_id: string
    }>
    expect(left.map((r) => r.session_id)).toEqual(['s-mid', 's-new'])
  })
})

describe('checkpointAndCompact', () => {
  it('returns a result and never throws, even without a WAL file', () => {
    const result = checkpointAndCompact()
    expect(result).toMatchObject({
      checkpointBusy: expect.any(Boolean),
      vacuumed: expect.any(Boolean),
      freePagesBefore: expect.any(Number),
    })
  })

  it('skips VACUUM on a database with no meaningful free space', () => {
    // Fresh in-memory DB: nothing has been deleted, so there is nothing to
    // reclaim and the gate must hold the (exclusive-lock, full-rewrite) VACUUM.
    expect(checkpointAndCompact().vacuumed).toBe(false)
  })
})

describe('runDecaySweep (the daily entry point)', () => {
  // The prune tests above call each prune directly, so they would stay green if
  // the daily sweep stopped calling them. This drives the real entry point that
  // index.ts schedules, with an old and a fresh row in every table.
  beforeEach(() => {
    getDb().exec(
      'DELETE FROM conversation_log; DELETE FROM otel_spans; DELETE FROM agent_messages; DELETE FROM tool_call_log',
    )
  })

  it('runs all four retention prunes: old rows go, fresh and in-flight rows stay', () => {
    const now = NOW()
    const db = getDb()
    const conv = db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
       VALUES ('test-agent', 'chat-1', 'in', ?, 'x', '2026-01-01T00:00:00Z', ?)`,
    )
    conv.run('conv-old', now - 120 * DAY)
    conv.run('conv-fresh', now)

    const span = db.prepare(
      `INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
       VALUES ('trace-1', ?, 'test-agent', 'op', ?, 'ok')`,
    )
    span.run('span-old', Date.now() - 30 * DAY * 1000)
    span.run('span-fresh', Date.now())

    const msg = db.prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at)
       VALUES (?, 'a', 'b', 'x', ?, ?)`,
    )
    msg.run(1, 'done', now - 60 * DAY)
    msg.run(2, 'done', now)
    msg.run(3, 'pending', now - 365 * DAY)
    msg.run(4, 'delivered', now - 365 * DAY)

    const tool = db.prepare(
      `INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at)
       VALUES (?, 'Bash', 'x', 1, ?)`,
    )
    tool.run('tool-old', now - 45 * DAY)
    tool.run('tool-fresh', now)

    runDecaySweep()

    const col = (sql: string) => (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => Object.values(r)[0])
    expect(col('SELECT message_id FROM conversation_log ORDER BY message_id')).toEqual(['conv-fresh'])
    expect(col('SELECT span_id FROM otel_spans ORDER BY span_id')).toEqual(['span-fresh'])
    expect(col('SELECT id FROM agent_messages ORDER BY id')).toEqual([2, 3, 4])
    expect(col('SELECT session_id FROM tool_call_log ORDER BY session_id')).toEqual(['tool-fresh'])
  })
})
