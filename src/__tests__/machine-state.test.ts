// machine-state: pins the pure /proc parsers with literal fixtures (no fs anywhere), the CPU
// snapshot source (proc, os.cpus() fallback), and
// the event-loop-lag monitor's integration with an injected machine-state reader -- the
// flat WARN fields, the healthy-window no-read, prevCpu chaining, the best-effort swallow,
// and stop() leaving the module pristine.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
import {
  parseStatTotalLine, computeBusyFrac, parseMeminfo, parsePressureSomeAvg10, findTopRss,
  snapshotFromOsCpus, readCpuSnapshot,
  type CpuSnapshot, type MachineState,
} from '../web/machine-state.js'
import { sampleLagOnce, startEventLoopLagMonitor, type LagHistogram } from '../web/event-loop-lag-monitor.js'

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

// A fake machine-state reader: records the prevCpu it receives and returns fixed fields
// (overridable per test). `cpu` is what the monitor chains into the next call.
function fakeReader(over: Partial<MachineState & { cpu: CpuSnapshot | null }> = {}) {
  const defaults: MachineState & { cpu: CpuSnapshot | null } = {
    busyFrac: 0.42,
    memAvailableMB: 1024,
    swapUsedMB: 2048,
    psiMemSome10: 1.5,
    psiCpuSome10: 0.25,
    topRssPid: 1234,
    topRssRssMB: 512,
    topRssComm: 'worker',
    cpu: null,
  }
  const prevCpus: Array<CpuSnapshot | null> = []
  const reader = (prevCpu: CpuSnapshot | null): MachineState & { cpu: CpuSnapshot | null } => {
    prevCpus.push(prevCpu)
    return { ...defaults, ...over }
  }
  return { reader, prevCpus }
}

// start()+stop() leaves the monitor module pristine: no installed reader, no chained cpu
// snapshot, so tests never inherit state from each other and never hit the real /proc.
function resetMonitorModule(): void {
  startEventLoopLagMonitor().stop()
}

describe('parseStatTotalLine (first line of /proc/stat)', () => {
  it('sums the 8 non-guest fields into total, idle+iowait into idleAll (numbers by hand)', () => {
    // total counts user..steal only (the first 8 fields): guest and guest_nice are already
    // inside user and nice per proc(5), so summing them would double-count guest time.
    // user 74658 + nice 4869 + system 22986 + idle 3724775 + iowait 105290
    //   + irq 12 + softirq 2747 + steal 31462 = 3966799 (guest 5300 + guest_nice 210 EXCLUDED)
    // idleAll = 3724775 + 105290 = 3830065
    const line = 'cpu  74658 4869 22986 3724775 105290 12 2747 31462 5300 210'
    expect(parseStatTotalLine(line)).toEqual({ total: 3966799, idleAll: 3830065 })
  })
  it('rejects a non-numeric token', () => {
    expect(parseStatTotalLine('cpu  74658 4869 x 3724775 105290 12 2747 31462 0 0')).toBeNull()
  })
  it('rejects a per-cpu or other non-total line (first token must be exactly "cpu")', () => {
    expect(parseStatTotalLine('intr 1234567890')).toBeNull()
    expect(parseStatTotalLine('cpu0 100 100 100 100 100')).toBeNull()
  })
  it('rejects fewer than 5 numeric fields', () => {
    expect(parseStatTotalLine('cpu  1 2 3 4')).toBeNull()
  })
})

describe('computeBusyFrac (delta between two cpu snapshots)', () => {
  const snap = (total: number, idleAll: number): CpuSnapshot => ({ total, idleAll })
  it('null when either snapshot is missing (no baseline -> no fraction)', () => {
    expect(computeBusyFrac(null, snap(1000, 700))).toBeNull()
    expect(computeBusyFrac(snap(0, 0), null)).toBeNull()
  })
  it('null when dTotal is 0 (counters did not move)', () => {
    expect(computeBusyFrac(snap(500, 100), snap(500, 100))).toBeNull()
  })
  it('null when dIdle > dTotal (impossible delta, never a bogus fraction)', () => {
    expect(computeBusyFrac(snap(100, 0), snap(105, 10))).toBeNull()
  })
  it('null when dIdle < 0 (counters went backwards)', () => {
    expect(computeBusyFrac(snap(100, 50), snap(120, 40))).toBeNull()
  })
  it('a normal delta -> the exact rounded fraction (dTotal 1000, dIdle 700 -> 0.3)', () => {
    expect(computeBusyFrac(snap(0, 0), snap(1000, 700))).toBe(0.3)
  })
  it('a repeating fraction is rounded to 3 decimals (dTotal 3000, dIdle 1000 -> 0.667)', () => {
    expect(computeBusyFrac(snap(10000, 1000), snap(13000, 2000))).toBe(0.667)
  })
})

describe('parseMeminfo (kB -> MB)', () => {
  const FIXTURE = [
    'MemTotal:        16384000 kB',
    'MemFree:          2097152 kB',
    'MemAvailable:    1048576 kB',
    'SwapTotal:       2097152 kB',
    'SwapFree:        1048576 kB',
    'SwapCached:        51200 kB',
  ].join('\n')
  it('MemAvailable -> MB and SwapTotal-SwapFree -> MB (SwapCached is NOT usage)', () => {
    expect(parseMeminfo(FIXTURE)).toEqual({ memAvailableMB: 1024, swapUsedMB: 1024 })
  })
  it('a missing MemAvailable -> that field null, swap still computed', () => {
    const noAvail = FIXTURE.split('\n').filter((l) => !l.startsWith('MemAvailable:')).join('\n')
    expect(parseMeminfo(noAvail)).toEqual({ memAvailableMB: null, swapUsedMB: 1024 })
  })
  it('missing swap keys -> swapUsedMB null', () => {
    const noSwap = FIXTURE.split('\n').filter((l) => !l.startsWith('Swap')).join('\n')
    expect(parseMeminfo(noSwap)).toEqual({ memAvailableMB: 1024, swapUsedMB: null })
  })
  it('only SwapTotal missing (SwapFree present) -> swapUsedMB null, not negative', () => {
    const noTotal = FIXTURE.split('\n').filter((l) => !l.startsWith('SwapTotal')).join('\n')
    expect(parseMeminfo(noTotal)).toEqual({ memAvailableMB: 1024, swapUsedMB: null })
  })
  it('only SwapFree missing (SwapTotal present) -> swapUsedMB null, not full swap', () => {
    const noFree = FIXTURE.split('\n').filter((l) => !l.startsWith('SwapFree')).join('\n')
    expect(parseMeminfo(noFree)).toEqual({ memAvailableMB: 1024, swapUsedMB: null })
  })
})

describe('parsePressureSomeAvg10 (one /proc/pressure file)', () => {
  it('returns the float after avg10= on the some line', () => {
    expect(parsePressureSomeAvg10('some avg10=1.23 avg60=0.50 avg120=0.25 total=12345\n')).toBe(1.23)
  })
  it('a file with only a full line -> null (some is a different signal)', () => {
    expect(parsePressureSomeAvg10('full avg10=9.99 avg60=0.00 avg120=0.00 total=0\n')).toBeNull()
  })
  it('garbage -> null', () => {
    expect(parsePressureSomeAvg10('not a pressure file')).toBeNull()
    expect(parsePressureSomeAvg10('')).toBeNull()
    expect(parsePressureSomeAvg10('some avg10=abc avg60=0.00\n')).toBeNull()
  })
})

describe('findTopRss', () => {
  it('returns the entry with the maximum residentPages', () => {
    const entries = [
      { pid: 1, residentPages: 100 },
      { pid: 2, residentPages: 900 },
      { pid: 3, residentPages: 400 },
    ]
    expect(findTopRss(entries)).toEqual({ pid: 2, residentPages: 900 })
  })
  it('empty input -> null', () => {
    expect(findTopRss([])).toBeNull()
  })
})

describe('sampleLagOnce + machine-state reader (monitor integration)', () => {
  beforeEach(() => {
    warn.mockClear()
    resetMonitorModule()
  })

  it('a blocked window warns with the 4 lag fields PLUS the 8 machine fields, all flat', () => {
    const h = fakeHistogram({ max: 3000 * MS, mean: 40 * MS, percentile: () => 2500 * MS })
    const { reader } = fakeReader()
    expect(sampleLagOnce(h, 1000, reader)).toBe('blocked')
    expect(h.resetCalls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({
      maxMs: 3000, meanMs: 40, p99Ms: 2500, thresholdMs: 1000,
      busyFrac: 0.42, memAvailableMB: 1024, swapUsedMB: 2048,
      psiMemSome10: 1.5, psiCpuSome10: 0.25,
      topRssPid: 1234, topRssRssMB: 512, topRssComm: 'worker',
    })
    expect(warn.mock.calls[0][1]).toBe(
      'event-loop-lag: the event loop was BLOCKED past the threshold this window -- the dashboard was unresponsive (possible wedge; look for long synchronous work)',
    )
  })

  it('a healthy window (max below threshold) never calls the reader', () => {
    let called = false
    const reader = (): MachineState & { cpu: CpuSnapshot | null } => {
      called = true
      return { busyFrac: 0, memAvailableMB: 0, swapUsedMB: 0, psiMemSome10: 0, psiCpuSome10: 0, topRssPid: 0, topRssRssMB: 0, topRssComm: null, cpu: null }
    }
    const h = fakeHistogram({ max: 30 * MS, mean: 4 * MS, percentile: () => 12 * MS })
    expect(sampleLagOnce(h, 1000, reader)).toBe('ok')
    expect(called).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('chains prevCpu across blocked windows: first call sees null, second sees the first snapshot', () => {
    const snapshotA: CpuSnapshot = { total: 12345, idleAll: 6000 }
    const { reader, prevCpus } = fakeReader({ cpu: snapshotA })
    const blocked = () => fakeHistogram({ max: 2000 * MS, mean: 20 * MS, percentile: () => 1500 * MS })
    expect(sampleLagOnce(blocked(), 1000, reader)).toBe('blocked')
    expect(sampleLagOnce(blocked(), 1000, reader)).toBe('blocked')
    expect(prevCpus).toHaveLength(2)
    expect(prevCpus[0]).toBeNull()
    expect(prevCpus[1]).toEqual(snapshotA)
  })

  it('a throwing reader never breaks the warn: blocked verdict, exactly the 4 original fields', () => {
    const reader = (): MachineState & { cpu: CpuSnapshot | null } => { throw new Error('statm scan exploded') }
    const h = fakeHistogram({ max: 5000 * MS, mean: 50 * MS, percentile: () => 4000 * MS })
    expect(sampleLagOnce(h, 1000, reader)).toBe('blocked')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ maxMs: 5000, meanMs: 50, p99Ms: 4000, thresholdMs: 1000 })
  })

  it('stop() resets the chain and uninstalls the reader: the next blocked sample starts from null again', () => {
    // Leave a non-null snapshot chained, as a previous monitor lifetime would.
    const snapshotA: CpuSnapshot = { total: 999, idleAll: 100 }
    const chained = fakeReader({ cpu: snapshotA })
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, chained.reader)).toBe('blocked')
    expect(chained.prevCpus[0]).toBeNull()
    // A full monitor lifetime must not inherit it.
    startEventLoopLagMonitor().stop()
    const { reader, prevCpus } = fakeReader()
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, reader)).toBe('blocked')
    expect(prevCpus[0]).toBeNull()
    // And with no reader injected, a blocked sample logs exactly the plain 4-field shape
    // (stop() uninstalled the real reader; no /proc fields leak in).
    warn.mockClear()
    expect(sampleLagOnce(fakeHistogram({ max: 2500 * MS, mean: 0, percentile: () => 0 }), 1000)).toBe('blocked')
    expect(warn.mock.calls[0][0]).toEqual({ maxMs: 2500, meanMs: 0, p99Ms: 0, thresholdMs: 1000 })
  })
})

// LAGBUSYFRAC1109 (Boni's 11-08 finding on #2622, Samu 73807): busyFrac describes the LAST
// window, and the first block after start is not null for want of a baseline.
describe('snapshotFromOsCpus (the portable source, macOS)', () => {
  const core = (user: number, nice: number, sys: number, idle: number, irq: number) => ({ times: { user, nice, sys, idle, irq } })
  it('sums every core: total = user+nice+sys+idle+irq, idleAll = idle (numbers by hand)', () => {
    // core0: 100+0+50+800+10 = 960, core1: 200+5+40+700+5 = 950 -> total 1910, idle 1500
    expect(snapshotFromOsCpus([core(100, 0, 50, 800, 10), core(200, 5, 40, 700, 5)])).toEqual({ total: 1910, idleAll: 1500 })
  })
  it('no cores, or a non-finite time -> null', () => {
    expect(snapshotFromOsCpus([])).toBeNull()
    expect(snapshotFromOsCpus([core(1, 0, 1, Number.NaN, 0)])).toBeNull()
  })
})

describe('readCpuSnapshot (which source)', () => {
  const cpus = () => [{ times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 } }]
  it('takes /proc/stat when its first line parses', () => {
    expect(readCpuSnapshot(() => 'cpu  1 0 1 8 0 0 0 0', cpus)).toEqual({ total: 10, idleAll: 8 })
  })
  it('falls back to os.cpus() when /proc/stat cannot be read (macOS)', () => {
    expect(readCpuSnapshot(() => { throw new Error('ENOENT /proc/stat') }, cpus)).toEqual({ total: 100, idleAll: 80 })
  })
  it('falls back to os.cpus() when the /proc/stat line does not parse', () => {
    expect(readCpuSnapshot(() => 'garbage', cpus)).toEqual({ total: 100, idleAll: 80 })
  })
  it('both sources failing -> null, never a throw', () => {
    expect(readCpuSnapshot(() => { throw new Error('no proc') }, () => { throw new Error('no cpus') })).toBeNull()
  })
})

describe('busyFrac covers the last window (LAGBUSYFRAC1109)', () => {
  beforeEach(() => {
    warn.mockClear()
    resetMonitorModule()
  })

  it('a healthy window moves the CPU baseline: the next blocked window is measured from it', () => {
    const atHealthy: CpuSnapshot = { total: 5000, idleAll: 4000 }
    const sampler = vi.fn(() => atHealthy)
    const { reader, prevCpus } = fakeReader({ cpu: { total: 6000, idleAll: 4500 } })
    expect(sampleLagOnce(fakeHistogram({ max: 10 * MS }), 1000, reader, sampler)).toBe('ok')
    expect(sampler).toHaveBeenCalledTimes(1)
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, reader, sampler)).toBe('blocked')
    // the blocked window's reader got the HEALTHY window's snapshot, not an older blocked one
    expect(prevCpus).toEqual([atHealthy])
    // a blocked window does not call the sampler: its snapshot comes from the reader
    expect(sampler).toHaveBeenCalledTimes(1)
  })

  it('a throwing sampler keeps the previous baseline and never breaks a sample', () => {
    const { reader, prevCpus } = fakeReader({ cpu: { total: 1, idleAll: 1 } })
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, reader, () => null)).toBe('blocked')
    expect(sampleLagOnce(fakeHistogram({ max: 10 * MS }), 1000, reader, () => { throw new Error('boom') })).toBe('ok')
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, reader, () => null)).toBe('blocked')
    expect(prevCpus[1]).toEqual({ total: 1, idleAll: 1 })
  })

  it('with a real monitor running, the FIRST blocked window already carries a numeric busyFrac', () => {
    const handle = startEventLoopLagMonitor()
    try {
      // let the CPU counters move past the start baseline (ms on os.cpus(), 10 ms jiffies on /proc)
      const until = Date.now() + 120
      while (Date.now() < until) { /* spin */ }
      expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS, mean: 20 * MS, percentile: () => 1500 * MS }), 1000)).toBe('blocked')
      const fields = warn.mock.calls[0][0] as Record<string, unknown>
      expect(typeof fields.busyFrac).toBe('number')
      expect(fields.busyFrac as number).toBeGreaterThanOrEqual(0)
      expect(fields.busyFrac as number).toBeLessThanOrEqual(1)
    } finally {
      handle.stop()
    }
  })

  it('with a real monitor running, a healthy window takes a REAL snapshot that the next block is measured from', () => {
    const handle = startEventLoopLagMonitor()
    try {
      // A blocked window whose reader leaves a tiny fake snapshot as the baseline...
      const first = fakeReader({ cpu: { total: 1, idleAll: 1 } })
      expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, first.reader)).toBe('blocked')
      // ...a healthy window with the monitor's own installed sampler replaces it with a real one...
      expect(sampleLagOnce(fakeHistogram({ max: 10 * MS }), 1000)).toBe('ok')
      // ...so the next block is measured from the real counters, not from {total: 1}.
      const second = fakeReader()
      expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, second.reader)).toBe('blocked')
      expect(second.prevCpus[0]).not.toBeNull()
      expect((second.prevCpus[0] as CpuSnapshot).total).toBeGreaterThan(1)
    } finally {
      handle.stop()
    }
  })

  it('stop() uninstalls the sampler too: a healthy window after stop leaves no baseline behind', () => {
    startEventLoopLagMonitor().stop()
    expect(sampleLagOnce(fakeHistogram({ max: 10 * MS }), 1000)).toBe('ok')
    const { reader, prevCpus } = fakeReader()
    expect(sampleLagOnce(fakeHistogram({ max: 2000 * MS }), 1000, reader)).toBe('blocked')
    expect(prevCpus[0]).toBeNull()
  })
})
