import { afterEach, describe, expect, it } from 'vitest'
import {
  detectClockJump,
  sleptInWindow,
  recordClockSample,
  systemSleptBetween,
  resetSleepWakeDetectorForTest,
  SLEEP_GAP_THRESHOLD_MS,
  SLEEP_SAMPLE_INTERVAL_MS,
  type WakeEvent,
} from '../web/sleep-wake-detector.js'

// Tests for the machine sleep/wake detector (2026-09-02, kanban 83b8c4c3).
//
// The detector's job: turn "our setInterval could not fire for a long
// stretch" into a queryable fact, so wall-clock-based alert paths (stuck-task
// timeout, keepalive staleness) can tell operator-caused downtime (lid close,
// power off) apart from a genuine hang while running. Suppressed: the
// Telegram ping. Untouched: respawn / retry / kanban / log visibility.

afterEach(() => resetSleepWakeDetectorForTest())

describe('detectClockJump', () => {
  it('null previous sample (first ever sample) is never a jump', () => {
    expect(detectClockJump(null, 1_000_000)).toBeNull()
  })

  it('a normal sample cadence is not a jump', () => {
    expect(detectClockJump(0, SLEEP_SAMPLE_INTERVAL_MS)).toBeNull()
  })

  it('event-loop jitter below the threshold is not a jump', () => {
    expect(detectClockJump(0, SLEEP_GAP_THRESHOLD_MS - 1)).toBeNull()
  })

  it('a gap at the threshold is a jump spanning [prev, now]', () => {
    const jump = detectClockJump(1000, 1000 + SLEEP_GAP_THRESHOLD_MS)
    expect(jump).toEqual({ sleepStartMs: 1000, wakeMs: 1000 + SLEEP_GAP_THRESHOLD_MS })
  })

  it('a BACKWARD clock step (NTP correction) is not sleep', () => {
    expect(detectClockJump(1_000_000, 500_000)).toBeNull()
  })
})

describe('sleptInWindow', () => {
  const HOUR = 3_600_000
  const nap: WakeEvent = { sleepStartMs: 10 * HOUR, wakeMs: 12 * HOUR }

  it('no recorded events -> never slept (fail-safe: alerts behave as before)', () => {
    expect(sleptInWindow([], 0, 100 * HOUR)).toBe(false)
  })

  it('a window fully containing the sleep gap overlaps', () => {
    expect(sleptInWindow([nap], 9 * HOUR, 13 * HOUR)).toBe(true)
  })

  it('a window that merely BRUSHES the gap on either side overlaps', () => {
    // Stuck-check opened before the sleep, closed mid-sleep... (cannot really
    // happen mid-sleep, but the boundary math must not care)
    expect(sleptInWindow([nap], 9 * HOUR, 10 * HOUR)).toBe(true)
    // ...or opened during the gap's tail and closed after the wake.
    expect(sleptInWindow([nap], 12 * HOUR, 13 * HOUR)).toBe(true)
  })

  it('a window entirely before or entirely after the gap does not overlap', () => {
    expect(sleptInWindow([nap], 0, 10 * HOUR - 1)).toBe(false)
    expect(sleptInWindow([nap], 12 * HOUR + 1, 14 * HOUR)).toBe(false)
  })
})

describe('recordClockSample + systemSleptBetween (module state)', () => {
  it('regular sampling records nothing; systemSleptBetween stays false', () => {
    let t = 1_000_000
    for (let i = 0; i < 10; i++) {
      expect(recordClockSample(t)).toBeNull()
      t += SLEEP_SAMPLE_INTERVAL_MS
    }
    expect(systemSleptBetween(1_000_000, t)).toBe(false)
  })

  it('a sleep gap between samples is recorded and queryable', () => {
    const HOUR = 3_600_000
    recordClockSample(1_000_000)
    recordClockSample(1_000_000 + SLEEP_SAMPLE_INTERVAL_MS)
    // Lid closed for two hours.
    const wakeAt = 1_000_000 + SLEEP_SAMPLE_INTERVAL_MS + 2 * HOUR
    const jump = recordClockSample(wakeAt)
    expect(jump).not.toBeNull()
    // The exact stuck-check shape: injectedAt just before the sleep, checked
    // just after the wake -- the window overlaps the gap.
    expect(systemSleptBetween(1_000_000, wakeAt + 1000)).toBe(true)
    // A window opened AFTER the wake has no gap in it -- a genuine hang there
    // must still alert.
    expect(systemSleptBetween(wakeAt + 1000, wakeAt + 10 * 60_000)).toBe(false)
  })

  it('with the detector never fed (webOnly / tests), every query is false', () => {
    expect(systemSleptBetween(0, Date.now())).toBe(false)
  })
})

// --- Fix-revert guard: the consumers actually consult the detector ---
//
// If either sleep guard were removed, the greps below turn RED. Verified by
// inspection: deleting the systemSleptBetween call in sendTaskTimeoutAlert or
// checkMainKeepaliveStaleness fails the corresponding assertion.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('fix-revert guard: alert paths are sleep-aware', () => {
  it('sendTaskTimeoutAlert consults systemSleptBetween before the channel send', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    const fnStart = src.indexOf('function sendTaskTimeoutAlert')
    expect(fnStart).toBeGreaterThan(0)
    const fnEnd = src.indexOf('\nexport const SCHEDULE_TICK_MS', fnStart)
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
    const sleptIdx = fnBody.indexOf('systemSleptBetween(entry.injectedAt')
    const sendIdx = fnBody.indexOf('await sendSchedulerAlertMessage(')
    expect(sleptIdx, 'sleep guard missing from sendTaskTimeoutAlert').toBeGreaterThan(0)
    expect(sendIdx).toBeGreaterThan(sleptIdx)
    // The kanban 'waiting' move must NOT be short-circuited by the guard: the
    // board keeps reflecting the stuck state even when Telegram stays quiet.
    const kanbanIdx = fnBody.indexOf('markScheduledTaskKanbanWaiting(')
    const suppressReturnIdx = fnBody.indexOf('if (sleptDuringWindow)')
    expect(kanbanIdx).toBeGreaterThan(0)
    expect(suppressReturnIdx).toBeGreaterThan(kanbanIdx)
  })

  it('checkMainKeepaliveStaleness suppresses sendAlert on sleep but keeps the respawn', () => {
    const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    const fnStart = src.indexOf('function checkMainKeepaliveStaleness')
    expect(fnStart).toBeGreaterThan(0)
    const fnEnd = src.indexOf('\nexport function sendAlert', fnStart)
    const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
    const sleptIdx = fnBody.indexOf('systemSleptBetween(now - ageMs, now)')
    expect(sleptIdx, 'sleep guard missing from checkMainKeepaliveStaleness').toBeGreaterThan(0)
    // sendAlert is inside the !staleDueToSleep branch...
    expect(fnBody).toMatch(/if \(!staleDueToSleep\) \{\s*\n\s*sendAlert\(/)
    // ...while the respawn stays UNCONDITIONAL on sleep (self-healing keeps going).
    const respawnIdx = fnBody.indexOf('respawnMarveenSessionFresh()')
    expect(respawnIdx).toBeGreaterThan(sleptIdx)
    const betweenGuardAndRespawn = fnBody.slice(fnBody.indexOf('if (!staleDueToSleep)'), respawnIdx)
    expect(betweenGuardAndRespawn).not.toMatch(/return/)
  })
})
