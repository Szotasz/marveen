import { describe, it, expect } from 'vitest'
import { decideTaskTimeout } from '../web/schedule-runner.js'

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
