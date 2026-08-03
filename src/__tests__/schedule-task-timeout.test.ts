import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideTaskTimeout, resolveStuckTimeoutMs, TASK_FIRE_GRACE_MS, TASK_FIRE_TIMEOUT_MS } from '../web/schedule-runner.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

// Tests for the post-fire timeout watchdog.
//
// The watchdog detects a scheduled task/heartbeat that was injected into a
// tmux session and is still running (session busy) past TASK_FIRE_TIMEOUT_MS.
// It closes the gap in the pending_task_retries path, which only triggers when
// a NEW task tries to inject into the already-busy session.
//
// decideTaskTimeout is pure (no I/O, no Map), so the decision logic is fully
// exercisable here without tmux mocks. The fix-revert test at the bottom
// guards against the test becoming a false guard.

const GRACE = TASK_FIRE_GRACE_MS   // 30_000
const TIMEOUT = TASK_FIRE_TIMEOUT_MS // 300_000
const MAX_TRACK = 6 * 60 * 60_000   // 6 hours

const BASE_OPTS = { graceMs: GRACE, timeoutMs: TIMEOUT, maxTrackMs: MAX_TRACK }

function makeEntry(overrides: Partial<Pick<TaskInflightEntry, 'injectedAt' | 'alerted'>> = {}): Pick<TaskInflightEntry, 'injectedAt' | 'alerted'> {
  return { injectedAt: 0, alerted: false, ...overrides }
}

// --- Grace period ---

describe('decideTaskTimeout: grace period', () => {
  it('holds during the grace window even when the pane is busy', () => {
    const entry = makeEntry({ injectedAt: 1000 })
    const now = 1000 + GRACE - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('holds at exactly the grace boundary (< timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Idle clear ---

describe('decideTaskTimeout: idle clear', () => {
  it('clears immediately when the pane is idle (task completed before timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('clears even before the grace period if somehow idle', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE - 5000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('clears when idle even after the timeout has elapsed', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Timeout alert (the load-bearing case) ---

describe('decideTaskTimeout: timeout alert', () => {
  it('alerts when the session is still busy past the timeout threshold', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('alerts at a much later elapsed time if still busy', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT * 3
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('holds when elapsed is exactly one ms below the timeout', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Already alerted (one-shot) ---

describe('decideTaskTimeout: one-shot alert flag', () => {
  it('holds after the first alert has been sent (no repeat alerts)', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('still clears when idle even after alerted', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Non-busy pane states ---

describe('decideTaskTimeout: non-busy pane states hold (owned by other watchdogs)', () => {
  const pastTimeout = TIMEOUT + 1000

  it('holds on unknown (session may be restarting)', () => {
    expect(decideTaskTimeout(makeEntry(), 'unknown', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on null capture (no signal -- be conservative)', () => {
    expect(decideTaskTimeout(makeEntry(), null, pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on error (thinking-block API error -- channel-monitor owns that)', () => {
    expect(decideTaskTimeout(makeEntry(), 'error', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on typing (post-send resubmit loop is active)', () => {
    expect(decideTaskTimeout(makeEntry(), 'typing', pastTimeout, BASE_OPTS)).toBe('hold')
  })
})

// --- Max track age eviction ---

describe('decideTaskTimeout: max tracking age', () => {
  it('evicts the entry regardless of pane state after maxTrackMs', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('clear')
  })

  it('evicts even if the pane is unknown at max age', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'unknown', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Fix-revert guard ---
//
// This test verifies the test is a REAL guard: if the 'alert' case were
// removed from decideTaskTimeout (returning 'hold' for all busy states),
// the test below would turn RED. A test that stays green after the fix is
// reverted is a false guard and must be discarded.
//
// How to verify: temporarily change decideTaskTimeout so it never returns
// 'alert' (comment out the `if (paneState === 'busy' && elapsed >= ...) return 'alert'`
// line) and confirm this test fails.

describe('fix-revert guard: alert case is load-bearing', () => {
  it('returns alert for a busy session past the threshold -- proves the alert branch fires', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const result = decideTaskTimeout(entry, 'busy', TIMEOUT + 1, BASE_OPTS)
    // If the fix (the alert branch) were removed, result would be 'hold' and
    // this assertion would fail: that is the correct behaviour.
    expect(result).toBe('alert')
    expect(result).not.toBe('hold')
  })
})

// --- Per-task stuck threshold ---
//
// TASK_FIRE_TIMEOUT_MS is one global number. It is the right default for the
// common case (a short-cadence heartbeat still busy after 5 minutes IS a real
// signal) and wrong for a task whose whole job is to think for a while: a
// nightly analysis run was declared a "possible hang" five minutes in, on
// 2026-07-30 at 02:12, and finished normally at 02:18. The operator got a
// false alarm about a task doing exactly what it was written to do.
describe('resolveStuckTimeoutMs: the threshold is per task', () => {
  const MIN = 60_000

  it('falls back to the global default when unset', () => {
    expect(resolveStuckTimeoutMs({})).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('honours an explicit longer budget (the nightly analysis case)', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 20 })).toBe(20 * MIN)
  })

  it('a malformed or non-positive value falls back to the default, never to NaN', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: NaN })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: -5 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 'twenty' as unknown as number })).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('clamps below one minute so the alert cannot fire inside startup noise', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0.1 })).toBe(MIN)
  })

  it('clamps to the tracking window, so a huge value cannot silently disable the alert', () => {
    // Entries are evicted at maxTrackMs regardless, so anything above it would
    // mean "never alert" while still looking like a threshold.
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 60 * 24 })).toBe(MAX_TRACK)
  })

  it('the resolved budget actually drives the decision', () => {
    const at6min = 6 * MIN
    const opts = { graceMs: GRACE, maxTrackMs: MAX_TRACK }
    // Both budgets are stated EXPLICITLY rather than leaning on the global
    // default. The claim under test is "the resolved budget drives the
    // decision", which says nothing about what the default happens to be --
    // and the default is install-configurable (TASK_STALL_TIMEOUT_MS), so an
    // install that raises it to 10 minutes would have failed this test on a
    // point it never meant to assert.
    // 5-minute budget: 6 minutes of continuous busy is a hang.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 5 }) })).toBe('alert')
    // 20-minute budget: the same 6 minutes is just work in progress.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 20 }) })).toBe('hold')
  })

  it('the sweep uses the entry budget, not the global constant (fix-revert guard)', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/timeoutMs: entry\.timeoutMs,/)
    expect(src).toMatch(/timeoutMs: resolveStuckTimeoutMs\(task\),/)
  })
})
