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

// SOURCE-LEVEL COVERAGE of the WIRING, not just the predicate. Mutation review
// (Marveen, 2026-09-06) removed the guard-side markAgentRestartPending(name)
// call and all four behavioural tests above still passed -- they exercise the
// predicate, and the bug was in the CALL SITE. This asserts the wiring the same
// way the copy-gate coverage test does: read the guard source and require that,
// on the non-main branch of performRestart, the grace is claimed BEFORE the
// restart. If someone deletes that one line, this fails.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

describe('context-guard restart wiring (DANICTXHUROK906, source-level)', () => {
  const guardSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'context-guard-runner.ts'),
    'utf-8',
  )

  it('claims the reconcile grace BEFORE restarting a non-main agent', () => {
    // Scope to the else (non-main) branch of performRestart so the assertion is
    // about the sub-agent path, not the main-agent hardRestart path.
    const perf = guardSrc.slice(guardSrc.indexOf('async function performRestart'))
    const elseIdx = perf.indexOf('} else {')
    expect(elseIdx).toBeGreaterThan(-1)
    const elseBranch = perf.slice(elseIdx)
    const markIdx = elseBranch.indexOf('markAgentRestartPending(name)')
    const restartIdx = elseBranch.indexOf('restartAgentProcess(name')
    expect(markIdx).toBeGreaterThan(-1)   // the grace-claim line exists
    expect(restartIdx).toBeGreaterThan(-1)
    expect(markIdx).toBeLessThan(restartIdx)  // and it runs BEFORE the restart
  })
})
