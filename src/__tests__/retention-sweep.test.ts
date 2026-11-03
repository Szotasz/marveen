import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// The four retention settings are opt-in (default 0 = keep forever). Most
// cases below exercise the prunes as an owner who switched them on, so the
// settings layer is stubbed per key: a key present in `retention` answers with
// that value, anything else (or a deleted key) falls through to the real
// override > .env > registry-default resolution. Stubbing beats setOverride()
// here, which would write config-overrides.json into the real store.
const { retention } = vi.hoisted(() => ({ retention: {} as Record<string, string | number> }))
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key in retention ? retention[key] : actual.getEffectiveSettingValue(key),
  }
})

const RETENTION_KEYS = [
  'CONVERSATION_LOG_RETENTION_DAYS',
  'OTEL_SPAN_RETENTION_DAYS',
  'AGENT_MESSAGE_RETENTION_DAYS',
  'TOOL_CALL_LOG_RETENTION_DAYS',
] as const

// The suggested windows the registry descriptions name.
const SWITCHED_ON: Record<(typeof RETENTION_KEYS)[number], number> = {
  CONVERSATION_LOG_RETENTION_DAYS: 90,
  OTEL_SPAN_RETENTION_DAYS: 14,
  AGENT_MESSAGE_RETENTION_DAYS: 30,
  TOOL_CALL_LOG_RETENTION_DAYS: 30,
}

function switchRetentionOn() {
  Object.assign(retention, SWITCHED_ON)
}
function clearRetentionStubs() {
  for (const k of Object.keys(retention)) delete retention[k]
}
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
import { getSettingDefinition } from '../config-registry.js'

const DAY = 86400

beforeAll(() => {
  // In-memory, so the sweep under test can never delete rows from the real
  // store/claudeclaw.db (these prunes are agent-agnostic DELETEs -- they would
  // happily eat production history).
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// Default for every case: the owner has switched retention on at the suggested
// windows. The "off by default" block below clears this again.
beforeEach(() => {
  clearRetentionStubs()
  switchRetentionOn()
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

  function seedOldAndFresh() {
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
  }

  it('runs all four retention prunes when switched on: old rows go, fresh and in-flight rows stay', () => {
    seedOldAndFresh()
    const db = getDb()

    runDecaySweep()

    const col = (sql: string) => (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => Object.values(r)[0])
    expect(col('SELECT message_id FROM conversation_log ORDER BY message_id')).toEqual(['conv-fresh'])
    expect(col('SELECT span_id FROM otel_spans ORDER BY span_id')).toEqual(['span-fresh'])
    expect(col('SELECT id FROM agent_messages ORDER BY id')).toEqual([2, 3, 4])
    expect(col('SELECT session_id FROM tool_call_log ORDER BY session_id')).toEqual(['tool-fresh'])
  })

  it('deletes nothing with all four settings at their default (unset), however old the rows', () => {
    // An install whose owner never switched retention on must keep its full
    // history: the conversation log doubles as an audit source.
    clearRetentionStubs()
    seedOldAndFresh()
    const db = getDb()
    const yearOld = NOW() - 365 * DAY
    db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
       VALUES ('test-agent', 'chat-1', 'in', 'conv-year', 'x', '2025-01-01T00:00:00Z', ?)`,
    ).run(yearOld)
    db.prepare(
      `INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
       VALUES ('trace-1', 'span-year', 'test-agent', 'op', ?, 'ok')`,
    ).run(yearOld * 1000)
    db.prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at)
       VALUES (5, 'a', 'b', 'x', 'failed', ?)`,
    ).run(yearOld)
    db.prepare(
      `INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at)
       VALUES ('tool-year', 'Bash', 'x', 1, ?)`,
    ).run(yearOld)

    runDecaySweep()

    const col = (sql: string) => (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => Object.values(r)[0])
    expect(col('SELECT message_id FROM conversation_log ORDER BY message_id')).toEqual([
      'conv-fresh',
      'conv-old',
      'conv-year',
    ])
    expect(col('SELECT span_id FROM otel_spans ORDER BY span_id')).toEqual(['span-fresh', 'span-old', 'span-year'])
    expect(col('SELECT id FROM agent_messages ORDER BY id')).toEqual([1, 2, 3, 4, 5])
    expect(col('SELECT session_id FROM tool_call_log ORDER BY session_id')).toEqual([
      'tool-fresh',
      'tool-old',
      'tool-year',
    ])
  })
})

describe('retention is off by default (0 = keep forever)', () => {
  beforeEach(() => {
    clearRetentionStubs()
    getDb().exec(
      'DELETE FROM conversation_log; DELETE FROM otel_spans; DELETE FROM agent_messages; DELETE FROM tool_call_log',
    )
  })

  function seedYearOld() {
    const db = getDb()
    const yearOld = NOW() - 365 * DAY
    db.prepare(
      `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
       VALUES ('test-agent', 'chat-1', 'in', 'conv-year', 'x', '2025-01-01T00:00:00Z', ?)`,
    ).run(yearOld)
    db.prepare(
      `INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, status)
       VALUES ('trace-1', 'span-year', 'test-agent', 'op', ?, 'ok')`,
    ).run(yearOld * 1000)
    db.prepare(
      `INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at)
       VALUES (1, 'a', 'b', 'x', 'done', ?)`,
    ).run(yearOld)
    db.prepare(
      `INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at)
       VALUES ('tool-year', 'Bash', 'x', 1, ?)`,
    ).run(yearOld)
  }

  function counts() {
    const db = getDb()
    const c = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
    return [c('conversation_log'), c('otel_spans'), c('agent_messages'), c('tool_call_log')]
  }

  it('the registry default of all four settings is 0', () => {
    for (const key of RETENTION_KEYS) expect(getSettingDefinition(key)?.default).toBe(0)
  })

  it.each([
    ['explicit 0', 0],
    ['an empty .env value', ''],
    ['a value that does not parse', 'NaN'],
  ])('every prune is a no-op with %s', (_label, value) => {
    for (const key of RETENTION_KEYS) retention[key] = value
    seedYearOld()

    expect(pruneConversationLog()).toBe(0)
    expect(pruneOtelSpans()).toBe(0)
    expect(pruneAgentMessages()).toBe(0)
    expect(pruneToolCallLogRetention()).toBe(0)
    expect(counts()).toEqual([1, 1, 1, 1])
  })

  it('switching one table on prunes only that table', () => {
    retention.CONVERSATION_LOG_RETENTION_DAYS = 90
    seedYearOld()

    runDecaySweep()

    expect(counts()).toEqual([0, 1, 1, 1])
  })
})
