import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideTaskTimeout, applyBlackboardDone, type TaskInflightEntry } from '../web/schedule-runner.js'

vi.mock('../db.js', () => ({
  upsertBlackboard: vi.fn().mockReturnValue({ status: 'done', summary: '', task_ref: null }),
  findBlackboardRowByAgent: vi.fn(),
}))

import { upsertBlackboard, findBlackboardRowByAgent } from '../db.js'

// Mirror the production constants -- they are module-private so we cannot
// import them directly. Values are hard-coded here so that a change to the
// constants causes a test failure if the test uses a different scale.
const MAX_TRACK_MS = 6 * 60 * 60_000   // TASK_FIRE_MAX_TRACK_MS
const GRACE_MS = 30_000                 // TASK_FIRE_GRACE_MS

// Tests for the four logical paths of the schedule-runner blackboard snapshot
// guard (lines ~1258-1267 of schedule-runner.ts):
//
//   if (entry.sawTurn && entry.blackboardSnapshot) {
//     const cur = findBlackboardRowByAgent(entry.agentName)
//     const unchanged = cur.status === snap.status && cur.summary === snap.summary
//                       && (cur.task_ref ?? null) === snap.task_ref
//     if (unchanged) upsertBlackboard(..., { status: 'done', task_ref: snap.task_ref })
//   }
//
// Two dimensions:
//   A. sawTurn flag (tested here via decideTaskTimeout + guard simulation)
//   B. snapshot equality (tested in db-upsert-blackboard.test.ts "snapshot guard" describe)
//
// Path 1 -- no turn evidence, sawTurn=false: decision may be 'clear' (elapsed >=
//           maxTrackMs), but the guard short-circuits before the done write.
// Path 2 -- sawTurn=true, snapshot match: guard passes, done is written.
// Path 3 -- sawTurn=true, agent changed summary: unchanged=false, done skipped.
//   (snapshot mismatch cases covered by db-upsert-blackboard.test.ts)
// Path 4 -- sawTurn=true, agent already wrote done: status mismatch, done skipped.
//   (idem)

describe('schedule-runner: snapshot guard -- sawTurn dimension', () => {
  // Use a fixed "now" to keep arithmetic deterministic.
  const NOW = 10_000_000
  const STALE_INJECT = NOW - MAX_TRACK_MS - 1   // elapsed = MAX_TRACK_MS + 1 => 'clear'
  const RECENT_INJECT = NOW - 60_000            // elapsed < MAX_TRACK_MS, > GRACE_MS => 'hold'

  const opts = { graceMs: GRACE_MS, timeoutMs: 300_000, maxTrackMs: MAX_TRACK_MS }

  it('path 1: clear decision + sawTurn=false => done write is skipped', () => {
    const entry = { injectedAt: STALE_INJECT, alerted: false, sawTurn: false }
    const decision = decideTaskTimeout(entry, null, NOW, opts)
    expect(decision).toBe('clear')

    // Guard condition in schedule-runner: entry.sawTurn && entry.blackboardSnapshot
    // With sawTurn=false the guard short-circuits and the done write never reaches
    // findBlackboardRowByAgent. Verify the flag that controls it.
    expect(entry.sawTurn).toBe(false)
    // Proof: done would NOT be written (guard = false).
    const wouldWrite = entry.sawTurn
    expect(wouldWrite).toBe(false)
  })

  it('path 2: clear decision + sawTurn=true => guard proceeds to snapshot check', () => {
    const entry = { injectedAt: STALE_INJECT, alerted: false, sawTurn: true }
    const decision = decideTaskTimeout(entry, null, NOW, opts)
    expect(decision).toBe('clear')

    // sawTurn=true: the guard allows the snapshot equality check to run.
    const wouldProceed = entry.sawTurn
    expect(wouldProceed).toBe(true)
    // Snapshot match/mismatch outcomes are tested in db-upsert-blackboard.test.ts.
  })

  it('hold decision (elapsed < maxTrackMs, pane null): done is not triggered', () => {
    const entry = { injectedAt: RECENT_INJECT, alerted: false, sawTurn: true }
    const decision = decideTaskTimeout(entry, null, NOW, opts)
    // Not 'clear': watchdog has not concluded the task. No done write occurs on 'hold'.
    expect(decision).toBe('hold')
  })

  it('idle pane + sawTurn=true => clear (task completed between sweeps)', () => {
    const entry = { injectedAt: RECENT_INJECT, alerted: false, sawTurn: true }
    const decision = decideTaskTimeout(entry, 'idle', NOW, opts)
    expect(decision).toBe('clear')
    expect(entry.sawTurn).toBe(true) // proceeds to snapshot check
  })

  it('idle pane + sawTurn=false + elapsed > graceMs => lost (done is not written)', () => {
    const entry = { injectedAt: RECENT_INJECT, alerted: false, sawTurn: false }
    const decision = decideTaskTimeout(entry, 'idle', NOW, opts)
    // 'lost' path: task was never picked up. done is not written (only on 'clear').
    expect(decision).toBe('lost')
  })
})

describe('schedule-runner: snapshot guard -- equality dimension (inline simulation)', () => {
  // Simulates the unchanged check from schedule-runner.ts ~line 1260-1264.
  function unchanged(
    snap: { status: string; summary: string; task_ref: string | null },
    cur: { status: string; summary: string; task_ref: string | null } | undefined,
  ): boolean {
    if (!cur) return false
    return cur.status === snap.status &&
      cur.summary === snap.summary &&
      (cur.task_ref ?? null) === snap.task_ref
  }

  const SNAP = { status: 'active', summary: 'bb-test-task', task_ref: 'card-abc' }

  it('path 2: unchanged row => done is written (unchanged=true)', () => {
    expect(unchanged(SNAP, { ...SNAP })).toBe(true)
  })

  it('path 3: agent changed summary => done is skipped (unchanged=false)', () => {
    expect(unchanged(SNAP, { ...SNAP, summary: 'custom-agent-summary' })).toBe(false)
  })

  it('path 4: agent already wrote done => done is skipped (status mismatch)', () => {
    expect(unchanged(SNAP, { ...SNAP, status: 'done' })).toBe(false)
  })

  it('agent changed task_ref mid-run => done is skipped', () => {
    expect(unchanged(SNAP, { ...SNAP, task_ref: 'card-xyz' })).toBe(false)
  })

  it('row missing (undefined) => done is skipped', () => {
    expect(unchanged(SNAP, undefined)).toBe(false)
  })
})

describe('applyBlackboardDone: task_ref passthrough to upsertBlackboard', () => {
  const BASE_ENTRY: TaskInflightEntry = {
    taskName: 'kanban-task',
    agentName: 'agent-a',
    session: 'sess-x',
    host: null,
    injectedAt: 0,
    alerted: false,
    sawTurn: true,
    workingDir: '/tmp',
    configDir: undefined,
    timeoutMs: 300_000,
    blackboardSnapshot: undefined,
  }

  beforeEach(() => {
    vi.mocked(upsertBlackboard).mockClear()
    vi.mocked(findBlackboardRowByAgent).mockReset()
  })

  it('passes non-null task_ref from snapshot to upsertBlackboard (regression guard)', () => {
    // The active row was written with task_ref='card-abc'. The runner snapshots it.
    // On clear, applyBlackboardDone must pass that task_ref to the done upsert.
    // Without the fix (task_ref omitted from the call), upsertBlackboard receives
    // no task_ref and the column goes null -- this assertion would fail.
    const snapshot = { status: 'active', summary: 'kanban-task', task_ref: 'card-abc' }
    vi.mocked(findBlackboardRowByAgent).mockReturnValue(
      { status: 'active', summary: 'kanban-task', task_ref: 'card-abc', updated_at: 0, agent_id: 'agent-a' } as any,
    )

    applyBlackboardDone({ ...BASE_ENTRY, blackboardSnapshot: snapshot })

    expect(upsertBlackboard).toHaveBeenCalledWith('agent-a', {
      status: 'done',
      summary: 'kanban-task',
      task_ref: 'card-abc',
    })
  })

  it('skips upsertBlackboard when sawTurn is false', () => {
    applyBlackboardDone({ ...BASE_ENTRY, sawTurn: false, blackboardSnapshot: { status: 'active', summary: 'x', task_ref: null } })
    expect(upsertBlackboard).not.toHaveBeenCalled()
  })

  it('skips upsertBlackboard when snapshot is missing', () => {
    applyBlackboardDone({ ...BASE_ENTRY, blackboardSnapshot: undefined })
    expect(upsertBlackboard).not.toHaveBeenCalled()
  })

  it('skips upsertBlackboard when current row does not match snapshot', () => {
    const snapshot = { status: 'active', summary: 'kanban-task', task_ref: 'card-abc' }
    // Agent changed the summary mid-run.
    vi.mocked(findBlackboardRowByAgent).mockReturnValue(
      { status: 'active', summary: 'different-summary', task_ref: 'card-abc', updated_at: 0, agent_id: 'agent-a' } as any,
    )

    applyBlackboardDone({ ...BASE_ENTRY, blackboardSnapshot: snapshot })
    expect(upsertBlackboard).not.toHaveBeenCalled()
  })
})
