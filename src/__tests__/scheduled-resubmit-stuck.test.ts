import { describe, it, expect } from 'vitest'
import { isScheduledPromptStuck, decideScheduledResubmitAction } from '../web/schedule-runner.js'

const MARKER = '[Utemezett feladat: deli-kutatas]'

// The measured 2026-07-28 12:00 field case: the prompt was SUBMITTED and the
// session was actively working on it (WebSearch running). The marker is
// visible in the transcript echo, the pane is busy, and the input box is
// empty. The old busy-blind check judged this stuck and pressed keystrokes
// into a working session.
const WORKING_PANE = `
  ${MARKER}
  Vegezd el a deli kutatast a szokasos forrasokbol.
  ✻ Baking… (12s · esc to interrupt)
─────────────────────────────────────────────
❯
─────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`

// The genuine swallowed-Enter case the ladder exists for: OUR prompt text is
// parked IN the input box (marker at/after the last ❯), session idle.
const PARKED_PANE = `
  Previous turn output above.
─────────────────────────────────────────────
❯ ${MARKER} Vegezd el a deli kutatast.
─────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`

// Input-pollution scenario (the harm class SCHEDDUP1 is really about): some
// OTHER message parked in the input box while our submitted prompt's echo is
// still on screen above. A bare Enter here would submit a message nobody
// meant to send. The marker is NOT in the input region -> no keystroke.
const OTHER_PARKED_PANE = `
  ${MARKER}
  Vegezd el a deli kutatast a szokasos forrasokbol.
─────────────────────────────────────────────
❯ [Uzenet @marveen-tol]: fontos kerdes, ne kuldd el veletlenul
─────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`

describe('isScheduledPromptStuck (SCHEDDUP1 invariants)', () => {
  // INVARIANT 1: a busy pane is NEVER stuck. If this test starts failing
  // because the busy exclusion was "simplified" away, the recovery ladder is
  // back to pressing keystrokes into working sessions -- do not remove the
  // guard, fix the detector.
  it('busy pane is never stuck, even with the marker on screen', () => {
    expect(isScheduledPromptStuck(WORKING_PANE, MARKER)).toBe(false)
  })

  // INVARIANT 2: the marker must be IN the input region (at/after the last
  // prompt box), not merely anywhere in the pane. Scrollback echo of a
  // submitted prompt is the running/finished case, not the parked case.
  it('marker only in scrollback is not stuck (the measured noon case shape)', () => {
    const idleEcho = WORKING_PANE.replace('✻ Baking… (12s · esc to interrupt)\n', '')
    expect(isScheduledPromptStuck(idleEcho, MARKER)).toBe(false)
  })

  // INVARIANT 3 -- the bare-Enter safety argument: an UNRELATED parked
  // message never triggers the ladder, so the ladder's Enter can only ever
  // submit our own scheduled prompt.
  it('an unrelated parked message never counts as stuck', () => {
    expect(isScheduledPromptStuck(OTHER_PARKED_PANE, MARKER)).toBe(false)
  })

  it('detects the genuine parked-own-prompt case', () => {
    expect(isScheduledPromptStuck(PARKED_PANE, MARKER)).toBe(true)
  })

  it('null and empty panes are not stuck', () => {
    expect(isScheduledPromptStuck(null, MARKER)).toBe(false)
    expect(isScheduledPromptStuck('', MARKER)).toBe(false)
    expect(isScheduledPromptStuck('   \n  ', MARKER)).toBe(false)
  })

  it('a pane with no prompt box is not stuck', () => {
    expect(isScheduledPromptStuck(`  ${MARKER}\n  some output`, MARKER)).toBe(false)
  })
})

describe('decideScheduledResubmitAction ladder (unchanged semantics)', () => {
  it('not stuck -> none at any attempt', () => {
    for (const a of [0, 1, 2, 5, 6, 10]) expect(decideScheduledResubmitAction(a, false)).toBe('none')
  })
  it('escalates enter -> reinject -> giveup', () => {
    expect(decideScheduledResubmitAction(0, true)).toBe('enter')
    expect(decideScheduledResubmitAction(1, true)).toBe('enter')
    expect(decideScheduledResubmitAction(2, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(5, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(6, true)).toBe('giveup')
  })
})
