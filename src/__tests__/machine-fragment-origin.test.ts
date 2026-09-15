import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveMachineOrigin,
  noteMachineFragmentLeft,
  clearMachineFragmentLeft,
  hasMachineFragmentLeft,
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
