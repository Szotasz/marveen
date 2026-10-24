import { describe, it, expect } from 'vitest'
import { decideSubAgentWedgeRestart, parkedInputHasRemedy, parkedMainInputHasRemedy, type SubAgentWedgeFacts } from '../pane-state.js'

// 2026-08-13 designer/Frida incident. A local sub-agent whose parked input had
// no soft remedy ('hold') ended at "alerting for manual restart" and then stayed
// mute FOREVER -- designer wedged 2026-08-08 11:10 and was still wedged
// 2026-08-12 10:58, four days later, across a dashboard restart, until a human
// stopped the session by hand. MAIN has maybeRestartWedgedMainChannel for
// exactly this; sub-agents had nothing. These tests pin the new gate.

const GRACE = 10 * 60 * 1000
const MIN_INTERVAL = 20 * 60 * 1000
const MAX_CONSEC = 2
const NOW = 100_000_000

const facts = (over: Partial<SubAgentWedgeFacts> = {}): SubAgentWedgeFacts => ({
  parked: true,
  attempts: 5,
  maxAttempts: 5,
  softRemedy: false,
  paneState: 'typing',
  wedgeAgeMs: GRACE,
  graceMs: GRACE,
  now: NOW,
  lastRestartAt: 0,
  restartCount: 0,
  minIntervalMs: MIN_INTERVAL,
  maxConsecutive: MAX_CONSEC,
  ...over,
})

describe('decideSubAgentWedgeRestart', () => {
  it('restarts the exact Frida shape: parked, budget spent, no remedy, past grace', () => {
    expect(decideSubAgentWedgeRestart(facts())).toBe('restart')
  })

  it('restarts even though the park is NOT machine-origin -- that is the whole point', () => {
    // MAIN's carve-out requires machineOrigin; a head-lost delivery frame has no
    // surviving wrapper prefix, so that gate would refuse precisely the real
    // wedge. This gate substitutes the grace window, and never consults origin.
    expect(decideSubAgentWedgeRestart(facts({ paneState: 'typing' }))).toBe('restart')
  })

  it('skips while soft recovery still has budget left', () => {
    expect(decideSubAgentWedgeRestart(facts({ attempts: 4 }))).toBe('skip')
  })

  it('skips when soft recovery still has a move (re-inject would submit it)', () => {
    expect(decideSubAgentWedgeRestart(facts({ softRemedy: true }))).toBe('skip')
  })

  it('skips when the box is not parked at all', () => {
    expect(decideSubAgentWedgeRestart(facts({ parked: false }))).toBe('skip')
  })

  it('never restarts a busy pane -- that is work in progress, not a wedge', () => {
    expect(decideSubAgentWedgeRestart(facts({ paneState: 'busy' }))).toBe('skip')
  })

  it('holds off until the grace window has fully elapsed (human-draft safety)', () => {
    expect(decideSubAgentWedgeRestart(facts({ wedgeAgeMs: GRACE - 1 }))).toBe('skip')
    expect(decideSubAgentWedgeRestart(facts({ wedgeAgeMs: GRACE }))).toBe('restart')
  })

  it('rate-limits consecutive restarts', () => {
    expect(decideSubAgentWedgeRestart(facts({ lastRestartAt: NOW - (MIN_INTERVAL - 1) }))).toBe('skip')
    expect(decideSubAgentWedgeRestart(facts({ lastRestartAt: NOW - MIN_INTERVAL }))).toBe('restart')
  })

  it('alerts exactly once when restarts cannot clear the wedge, then goes quiet', () => {
    expect(decideSubAgentWedgeRestart(facts({ restartCount: MAX_CONSEC }))).toBe('alert')
    expect(decideSubAgentWedgeRestart(facts({ restartCount: MAX_CONSEC + 1 }))).toBe('skip')
  })

  it('fails conservative on an unreadable pane state (null never forces a restart path change)', () => {
    // null pane state is not 'busy', so it follows the normal gates -- but the
    // caller passes softRemedy=true for an unreadable pane, which skips.
    expect(decideSubAgentWedgeRestart(facts({ paneState: null, softRemedy: true }))).toBe('skip')
  })
})

// parkedInputHasRemedy generalises parkedMainInputHasRemedy over the
// allowPlainReinject flag. MAIN's behaviour must not shift.
describe('parkedInputHasRemedy', () => {
  const multiRowPlainPark = [
    '╭──────────────────────────────────────────╮',
    '│ > Kanban-audit: a kartya frissitese kell │',
    '│   es meg egy sor amitol tobbsoros lesz   │',
    '╰──────────────────────────────────────────╯',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('keeps the MAIN wrapper answering exactly as before', () => {
    expect(parkedMainInputHasRemedy(multiRowPlainPark)).toBe(parkedInputHasRemedy(multiRowPlainPark, false))
  })

  // Upstream (#1345, GH #717) tightened decideStuckInputAction after this
  // branch forked: a park with no POSITIVE machine origin now answers 'hold',
  // because pressing Enter on text that might be a human draft submits it
  // irreversibly. So an empty box answers false here as well -- from this
  // function's point of view "nothing parked" and "parked but unsubmittable"
  // are one answer, and the flag cannot change it either way.
  //
  // That does NOT loosen the wedge gate. An empty box never reaches the remedy
  // check: maybeRestartWedgedSubAgent returns on state.parkedSig === null, and
  // the gate itself skips on parked: false (pinned above). What the tightening
  // does change is that MORE real parks read no-remedy -- which is exactly the
  // head-lost delivery frame this escalation was written for, still held back
  // by the full attempts budget plus the grace window.
  it('answers identically for both flags when the park carries no machine origin', () => {
    const idle = ['╭────────────╮', '│ >          │', '╰────────────╯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(parkedInputHasRemedy(idle, true)).toBe(parkedInputHasRemedy(idle, false))
  })
})
