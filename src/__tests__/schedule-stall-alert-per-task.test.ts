// Per-task stall-alert threshold for the post-fire watchdog.
//
// The watchdog alerts when the target session is still busy TASK_FIRE_TIMEOUT_MS
// (5 minutes) after injection. That default is right for a prompt the agent
// answers in a minute, and wrong for a task that legitimately drives a headless
// browser: the nightly idea-scout takes well past five minutes because it logs
// in, loads several pages and waits on network settle. It produced a false
// "possible stall" push to the owner two nights running (2026-08-04, 2026-08-05),
// and a recurring false alarm is worse than no alarm -- it trains the reader to
// ignore the real one.
//
// The fix is a per-task override carried on the in-flight entry, so slow tasks
// get a longer fuse without blunting stall detection for everything else.
import { describe, it, expect } from 'vitest'
import { decideTaskTimeout, resolveStallTimeoutMs, TASK_FIRE_TIMEOUT_MS, TASK_FIRE_GRACE_MS, type TaskInflightEntry } from '../web/schedule-runner.js'

const MAX_TRACK = 6 * 60 * 60_000

function entry(over: Partial<TaskInflightEntry> = {}): TaskInflightEntry {
  return {
    taskName: 'idea-scout',
    agentName: 'marveen',
    session: 'agent-marveen',
    host: null,
    injectedAt: 0,
    alerted: false,
    ...over,
  }
}

function decide(e: TaskInflightEntry, elapsedMs: number) {
  return decideTaskTimeout(e, 'busy', e.injectedAt + elapsedMs, {
    graceMs: TASK_FIRE_GRACE_MS,
    timeoutMs: resolveStallTimeoutMs(e),
    maxTrackMs: MAX_TRACK,
  })
}

describe('per-task stall-alert threshold', () => {
  it('still alerts at the default when the task sets no override', () => {
    expect(decide(entry(), TASK_FIRE_TIMEOUT_MS + 1_000)).toBe('alert')
  })

  it('holds past the default when the task asks for a longer fuse', () => {
    // The browser round is 6 minutes in: busy is expected, not a stall.
    expect(decide(entry({ stallAlertMs: 20 * 60_000 }), 6 * 60_000)).toBe('hold')
  })

  it('alerts once the longer fuse itself runs out', () => {
    expect(decide(entry({ stallAlertMs: 20 * 60_000 }), 21 * 60_000)).toBe('alert')
  })

  it('does not alert twice for the same injection', () => {
    expect(decide(entry({ stallAlertMs: 20 * 60_000, alerted: true }), 21 * 60_000)).toBe('hold')
  })

  it('leaves the grace window alone regardless of the override', () => {
    // A shorter-than-grace override must not fire inside the grace window --
    // the pane is often still 'busy' from the previous turn right after inject.
    expect(decide(entry({ stallAlertMs: 1_000 }), TASK_FIRE_GRACE_MS - 1)).toBe('hold')
  })

  it('ignores a nonsense override instead of silently disabling the alarm', () => {
    // A 0 / negative / NaN value in a hand-edited config must fall back to the
    // default, not turn the watchdog off.
    expect(resolveStallTimeoutMs(entry({ stallAlertMs: 0 }))).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStallTimeoutMs(entry({ stallAlertMs: -5 }))).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStallTimeoutMs(entry({ stallAlertMs: Number.NaN }))).toBe(TASK_FIRE_TIMEOUT_MS)
  })
})
