import { logger } from '../logger.js'

// Machine sleep/wake detection for downtime-aware alerting (2026-09-02, kanban
// 83b8c4c3): the scheduler and channel-monitor alert paths must be able to
// tell "something broke WHILE the machine was running" apart from "the machine
// was asleep / powered off, and every wall-clock timer aged past its threshold
// while nothing was actually wrong". The first is worth a Telegram ping; the
// second is pure noise (the operator closed the lid, they know).
//
// Implementation choice: a CLOCK-JUMP detector, not `pmset -g log` parsing.
// A setInterval cannot fire while the host (or this process) is suspended, so
// a sample gap far beyond the sample interval is positive evidence the process
// was not running across that gap. Compared to pmset this is
//   - cross-platform (the installer targets plain Linux hosts too; pmset is
//     macOS-only and its log format is not a stable API),
//   - free of a subprocess spawn on every check (`pmset -g log` reads the
//     whole power log, routinely megabytes), and
//   - a superset signal: it also catches SIGSTOP / App Nap / VM pauses, which
//     age wall-clock timers exactly the way real sleep does and deserve the
//     same alert suppression.
// The trade-off: no history from before this process started. That is fine
// for every consumer here -- each one measures a window that opened while
// this process was alive (an injection it performed, a keepalive mtime it
// tracks), so a sleep inside that window necessarily stalled our own timer.
//
// Window sizing: 15 s samples (aligned with the scheduler tick, negligible
// cost) and a 60 s gap threshold = four consecutive missed samples. Event-loop
// jitter or a slow tick can eat one sample interval, not four; real lid-close
// sleep is minutes to hours. Events are kept 24 h (covers any overnight gap a
// morning stuck-check could span) and capped so a pathological clock cannot
// grow the buffer unbounded.

export interface WakeEvent {
  // Last sample before the gap: the machine was provably awake here...
  sleepStartMs: number
  // ...and provably awake again here. The gap between them is downtime.
  wakeMs: number
}

export const SLEEP_SAMPLE_INTERVAL_MS = 15_000
export const SLEEP_GAP_THRESHOLD_MS = 60_000
export const WAKE_EVENT_RETENTION_MS = 24 * 60 * 60_000
const WAKE_EVENT_MAX = 200

// Pure: does a sample pair prove a sleep/suspend gap? prevSampleMs is null on
// the very first sample (nothing to compare against). A BACKWARD jump (NTP
// step, manual clock set) is not sleep; only a forward gap counts.
export function detectClockJump(
  prevSampleMs: number | null,
  nowMs: number,
  gapThresholdMs: number = SLEEP_GAP_THRESHOLD_MS,
): WakeEvent | null {
  if (prevSampleMs == null) return null
  if (nowMs - prevSampleMs < gapThresholdMs) return null
  return { sleepStartMs: prevSampleMs, wakeMs: nowMs }
}

// Pure: did any recorded sleep gap overlap [fromMs, toMs]? Overlap, not
// containment: a stuck-check window that merely BRUSHES a sleep gap already
// means the wall-clock elapsed time overstates the awake time.
export function sleptInWindow(events: readonly WakeEvent[], fromMs: number, toMs: number): boolean {
  return events.some(e => e.wakeMs >= fromMs && e.sleepStartMs <= toMs)
}

let wakeEvents: WakeEvent[] = []
let lastSampleMs: number | null = null
let detectorTimer: NodeJS.Timeout | null = null

// Feed one wall-clock sample. Exposed (with an explicit `nowMs`) so callers
// that already tick on their own cadence could piggyback, and for tests.
export function recordClockSample(nowMs: number = Date.now()): WakeEvent | null {
  const jump = detectClockJump(lastSampleMs, nowMs)
  lastSampleMs = nowMs
  if (jump) {
    wakeEvents.push(jump)
    const cutoff = nowMs - WAKE_EVENT_RETENTION_MS
    wakeEvents = wakeEvents.filter(e => e.wakeMs >= cutoff)
    if (wakeEvents.length > WAKE_EVENT_MAX) wakeEvents = wakeEvents.slice(-WAKE_EVENT_MAX)
    logger.info(
      { sleepStartMs: jump.sleepStartMs, wakeMs: jump.wakeMs, gapMinutes: Math.round((jump.wakeMs - jump.sleepStartMs) / 60000) },
      'sleep-wake: clock gap detected -- machine (or process) was suspended; downtime-caused alerts in this window will be suppressed',
    )
  }
  return jump
}

// Did the machine sleep at any point inside [fromMs, toMs]? Fail-safe: with
// the detector never started (webOnly mode, unit tests) there are no events
// and this is false, so every alert path behaves exactly as before.
export function systemSleptBetween(fromMs: number, toMs: number = Date.now()): boolean {
  return sleptInWindow(wakeEvents, fromMs, toMs)
}

// Idempotent: both the schedule runner and the channel-plugin monitor call
// this from their start functions; whichever runs first owns the timer.
// unref() so a lingering detector never keeps a test process alive.
export function startSleepWakeDetector(): NodeJS.Timeout {
  if (detectorTimer) return detectorTimer
  lastSampleMs = Date.now()
  detectorTimer = setInterval(() => { recordClockSample() }, SLEEP_SAMPLE_INTERVAL_MS)
  detectorTimer.unref?.()
  return detectorTimer
}

export function resetSleepWakeDetectorForTest(): void {
  if (detectorTimer) clearInterval(detectorTimer)
  detectorTimer = null
  wakeEvents = []
  lastSampleMs = null
}
