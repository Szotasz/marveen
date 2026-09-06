import { describe, it, expect } from 'vitest'
import { markAgentRestartPending, isWithinRestartGrace } from '../web/channel-monitor.js'

// DANICTXHUROK906. The context-guard restart (stop + fresh start) was invisible
// to reconcileDesiredAgents(): the guard never wrote the agentLastRestart map,
// so in the window between the guard's stop and its fresh start the reconcile
// loop saw the agent "down" and re-launched it non-fresh (--continue). These
// tests pin the fix at the seam that matters: the guard marking the restart
// makes the reconcile grace predicate return true, so the loop defers.
//
// Each test uses a UNIQUE agent name because agentLastRestart is a module-level
// Map that persists across tests -- a shared name would leak the mark.
describe('context-guard / reconcile restart race (DANICTXHUROK906)', () => {
  it('an unmarked agent is not in grace (reconcile is free to act)', () => {
    expect(isWithinRestartGrace('dani-race-unmarked', Date.now())).toBe(false)
  })

  it('marking a restart puts the agent inside the grace window', () => {
    const name = 'dani-race-marked'
    expect(isWithinRestartGrace(name, Date.now())).toBe(false)
    markAgentRestartPending(name)
    // The guard's stop happens right after this; reconcile must skip the agent.
    expect(isWithinRestartGrace(name, Date.now())).toBe(true)
  })

  it('the grace covers a full guard stop+fresh-start (still true seconds later)', () => {
    const name = 'dani-race-window'
    const t0 = Date.now()
    markAgentRestartPending(name)
    // A guard restart is 1-2s; the grace is 90s, so a check 10s later still defers.
    expect(isWithinRestartGrace(name, t0 + 10_000)).toBe(true)
  })

  it('the grace expires so a genuinely-crashed agent is still reconciled later', () => {
    const name = 'dani-race-expiry'
    const t0 = Date.now()
    markAgentRestartPending(name)
    // Past the 90s window: if the agent is down for real, reconcile may act.
    expect(isWithinRestartGrace(name, t0 + 91_000)).toBe(false)
  })
})
