// Event-loop-lag monitor. Pins the pure read/classify logic and the sample-once
// behaviour (log-on-block + always-reset) against a fake histogram.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
import {
  readLagSample, classifyLagSample, sampleLagOnce, type LagHistogram,
} from '../web/event-loop-lag-monitor.js'

const MS = 1e6 // ns per ms

function fakeHistogram(over: Partial<LagHistogram> = {}): LagHistogram & { resetCalls: number } {
  return {
    max: 0, mean: 0,
    percentile: () => 0,
    resetCalls: 0,
    reset() { this.resetCalls++ },
    ...over,
  } as LagHistogram & { resetCalls: number }
}

describe('readLagSample (ns -> ms, empty-window safe)', () => {
  it('converts nanoseconds to milliseconds', () => {
    const s = readLagSample(fakeHistogram({ max: 1500 * MS, mean: 12 * MS, percentile: () => 900 * MS }))
    expect(s).toEqual({ maxMs: 1500, meanMs: 12, p99Ms: 900 })
  })
  it('normalizes an empty window (max 0 / NaN mean) to 0, never NaN', () => {
    const s = readLagSample(fakeHistogram({ max: 0, mean: NaN, percentile: () => 0 }))
    expect(s).toEqual({ maxMs: 0, meanMs: 0, p99Ms: 0 })
  })
})

describe('classifyLagSample (gate on the window max)', () => {
  it('blocked when max >= threshold, ok below', () => {
    expect(classifyLagSample({ maxMs: 1200, meanMs: 5, p99Ms: 800 }, 1000)).toBe('blocked')
    expect(classifyLagSample({ maxMs: 1000, meanMs: 5, p99Ms: 800 }, 1000)).toBe('blocked') // inclusive
    expect(classifyLagSample({ maxMs: 999, meanMs: 5, p99Ms: 800 }, 1000)).toBe('ok')
  })
})

describe('sampleLagOnce (log-on-block + always reset)', () => {
  beforeEach(() => { warn.mockClear() })
  it('reports blocked, logs ONE warning with the numbers and resets when the loop was blocked past the threshold', () => {
    const h = fakeHistogram({ max: 3000 * MS, mean: 40 * MS, percentile: () => 2500 * MS })
    expect(sampleLagOnce(h, 1000)).toBe('blocked')
    expect(h.resetCalls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ maxMs: 3000, meanMs: 40, p99Ms: 2500, thresholdMs: 1000 })
  })
  it('reports ok, logs nothing and STILL resets on a healthy window (fresh window each sample)', () => {
    const h = fakeHistogram({ max: 30 * MS, mean: 4 * MS, percentile: () => 12 * MS })
    expect(sampleLagOnce(h, 1000)).toBe('ok')
    expect(h.resetCalls).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })
  it('a reset failure never throws out of the sample (best-effort observability)', () => {
    const h = fakeHistogram({ max: 5000 * MS, reset() { throw new Error('boom') } })
    // Observability must never disrupt: the verdict is still returned and the throw is swallowed.
    expect(sampleLagOnce(h, 1000)).toBe('blocked')
  })
})

describe('sampleLagOnce resets even when reading the window throws', () => {
  it('a throwing percentile still resets the histogram', () => {
    const h = fakeHistogram({ max: 5000 * MS, percentile: () => { throw new Error('boom') } })
    expect(() => sampleLagOnce(h, 1000)).toThrow('boom')
    expect(h.resetCalls).toBe(1)
  })
})

describe('startEventLoopLagMonitor', () => {
  it('stop() clears both timers', async () => {
    vi.useFakeTimers()
    try {
      const { startEventLoopLagMonitor } = await import('../web/event-loop-lag-monitor.js')
      const before = vi.getTimerCount()
      const handle = startEventLoopLagMonitor()
      expect(vi.getTimerCount()).toBe(before + 2)
      handle.stop()
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a WARN threshold below the floor falls back to the default; a sane one is kept', async () => {
    const prev = process.env.EVENT_LOOP_LAG_WARN_MS
    try {
      for (const [env, want] of [['1', 1000], ['0.001', 1000], ['abc', 1000], ['250', 250]] as const) {
        process.env.EVENT_LOOP_LAG_WARN_MS = env
        vi.resetModules()
        const m = await import('../web/event-loop-lag-monitor.js')
        const handle = m.startEventLoopLagMonitor()
        handle.stop()
        expect(handle.warnMs).toBe(want)
      }
    } finally {
      if (prev === undefined) delete process.env.EVENT_LOOP_LAG_WARN_MS
      else process.env.EVENT_LOOP_LAG_WARN_MS = prev
      vi.resetModules()
    }
  })
})
