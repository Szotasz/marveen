// The 'dead' reading is only worth as much as the number of places that ask
// for it. paneActivityLabel is shared by /api/agents/activity AND
// /api/agents/status precisely so the two surfaces cannot disagree about one
// pane -- but the pane's foreground command is an OPTIONAL third argument, so
// a call site that forgets it silently falls back to the old behaviour and
// reports a dead agent as 'idle' on that surface only.
//
// MEASURED 2026-09-25: with the wiring removed from the status route, the
// whole suite (529 files, 6642 tests) still passed. Nothing else covers it.
// These assertions are the mutation detector: they pin the call SHAPE at each
// root, not any wording.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')

describe('the dead-vs-idle reading reaches every surface that labels a pane', () => {
  it('routes the shared label through activityState, not a second copy of the rules', () => {
    const body = agentsSource.slice(
      agentsSource.indexOf('function paneActivityLabel('),
      agentsSource.indexOf('function paneActivityLabel(') + 400,
    )
    expect(body).toContain('activityState({ running, pane, paneCommand })')
  })

  it('passes the pane command from both /api/agents/activity call sites', () => {
    expect(agentsSource).toContain('state: paneActivityLabel(running, mainPane, mainPaneCommand),')
    expect(agentsSource).toContain("'unreachable' : paneActivityLabel(running, pane, paneCommand)")
  })

  it('passes the pane command from both /api/agents/status call sites', () => {
    expect(agentsSource).toContain(
      "signalsFor(MAIN_AGENT_ID, true, running, mainPane, running ? 'running' : 'stopped', mainPaneCommand)",
    )
    expect(agentsSource).toContain('signalsFor(name, false, running, pane, runState, paneCommand)')
  })

  it('reads the command for local sessions only, so a remote agent costs no extra ssh round-trip', () => {
    const localOnly = agentsSource.match(/running && !host \? paneCurrentCommand\(agentSessionName\(name\)\) : null/g)
    // one in the activity route, one in the status route
    expect(localOnly?.length).toBe(2)
  })
})
