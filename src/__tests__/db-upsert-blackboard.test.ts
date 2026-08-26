import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, upsertBlackboard, findBlackboardRowByAgent, listBlackboardHistory } from '../db.js'

// Test upsertBlackboard against the real exported function with an in-memory
// SQLite database. This is the guard that mocked-route tests cannot provide:
// if the change-detection or history-write logic inside upsertBlackboard is
// broken, these tests catch it even when route-level mocks are all green.

beforeEach(() => {
  initDatabase(':memory:')
})

describe('upsertBlackboard: no-op guard', () => {
  it('does not write a history row when the same values are posted twice', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'task-x', task_ref: null })
    upsertBlackboard('agent-a', { status: 'active', summary: 'task-x', task_ref: null })

    const history = listBlackboardHistory({ agent_id: 'agent-a' })
    // Only the first insert should create a history entry; the second is a no-op.
    expect(history).toHaveLength(1)
    expect((history[0] as { status: string }).status).toBe('active')
  })

  it('writes a history row when status changes from active to done', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'task-x', task_ref: null })
    upsertBlackboard('agent-a', { status: 'done',   summary: 'task-x', task_ref: null })

    const history = listBlackboardHistory({ agent_id: 'agent-a' })
    expect(history).toHaveLength(2)
    const statuses = (history as { status: string }[]).map(r => r.status).sort()
    expect(statuses).toEqual(['active', 'done'])
  })

  it('writes a history row when summary changes', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'old summary', task_ref: null })
    upsertBlackboard('agent-a', { status: 'active', summary: 'new summary', task_ref: null })

    const history = listBlackboardHistory({ agent_id: 'agent-a' })
    expect(history).toHaveLength(2)
    const summaries = (history as { summary: string }[]).map(r => r.summary).sort()
    expect(summaries).toEqual(['new summary', 'old summary'])
  })

  it('writes a history row when task_ref changes', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'task-x', task_ref: null })
    upsertBlackboard('agent-a', { status: 'active', summary: 'task-x', task_ref: 'card-001' })

    const history = listBlackboardHistory({ agent_id: 'agent-a' })
    expect(history).toHaveLength(2)
  })

  it('keeps current row status after a no-op upsert', () => {
    upsertBlackboard('agent-a', { status: 'blocked', summary: 'stuck on X', task_ref: null })
    upsertBlackboard('agent-a', { status: 'blocked', summary: 'stuck on X', task_ref: null })

    const row = findBlackboardRowByAgent('agent-a')
    expect(row?.status).toBe('blocked')
    expect(row?.summary).toBe('stuck on X')
  })
})

describe('upsertBlackboard: snapshot guard (schedule-runner done-write protection)', () => {
  it('done is written when current row matches the active snapshot', () => {
    const row = upsertBlackboard('agent-b', { status: 'active', summary: 'heartbeat-daily', task_ref: null })
    const snapshot = { status: row.status, summary: row.summary, task_ref: row.task_ref ?? null }

    const cur = findBlackboardRowByAgent('agent-b')!
    const unchanged =
      cur.status === snapshot.status &&
      cur.summary === snapshot.summary &&
      (cur.task_ref ?? null) === snapshot.task_ref

    expect(unchanged).toBe(true)

    // Runner would write done here -- verify it lands and creates a history entry.
    upsertBlackboard('agent-b', { status: 'done', summary: 'heartbeat-daily', task_ref: null })
    const history = listBlackboardHistory({ agent_id: 'agent-b' }) as { status: string }[]
    expect(history).toHaveLength(2)
    expect(history.map(r => r.status).sort()).toEqual(['active', 'done'])
  })

  it('done write preserves a non-null task_ref from the active snapshot', () => {
    // Active row starts with a real kanban card ref. The runner snapshots it, then
    // writes done passing task_ref from the snapshot. Without the fix the done call
    // had no task_ref argument and the column silently became null.
    const row = upsertBlackboard('agent-b', { status: 'active', summary: 'kanban-task', task_ref: 'card-abc' })
    expect(row.task_ref).toBe('card-abc')

    // Simulate runner done write with task_ref preserved from snapshot.
    const doneRow = upsertBlackboard('agent-b', { status: 'done', summary: 'kanban-task', task_ref: row.task_ref ?? null })
    expect(doneRow.task_ref).toBe('card-abc')

    // Verify the live row also carries the value (not just the return value).
    const cur = findBlackboardRowByAgent('agent-b')!
    expect(cur.task_ref).toBe('card-abc')
    expect(cur.status).toBe('done')
  })

  it('done is NOT written when agent changed status to blocked mid-run', () => {
    const row = upsertBlackboard('agent-b', { status: 'active', summary: 'heartbeat-daily', task_ref: null })
    const snapshot = { status: row.status, summary: row.summary, task_ref: row.task_ref ?? null }

    // Agent switches to blocked while task is running.
    upsertBlackboard('agent-b', { status: 'blocked', summary: 'waiting for external API', task_ref: null })

    const cur = findBlackboardRowByAgent('agent-b')!
    const unchanged =
      cur.status === snapshot.status &&
      cur.summary === snapshot.summary &&
      (cur.task_ref ?? null) === snapshot.task_ref

    // Snapshot mismatch -- runner must skip the done write.
    expect(unchanged).toBe(false)
    expect(cur.status).toBe('blocked')

    // The history should have active and blocked entries; done must NOT appear.
    const history = listBlackboardHistory({ agent_id: 'agent-b' }) as { status: string }[]
    expect(history.map(r => r.status).sort()).toEqual(['active', 'blocked'])
  })
})

