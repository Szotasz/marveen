// Event-loop-lag monitor: the DETECT side of the event-loop wedge class.
//
// Closing a known wedge source (a synchronous shell-out in a periodic sweep) fixes that one source.
// This is the complement: it DETECTS a wedge from ANY source
// -- a future/unknown sync shell-out, a runaway loop, a giant JSON.parse -- so a blocked
// event loop surfaces in seconds (a log line) instead of when a human notices the dashboard
// has gone unresponsive and manually restarts it.
//
// Mechanism: Node's perf_hooks.monitorEventLoopDelay samples the loop-delay into a
// histogram with almost zero overhead (a libuv timer). Once per window we read the window's
// max/mean/p99 and, if the max exceeds the threshold (the loop was blocked that long at
// least once), log a WARN with the numbers, then reset for the next window. Observability
// only: it never restarts or mutates anything.
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { logger } from '../logger.js'
import { readMachineState, readCpuSnapshot, type CpuSnapshot, type MachineStateReader } from './machine-state.js'

// Read the window max/mean/p99 (WARN threshold is on the max: a single long block is the
// wedge signal, not a raised average). Sampled every 30s; blocked past 1s is "wedged".
const SAMPLE_MS = (() => {
  const v = Number(process.env.EVENT_LOOP_LAG_SAMPLE_MS)
  return Number.isFinite(v) && v >= 1000 ? v : 30_000
})()
const WARN_MS = (() => {
  const v = Number(process.env.EVENT_LOOP_LAG_WARN_MS)
  // Below ~5x the histogram resolution, ordinary timer jitter would warn every window.
  return Number.isFinite(v) && v >= 100 ? v : 1000
})()
const INITIAL_DELAY_MS = 20_000
// Histogram resolution: how often libuv samples the loop delay. 20ms is fine-grained
// enough to catch a wedge while adding negligible overhead.
const RESOLUTION_MS = 20

export interface LagSample { maxMs: number; meanMs: number; p99Ms: number }

// The subset of a perf_hooks IntervalHistogram this module reads. Declared so the
// read+classify logic is unit-testable against a fake (no real event loop needed).
export interface LagHistogram {
  max: number // nanoseconds
  mean: number // nanoseconds
  percentile(p: number): number // nanoseconds
  reset(): void
}

// Pure: convert a histogram's raw nanosecond stats into a millisecond sample. A histogram
// with no recorded samples reports max = 0 (perf_hooks) / a non-finite mean -- normalize
// those to 0 so an empty window reads as 'ok', never NaN.
export function readLagSample(h: LagHistogram): LagSample {
  const toMs = (ns: number) => (Number.isFinite(ns) && ns > 0 ? ns / 1e6 : 0)
  return { maxMs: toMs(h.max), meanMs: toMs(h.mean), p99Ms: toMs(h.percentile(99)) }
}

// Pure: was the loop blocked past the threshold in this window? (Gate on the max.)
export function classifyLagSample(s: LagSample, thresholdMs: number): 'ok' | 'blocked' {
  return s.maxMs >= thresholdMs ? 'blocked' : 'ok'
}

// Machine-state support for the WARN line. The reader is INSTALLED at module level by
// startEventLoopLagMonitor() and uninstalled by stop() instead of being a plain default
// parameter that always runs: a direct sampleLagOnce(h, t) call outside a running monitor
// then logs the plain 4-field shape, while production blocked windows carry the machine
// state.
//
// LAGBUSYFRAC1109 (Boni's 11-08 finding on #2622, Samu 73807): busyFrac is the CPU load of
// the LAST window, not the average since the previous blocked one. The monitor takes a
// baseline CPU snapshot when it starts, and every sample (healthy or blocked) moves
// lastCpuSnapshot forward, so a blocked window's busyFrac covers exactly the time since the
// previous sample (~SAMPLE_MS), and the first block after start has a baseline (never null
// for want of one). cpuSampler is the per-sample snapshot source, installed with the reader.
let lastCpuSnapshot: CpuSnapshot | null = null
let machineStateReader: MachineStateReader | null = null
let cpuSampler: (() => CpuSnapshot | null) | null = null

// Read one window, log on a block, and reset. Extracted + injectable so a test can drive
// it with a fake histogram; returns the classification for assertions. The third argument
// defaults to the module-level reader (set only while a monitor runs) so the machine-state
// fields appear exactly when a real monitor produced the window. The fourth argument (the
// per-sample CPU snapshot source) defaults the same way.
export function sampleLagOnce(
  h: LagHistogram,
  thresholdMs: number = WARN_MS,
  readState: MachineStateReader | null = machineStateReader,
  sampleCpu: (() => CpuSnapshot | null) | null = cpuSampler,
): 'ok' | 'blocked' {
  try {
    const sample = readLagSample(h)
    const verdict = classifyLagSample(sample, thresholdMs)
    if (verdict === 'blocked') {
      const fields: Record<string, unknown> = {
        maxMs: Math.round(sample.maxMs), meanMs: Math.round(sample.meanMs),
        p99Ms: Math.round(sample.p99Ms), thresholdMs,
      }
      if (readState) {
        try {
          const st = readState(lastCpuSnapshot)
          lastCpuSnapshot = st.cpu
          Object.assign(fields, {
            busyFrac: st.busyFrac, memAvailableMB: st.memAvailableMB, swapUsedMB: st.swapUsedMB,
            psiMemSome10: st.psiMemSome10, psiCpuSome10: st.psiCpuSome10,
            topRssPid: st.topRssPid, topRssRssMB: st.topRssRssMB, topRssComm: st.topRssComm,
          })
        } catch { /* machine state is best-effort: warn without it */ }
      }
      logger.warn(
        fields,
        'event-loop-lag: the event loop was BLOCKED past the threshold this window -- the dashboard was unresponsive (possible wedge; look for long synchronous work)',
      )
    } else if (sampleCpu) {
      // A healthy window still moves the CPU baseline forward, so the next blocked window's
      // busyFrac covers only that window (LAGBUSYFRAC1109). Best-effort, like the reader.
      try { lastCpuSnapshot = sampleCpu() } catch { /* keep the previous baseline */ }
    }
    return verdict
  } finally {
    // Every window starts fresh, even when reading it threw; a reset error is swallowed.
    try { h.reset() } catch { /* ignore */ }
  }
}

export interface LagMonitorHandle { sampleMs: number; warnMs: number; stop(): void }

// Starts sampling; stop() clears both timers and disables the histogram.
export function startEventLoopLagMonitor(): LagMonitorHandle {
  machineStateReader = readMachineState
  cpuSampler = readCpuSnapshot
  // The baseline for the first window (LAGBUSYFRAC1109): without it the first block's
  // busyFrac would have nothing to subtract from and read null.
  lastCpuSnapshot = readCpuSnapshot()
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  const run = () => {
    try { sampleLagOnce(histogram) } catch (err) { logger.debug({ err }, 'event-loop-lag: sample threw') }
  }
  const initial = setTimeout(run, INITIAL_DELAY_MS)
  const interval = setInterval(run, SAMPLE_MS)
  return {
    sampleMs: SAMPLE_MS,
    warnMs: WARN_MS,
    stop() {
      clearTimeout(initial); clearInterval(interval); histogram.disable()
      // Leave the module pristine: reader uninstalled, no cpu snapshot chained across
      // monitor lifetimes (a busyFrac must never span two different monitors).
      lastCpuSnapshot = null
      machineStateReader = null
      cpuSampler = null
    },
  }
}
