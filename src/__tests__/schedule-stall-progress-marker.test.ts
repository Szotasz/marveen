// The post-fire watchdog measures the PANE, and the pane is shared.
//
// Every scheduled task is injected into the same tmux the agent uses for manual
// work, so "busy" answers the question "is anything happening in this session",
// not "is my task still running". Measured on 2026-08-06: a 12-second
// support-inbox round and a multi-minute docker drill produced the identical
// pane reading, and the watchdog pushed a stall alert for the inbox task while
// the agent was in fact working on something else entirely. The same class of
// false alarm hit a second consumer (the session-stuck watcher) the same day.
//
// A threshold cannot separate the two cases: short fuse -> manual work alarms,
// long fuse -> a genuine stall shows up late. The separation only exists if the
// watchdog can see THE TASK'S OWN progress. Most heartbeats already write one:
// support-inbox-figyeles rewrites store/support-inbox-state.json at the end of
// every round, kanban-audit rewrites store/kanban-audit-state.json. That file's
// mtime is the task's own life sign, independent of the pane.
//
// Contract covered here:
//   * a marker newer than the injection clears the entry, whatever the pane says
//   * a stale marker (or none) changes nothing -- the pane path stays exactly as
//     it was, so a task that never writes keeps its old coverage
//   * the marker never RAISES an alert; it can only clear one
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideTaskTimeout,
  readTaskProgressAt,
  resolveStallTimeoutMs,
  TASK_FIRE_GRACE_MS,
  type TaskInflightEntry,
} from '../web/schedule-runner.js'

const MAX_TRACK = 6 * 60 * 60_000
const INJECTED_AT = 1_000_000

function entry(over: Partial<TaskInflightEntry> = {}): TaskInflightEntry {
  return {
    taskName: 'support-inbox-figyeles',
    agentName: 'atlas',
    session: 'agent-atlas',
    host: null,
    injectedAt: INJECTED_AT,
    alerted: false,
    ...over,
  }
}

// Well past the 5-minute fuse: without a marker this is the exact situation
// that produced the false alarm.
function decide(e: TaskInflightEntry, paneState: 'busy' | 'idle' | null, progressAt: number | null) {
  return decideTaskTimeout(e, paneState, INJECTED_AT + 20 * 60_000, {
    graceMs: TASK_FIRE_GRACE_MS,
    timeoutMs: resolveStallTimeoutMs(e),
    maxTrackMs: MAX_TRACK,
    progressAt,
  })
}

describe('post-fire watchdog: the task own progress marker', () => {
  it('clears a busy pane when the task wrote its marker after injection', () => {
    expect(decide(entry(), 'busy', INJECTED_AT + 12_000)).toBe('clear')
  })

  it('still alerts on a busy pane when the marker is older than the injection', () => {
    expect(decide(entry(), 'busy', INJECTED_AT - 60_000)).toBe('alert')
  })

  it('still alerts on a busy pane when there is no marker at all', () => {
    expect(decide(entry(), 'busy', null)).toBe('alert')
  })

  it('treats a marker written in the same millisecond as no progress', () => {
    // Strictly newer only: an mtime equal to injectedAt is the previous run's
    // file, not this one's.
    expect(decide(entry(), 'busy', INJECTED_AT)).toBe('alert')
  })

  it('never turns a quiet task into an alert -- the marker only clears', () => {
    // Pane idle + no marker was already 'clear'; a stale marker must not
    // upgrade that to an alert.
    expect(decide(entry(), 'idle', INJECTED_AT - 60_000)).toBe('clear')
  })

  it('leaves an unreadable pane on the conservative path', () => {
    // pane capture failed AND no marker -> no signal either way, hold.
    expect(decide(entry(), null, null)).toBe('hold')
  })

  it('clears even an unreadable pane once the marker proves the run finished', () => {
    expect(decide(entry(), null, INJECTED_AT + 5_000)).toBe('clear')
  })
})

describe('readTaskProgressAt', () => {
  it('returns the mtime of an existing marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'progress-marker-'))
    try {
      const file = join(dir, 'support-inbox-state.json')
      writeFileSync(file, '{}')
      const when = 1_700_000_000
      utimesSync(file, when, when)
      expect(readTaskProgressAt(file)).toBeCloseTo(when * 1000, -2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a missing file, an unset path and an empty string', () => {
    // All three collapse to "no information", which the decision function then
    // treats as the pane-only path -- never as an all-clear.
    expect(readTaskProgressAt(join(tmpdir(), 'no-such-marker-file.json'))).toBeNull()
    expect(readTaskProgressAt(undefined)).toBeNull()
    expect(readTaskProgressAt('')).toBeNull()
  })
})
