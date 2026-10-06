import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'

// Machine sleep/wake detection for downtime-aware alerting (2026-09-02, kanban
// 83b8c4c3): the scheduler and channel-monitor alert paths must be able to
// tell "something broke WHILE the machine was running" apart from "the machine
// was asleep / powered off, and every wall-clock timer aged past its threshold
// while nothing was actually wrong". The first is worth a Telegram ping; the
// second is pure noise (the operator closed the lid, they know).
//
// Implementation choice: a sample-GAP trigger, then a platform-specific proof
// that the host slept inside that gap. A sample gap alone is NOT enough:
// an event-loop stall (a stuck synchronous call) delays the setInterval just
// the same, but there both clocks advance together -- measured in the #1153
// review, a 70 s stall on an awake machine: wallMs 86001 = monoMs 86001 -- and
// that stall is exactly the in-process failure the alerts exist for, so it
// must stay LOUD. The same holds for SIGSTOP, App Nap timer coalescing and any
// other pause of this process on a running host: monotonic time keeps going,
// so they count as awake. The proof of sleep:
//   - Linux: process.hrtime.bigint() is libuv's uv_hrtime = CLOCK_MONOTONIC,
//     which stops during suspend. Sleep = the WALL clock ran ahead of the
//     monotonic one by at least the threshold.
//   - macOS: that divergence never appears. libuv's uv_hrtime there is
//     mach_continuous_time(), which KEEPS counting through sleep (#1153 review,
//     from the libuv source; confirmed on the Mac mini: Homebrew node 26.9.0
//     links libuv 1.52.1, whose only mach clock import is _mach_continuous_time).
//     So on a gap, and only then, the host's last wake time is read once
//     (`sysctl -n kern.waketime`, a one-line answer, no log parsing): a wake
//     INSIDE the gap = sleep; no wake there = a stall on an awake machine, loud.
//     `pmset -g log` would say the same but reads the whole power log
//     (megabytes) and its line format is not a stable API.
// Every failure errs loud: an unreadable or zero kern.waketime (no sleep since
// boot) means "not sleep", which is the behaviour before this detector existed.
// Known edge (Linux): a forward wall-clock STEP of a minute or more while
// running (a manual clock set, a large NTP correction) also leaves the
// monotonic clock behind, so it reads as sleep and mutes the alerts of the
// windows it overlaps.
// The trade-off: no history from before this process started. That is fine
// for every consumer here -- each one measures a window that opened while
// this process was alive (an injection it performed, a keepalive mtime it
// tracks), so a sleep inside that window necessarily stalled our own timer.
//
// Window sizing: 15 s samples (aligned with the scheduler tick, negligible
// cost) and a 60 s threshold, both for the gap that triggers the macOS wake
// check and for the Linux wall-minus-monotonic divergence. Real lid-close
// sleep is minutes to hours. Events are kept 24 h (covers any overnight gap a
// morning stuck-check could span) and capped so a pathological clock cannot
// grow the buffer unbounded.

export interface WakeEvent {
  // Last sample before the gap: the machine was provably awake here...
  sleepStartMs: number
  // ...and provably awake again here. The gap between them is downtime.
  wakeMs: number
}

// One sample of both clocks, in milliseconds.
export interface ClockSample {
  wallMs: number
  monoMs: number
}

export const SLEEP_SAMPLE_INTERVAL_MS = 15_000
export const SLEEP_GAP_THRESHOLD_MS = 60_000
export const WAKE_EVENT_RETENTION_MS = 24 * 60 * 60_000
const WAKE_EVENT_MAX = 200

export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

// Where the proof of sleep comes from, when the monotonic clock does not stop
// (macOS). `lastWakeMs` is consulted ONLY on a gap; null = unknown, i.e. loud.
export interface WakeProbe {
  platform: string
  lastWakeMs: () => number | null
}

// `sysctl -n kern.waketime` answers "{ sec = 1790664331, usec = 569763 } Tue Sep
// 29 08:45:31 2026"; sec = 0 means the host has not slept since boot.
export function parseWakeTime(out: string): number | null {
  const m = /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(out)
  if (!m) return null
  const sec = Number(m[1])
  if (sec === 0) return null
  return sec * 1000 + Math.floor(Number(m[2]) / 1000)
}

function readKernWakeTimeMs(): number | null {
  try {
    return parseWakeTime(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.waketime'], { encoding: 'utf-8', timeout: 2000 }))
  } catch {
    return null
  }
}

const DEFAULT_WAKE_PROBE: WakeProbe = { platform: process.platform, lastWakeMs: readKernWakeTimeMs }
let wakeProbe: WakeProbe = DEFAULT_WAKE_PROBE

// A wake stamped a little after our own sample (an NTP step right after the
// wake) still belongs to this gap.
const WAKE_CLOCK_SLACK_MS = 5_000

// Does a sample pair prove a sleep/suspend gap? prev is null on the very first
// sample (nothing to compare against). Linux (and any platform whose monotonic
// clock stops in suspend): the wall clock ran ahead of the monotonic clock by
// at least the threshold. macOS: the samples are at least the threshold apart
// and the host's last wake falls inside that gap. A stall (both clocks advance
// together, no wake) is not sleep, however long; a BACKWARD wall step (NTP,
// manual clock set) is not sleep either.
export function detectClockJump(
  prev: ClockSample | null,
  now: ClockSample,
  gapThresholdMs: number = SLEEP_GAP_THRESHOLD_MS,
  probe: WakeProbe = wakeProbe,
): WakeEvent | null {
  if (prev == null) return null
  const wallDelta = now.wallMs - prev.wallMs
  const monoDelta = now.monoMs - prev.monoMs
  const event = { sleepStartMs: prev.wallMs, wakeMs: now.wallMs }
  if (wallDelta - monoDelta >= gapThresholdMs) return event
  if (probe.platform !== 'darwin' || wallDelta < gapThresholdMs) return null
  let wake: number | null
  try {
    wake = probe.lastWakeMs()
  } catch {
    wake = null
  }
  if (wake !== null && wake > prev.wallMs && wake <= now.wallMs + WAKE_CLOCK_SLACK_MS) return event
  return null
}

// Pure: did any recorded sleep gap overlap [fromMs, toMs]? Overlap, not
// containment: a stuck-check window that merely BRUSHES a sleep gap already
// means the wall-clock elapsed time overstates the awake time.
export function sleptInWindow(events: readonly WakeEvent[], fromMs: number, toMs: number): boolean {
  return events.some(e => e.wakeMs >= fromMs && e.sleepStartMs <= toMs)
}

let wakeEvents: WakeEvent[] = []
let lastSample: ClockSample | null = null
let detectorTimer: NodeJS.Timeout | null = null

// Feed one sample of both clocks. Exposed (with explicit readings) so callers
// that already tick on their own cadence could piggyback, and for tests.
export function recordClockSample(nowMs: number = Date.now(), monoMs: number = monotonicNowMs()): WakeEvent | null {
  const now = { wallMs: nowMs, monoMs }
  const jump = detectClockJump(lastSample, now)
  lastSample = now
  if (jump) {
    wakeEvents.push(jump)
    const cutoff = nowMs - WAKE_EVENT_RETENTION_MS
    wakeEvents = wakeEvents.filter(e => e.wakeMs >= cutoff)
    if (wakeEvents.length > WAKE_EVENT_MAX) wakeEvents = wakeEvents.slice(-WAKE_EVENT_MAX)
    logger.info(
      { sleepStartMs: jump.sleepStartMs, wakeMs: jump.wakeMs, gapMinutes: Math.round((jump.wakeMs - jump.sleepStartMs) / 60000) },
      'sleep-wake: the host was suspended in this sample gap; downtime-caused alerts in this window will be suppressed',
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
  lastSample = { wallMs: Date.now(), monoMs: monotonicNowMs() }
  detectorTimer = setInterval(() => { recordClockSample() }, SLEEP_SAMPLE_INTERVAL_MS)
  detectorTimer.unref?.()
  return detectorTimer
}

export function setWakeProbeForTest(probe: WakeProbe): void {
  wakeProbe = probe
}

export function resetSleepWakeDetectorForTest(): void {
  if (detectorTimer) clearInterval(detectorTimer)
  detectorTimer = null
  wakeEvents = []
  lastSample = null
  wakeProbe = DEFAULT_WAKE_PROBE
}
