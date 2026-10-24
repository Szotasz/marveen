import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { logger } from '../logger.js'
import { scheduleDecaySweep, DECAY_FIRST_SWEEP_DELAY_MS } from '../decay-schedule.js'

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('scheduleDecaySweep', () => {
  it('T1: defers first run, then repeats at interval', () => {
    const run = vi.fn()
    scheduleDecaySweep(run, 1000, 500)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('T2: default first delay is 60 s', () => {
    expect(DECAY_FIRST_SWEEP_DELAY_MS).toBe(60_000)
    const run = vi.fn()
    scheduleDecaySweep(run, 10_000)
    vi.advanceTimersByTime(DECAY_FIRST_SWEEP_DELAY_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('T3: stop before first run prevents any run', () => {
    const run = vi.fn()
    const stop = scheduleDecaySweep(run, 1000, 500)
    stop()
    vi.advanceTimersByTime(10_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('T4: stop after first run prevents further runs', () => {
    const run = vi.fn()
    const stop = scheduleDecaySweep(run, 1000, 500)
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(1)
    stop()
    vi.advanceTimersByTime(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('T5: a throwing run is logged and the interval continues', () => {
    let calls = 0
    const run = () => { calls++; throw new Error('boom') }
    scheduleDecaySweep(run, 1000, 500)
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(calls).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'memory decay sweep failed')
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(calls).toBe(2)
  })
})

// Naive comment stripper for the static checks: block comments, then line
// comments. index.ts has no "//" or "/*" inside string literals near these lines.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('index.ts wiring', () => {
  it('T6: startup uses the deferred schedule', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8')
    const lines = stripComments(src).split('\n')
    const direct = /^\s*runDecaySweep\(\)/
    expect(direct.test('  runDecaySweep()')).toBe(true)
    expect(stripComments(src)).toContain('scheduleDecaySweep(runDecaySweep, DECAY_SWEEP_INTERVAL_MS)')
    expect(lines.some(l => direct.test(l))).toBe(false)
    expect(lines.some(l => /setInterval\(runDecaySweep/.test(l))).toBe(false)
    // Any other reference (an alias called eagerly, a second schedule) would be a
    // third mention: the import and the schedule argument are the only two allowed.
    const code = stripComments(src)
    expect(code.match(/\brunDecaySweep\b/g)?.length).toBe(2)
    expect('a runDecaySweep b runDecaySweep'.match(/\brunDecaySweep\b/g)?.length).toBe(2)
  })

  it('T7: the shutdown path stops the schedule', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8')
    // The shutdown handler clears every timer in one block, right before the hard-kill timeout.
    const start = src.indexOf("stopStoreWatcher threw during shutdown")
    const end = src.indexOf('const hardKill = setTimeout(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    // Comments stripped, so a commented-out stop call does not count.
    // Tolerant of a braced form; a commented-out call is stripped first.
    const stopCall = /if\s*\(\s*stopDecaySweep\s*\)\s*\{?\s*stopDecaySweep\(\)/
    expect(stopCall.test(stripComments(src.slice(start, end)))).toBe(true)
    expect(stopCall.test('if (stopDecaySweep) {\n      stopDecaySweep()\n    }')).toBe(true)
    expect(stripComments('a // if (stopDecaySweep) stopDecaySweep()\nb')).not.toContain('stopDecaySweep()')
  })
})
