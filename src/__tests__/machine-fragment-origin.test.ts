import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  resolveMachineOrigin,
  noteMachineFragmentLeft,
  clearMachineFragmentLeft,
  hasMachineFragmentLeft,
  onClearResult,
  onParkedState,
  applyStuckRestartBusyGuard,
} from '../web/channel-monitor.js'

// CSONKABORITEK915.
//
// A failed clearInputBuffer leaves a fragment parked that WE injected. The
// capture-derived heuristic (parkedMachineOriginInput) can only see what is
// still in the box, and a cut that removed both the wrapper prefix and every
// truncated-marker sentence leaves NOTHING to recognise. The guard then reads
// the leftover as "possibly a human draft" and defers the restart forever --
// measured 2026-09-03 (25.4h mute) and still live: 10 failed clears produced
// 0 pane restarts over one runner lifetime.
//
// The fix is not a better detector: the fact is not in the bytes. We remember
// that we are the ones who left it.

const SESSION = 'main-channels'

describe('resolveMachineOrigin', () => {
  it('is true when the capture heuristic recognises the fragment', () => {
    expect(resolveMachineOrigin(true, false)).toBe(true)
  })

  it('is true when WE left the fragment, even though the capture shows nothing recognisable', () => {
    // This is the whole point: heuristic=false is exactly the wedge shape.
    expect(resolveMachineOrigin(false, true)).toBe(true)
  })

  it('stays false when neither source claims machine origin -- a real human draft is untouched', () => {
    expect(resolveMachineOrigin(false, false)).toBe(false)
  })

  it('never lets our record SUBTRACT machine origin (the heuristic firing is authoritative)', () => {
    expect(resolveMachineOrigin(true, true)).toBe(true)
  })
})

describe('machine-fragment record lifecycle', () => {
  beforeEach(() => clearMachineFragmentLeft(SESSION))

  it('starts empty', () => {
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it('records a failed clear and survives until the box is proven empty', () => {
    noteMachineFragmentLeft(SESSION)
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
    // Repeated ticks must not lose it -- the wedge lasted 25.4h across many ticks.
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
  })

  it('is cleared when the box empties, so a later human draft cannot inherit it', () => {
    noteMachineFragmentLeft(SESSION)
    clearMachineFragmentLeft(SESSION)
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it('is per-session: a sub-agent fragment does not mark the main session', () => {
    noteMachineFragmentLeft('agent-other')
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
    clearMachineFragmentLeft('agent-other')
  })
})

describe('end-to-end effect on the restart guard', () => {
  // The carve-out that the wedge was blocking: on a 'typing' pane the restart
  // is only allowed when the parked text is machine-origin AND soft recovery
  // has no remedy left.
  const guard = (machineOrigin: boolean) =>
    applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin, softRemedy: false })

  it('BEFORE the fix: an unrecognisable fragment defers forever', () => {
    // heuristic alone, no record -> skip. This is the bug, pinned as a control:
    // if this ever starts returning 'restart' on its own, the test below proves
    // nothing.
    expect(guard(resolveMachineOrigin(false, false))).toBe('skip')
  })

  it('AFTER the fix: the same fragment escalates, because we know we left it', () => {
    expect(guard(resolveMachineOrigin(false, true))).toBe('restart')
  })

  it('a genuine human draft still defers -- the fix must not buy the restart with a false positive', () => {
    expect(guard(resolveMachineOrigin(false, false))).toBe('skip')
  })

  it('a busy pane is never restarted, whatever the origin says', () => {
    expect(applyStuckRestartBusyGuard('busy', 'restart', { machineOrigin: true, softRemedy: false })).toBe('skip')
  })

  it('a machine fragment with a soft remedy left still defers to the soft path', () => {
    expect(applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: true, softRemedy: true })).toBe('skip')
  })
})

// The lifecycle DECISIONS, tested directly. The block above pins the store
// (note/clear/has) and the pure OR; neither notices if a call site stops asking.
describe('onClearResult: what each clear outcome is allowed to record', () => {
  beforeEach(() => clearMachineFragmentLeft(SESSION))

  it("'left-fragment' records it -- this is the only outcome that is a fact about the BOX", () => {
    onClearResult(SESSION, 'left-fragment')
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
  })

  it("'cleared' records nothing", () => {
    onClearResult(SESSION, 'cleared')
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it("'skipped-locked' records nothing -- we never touched the box", () => {
    onClearResult(SESSION, 'skipped-locked')
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it("'cleared' does NOT erase an earlier record either -- forgetting has one owner", () => {
    // A clear returning true is a claim about our own ACTION. This whole fix
    // exists because such a claim was wrong: the box still had text in it.
    // Only an OBSERVED empty box (onParkedState) may forget.
    onClearResult(SESSION, 'left-fragment')
    onClearResult(SESSION, 'cleared')
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
  })

  it('is per-session', () => {
    onClearResult('agent-other', 'left-fragment')
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
    clearMachineFragmentLeft('agent-other')
  })
})

describe('onParkedState: the record dies only when the box is OBSERVED empty', () => {
  beforeEach(() => clearMachineFragmentLeft(SESSION))

  it('clears on an empty box, so a later human draft cannot inherit the flag', () => {
    noteMachineFragmentLeft(SESSION)
    onParkedState(SESSION, false)
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it('keeps the record while text is still parked -- the 2026-09-03 wedge lasted 25.4h of ticks', () => {
    noteMachineFragmentLeft(SESSION)
    onParkedState(SESSION, true)
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
  })

  it('an empty box on a session that never had a record is a no-op', () => {
    onParkedState(SESSION, false)
    expect(hasMachineFragmentLeft(SESSION)).toBe(false)
  })

  it('is per-session: another pane emptying does not forget ours', () => {
    noteMachineFragmentLeft(SESSION)
    onParkedState('agent-other', false)
    expect(hasMachineFragmentLeft(SESSION)).toBe(true)
  })
})

// A decision that is never consulted is indistinguishable from no decision.
// Same shape as the repo's other caller checks (channel-monitor-respawn-session-gone,
// channel-monitor-session-recreate): a real tmux interaction cannot be driven from a
// unit test, so the assert reads the source and pins the WIRING. Measured on this
// branch before this file grew: removing any one of these three calls left the whole
// suite green.
describe('the call sites actually use the decisions', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')

  function sliceFn(name: string): string {
    const start = src.indexOf('function ' + name)
    expect(start, name + ' not found').toBeGreaterThan(0)
    const end = src.indexOf('\n}\n', start)
    expect(end, name + ' closing brace not found').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  function sliceCase(label: string): string {
    const start = src.indexOf("case '" + label + "': {")
    expect(start, label + ' case not found').toBeGreaterThan(0)
    const end = src.indexOf('\n      }\n', start)
    expect(end, label + ' case end not found').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('clear-preamble hands its clear result to onClearResult', () => {
    expect(sliceCase('clear-preamble')).toMatch(/onClearResult\(session, result\)/)
  })

  it('clear-scheduled hands its clear result to onClearResult', () => {
    expect(sliceCase('clear-scheduled')).toMatch(/onClearResult\(session, result\)/)
  })

  it('the restart guard reports the parked state to onParkedState', () => {
    expect(sliceFn('maybeRestartWedgedMainChannel'))
      .toMatch(/onParkedState\(MAIN_CHANNELS_SESSION, parked\)/)
  })

  it('the empty-box report happens BEFORE the early return, so it runs on every tick', () => {
    const body = sliceFn('maybeRestartWedgedMainChannel')
    const report = body.indexOf('onParkedState(')
    const earlyReturn = body.indexOf('if (!parked)')
    expect(report, 'onParkedState call not found').toBeGreaterThan(0)
    expect(report).toBeLessThan(earlyReturn)
  })

  it('the guard feeds OUR RECORD into resolveMachineOrigin, not just the capture heuristic', () => {
    // This is the binding the PR body named: with `false` in place of the lookup
    // the decision still decides correctly and never changes anything.
    expect(sliceFn('maybeRestartWedgedMainChannel')).toMatch(
      /resolveMachineOrigin\(\s*parkedView != null && parkedMachineOriginInput\(parkedView\),\s*hasMachineFragmentLeft\(MAIN_CHANNELS_SESSION\),/,
    )
  })
})
