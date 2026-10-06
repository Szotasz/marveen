// APRO920 (c)(1): the model distribution endpoint said "claude-sonnet-4-6,
// 227 rows" with no way to tell WHICH agent/session/task drove them (D001,
// ELSOKOR922 Phase 0 measurement). getModelSourceBreakdown / ?model= answers
// that from the API.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getModelSourceBreakdown } from '../web/token-usage.js'

function insertRow(db: ReturnType<typeof getDb>, opts: {
  agent: string
  sessionId: string
  timestamp: number
  model: string | null
  taskTitle?: string | null
  inputTokens?: number
}) {
  db.prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, task_title)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).run(opts.agent, opts.sessionId, opts.timestamp, opts.inputTokens ?? 100, opts.model, opts.taskTitle ?? null)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('getModelSourceBreakdown', () => {
  it('breaks a single model down by agent / session_id / task_title', () => {
    const db = getDb()
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-4-6', taskTitle: null })
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1010, model: 'claude-sonnet-4-6', taskTitle: null })
    insertRow(db, { agent: 'marveen', sessionId: 's2', timestamp: 1020, model: 'claude-sonnet-4-6', taskTitle: 'kanban-audit' })
    insertRow(db, { agent: 'samu', sessionId: 's3', timestamp: 1030, model: 'claude-sonnet-5', taskTitle: null })

    const rows = getModelSourceBreakdown('claude-sonnet-4-6')
    expect(rows).toHaveLength(2)
    const bySession = new Map(rows.map((r) => [r.sessionId, r]))
    expect(bySession.get('s1')?.count).toBe(2)
    expect(bySession.get('s1')?.agent).toBe('marveen')
    expect(bySession.get('s1')?.taskTitle).toBeNull()
    expect(bySession.get('s2')?.count).toBe(1)
    expect(bySession.get('s2')?.taskTitle).toBe('kanban-audit')
    // claude-sonnet-5 row must not leak in
    expect(rows.every((r) => r.sessionId !== 's3')).toBe(true)
  })

  it('an unknown model yields an empty breakdown, not an error', () => {
    const db = getDb()
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-5' })
    expect(getModelSourceBreakdown('no-such-model')).toEqual([])
  })

  it('respects the from/to time window', () => {
    const db = getDb()
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-4-6' })
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 5000, model: 'claude-sonnet-4-6' })
    const rows = getModelSourceBreakdown('claude-sonnet-4-6', 900, 2000)
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(1)
  })

  it('sums tokens across the group', () => {
    const db = getDb()
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-4-6', inputTokens: 100 })
    insertRow(db, { agent: 'marveen', sessionId: 's1', timestamp: 1010, model: 'claude-sonnet-4-6', inputTokens: 50 })
    const rows = getModelSourceBreakdown('claude-sonnet-4-6')
    expect(rows[0].totalTokens).toBe(150)
    expect(rows[0].firstSeen).toBe(1000)
    expect(rows[0].lastSeen).toBe(1010)
  })
})
