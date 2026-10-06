import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideSkipTrace, decideMenuPassTrace,
  SKIP_TRACE_THRESHOLD, SKIP_TRACE_REPEAT_EVERY, MENU_PASS_TRACE_INTERVAL_MS,
} from '../web/monitor-trace.js'

// MODALOROSHATOKOR922 -- the channel-monitor's blocking-menu pass was silent for
// ten minutes while an agent sat on a permission prompt, and the log could not
// say whether the pass ran and saw nothing or never ran (the re-entrancy guard
// logs at DEBUG). These decisions give the monitor a rate-limited INFO trace.
// The trace does NOT fix the silence; it makes it measurable. The tests pin the
// two thresholds so a later "tidy-up" cannot quietly turn the trace back off.

describe('decideSkipTrace: consecutive skipped ticks become visible', () => {
  it('stays quiet below the threshold', () => {
    let st = { consecutive: 0 }
    for (let i = 1; i < SKIP_TRACE_THRESHOLD; i++) {
      const d = decideSkipTrace(st)
      expect(d.emit).toBe(false)
      expect(d.next.consecutive).toBe(i)
      st = d.next
    }
  })

  it('emits exactly at the threshold, then every REPEAT_EVERY-th skip, not on each one', () => {
    let st = { consecutive: 0 }
    const emitted: number[] = []
    for (let i = 1; i <= SKIP_TRACE_THRESHOLD + 2 * SKIP_TRACE_REPEAT_EVERY + 1; i++) {
      const d = decideSkipTrace(st)
      if (d.emit) emitted.push(i)
      st = d.next
    }
    expect(emitted).toEqual([
      SKIP_TRACE_THRESHOLD,
      SKIP_TRACE_THRESHOLD + SKIP_TRACE_REPEAT_EVERY,
      SKIP_TRACE_THRESHOLD + 2 * SKIP_TRACE_REPEAT_EVERY,
    ])
  })

  it('a run of check() resets the count (the caller sets consecutive back to 0)', () => {
    const d = decideSkipTrace({ consecutive: 0 })
    expect(d.next.consecutive).toBe(1)
    // the monitor resets to { consecutive: 0 } on every tick that actually runs;
    // the next skip after a run therefore starts from 1 again
    expect(decideSkipTrace({ consecutive: 0 }).emit).toBe(false)
  })
})

describe('decideMenuPassTrace: one INFO line per interval, and one at boot', () => {
  it('the first pass after boot always emits -- a dashboard that never reaches the pass must differ from one that sees nothing', () => {
    expect(decideMenuPassTrace(null, 1_000_000)).toBe(true)
  })

  it('does not emit inside the interval, emits once it has elapsed', () => {
    const t0 = 1_000_000
    expect(decideMenuPassTrace(t0, t0 + MENU_PASS_TRACE_INTERVAL_MS - 1)).toBe(false)
    expect(decideMenuPassTrace(t0, t0 + MENU_PASS_TRACE_INTERVAL_MS)).toBe(true)
  })

  it('the interval is five minutes, as the card asked', () => {
    expect(MENU_PASS_TRACE_INTERVAL_MS).toBe(5 * 60 * 1000)
    expect(SKIP_TRACE_THRESHOLD).toBe(3)
  })
})

describe('the monitor is wired to both decisions', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')

  it('the re-entrancy guard consults decideSkipTrace and logs the skip at INFO when told to', () => {
    expect(src).toMatch(/const skip = decideSkipTrace\(skipTrace\)/)
    expect(src).toMatch(/logger\.info\([^\n]*consecutiveSkips[^\n]*'channel-monitor: previous check still running -- consecutive ticks skipped'\)/)
  })

  it('a tick that runs resets the skip count before the sweep', () => {
    expect(src).toMatch(/skipTrace = \{ consecutive: 0 \}\n\s*checkRunning = true/)
  })

  it('the menu pass emits the rate-limited trace with the walked/in-menu counts', () => {
    expect(src).toMatch(/decideMenuPassTrace\(menuTraceLastAt, /)
    expect(src).toMatch(/'channel-monitor: menu-pass trace'/)
    expect(src).toMatch(/menuTargetsWalked\+\+/)
    expect(src).toMatch(/if \(inMenu\) menuTargetsInMenu\+\+/)
  })
})
