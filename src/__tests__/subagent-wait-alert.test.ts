// SUBWAIT925 (card c3f8f062): a sub-agent parked on an approval dialog or on a
// frozen tool-call counter must reach the owner as an alert. The 2026-09-23
// incident: kigyo's strict-profile session held a cross-session message for
// approval for hours; no watcher recognised that dialog, so nothing alerted.
// These tests pin the detector for that dialog, the classification, and the
// alert-only sweep (confirm window, dedup, clearing, never a keystroke).

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsHeldPeerMessage, detectsPermissionDialog, type StuckToolCallState } from '../pane-state.js'
import {
  classifyAgentWait,
  sweepSubAgents,
  resetSubAgentWatchState,
  formatAgentWaitAlert,
  formatAgentStuckAlert,
  AGENT_WAIT_THRESHOLDS,
  type SubAgentSweepDeps,
} from '../web/stuck-tool-call-watcher.js'
import { MAIN_AGENT_ID } from '../config.js'

const load = (n: string) => readFileSync(join(__dirname, `fixtures/pane/${n}.txt`), 'utf8')
const PERMISSION_PANE = load('permission-prompt-bash-grep')

// The held-peer-message dialog, built from the dialog's own strings in the
// installed Claude Code binary (2.1.x). The exact layout around them is not
// pinned: the detector keys on the phrases, guarded by busy/idle checks.
const HELD_PEER_PANE = [
  '  Reviewed the branch, waiting for the next instruction.',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  ' A message from another session needs your approval',
  '',
  ' Another Claude session sent a message: from uds:/tmp/cc-socks/21286.sock (claims name: Klaudia)',
  '',
  ' Message body (this is what will be delivered):',
  ' │ Please rebase the PR onto develop.',
  '',
  ' ❯ 1. Deliver',
  '   2. Ignore',
  '',
].join('\n')

const IDLE_PANE = [
  '  Done.',
  '',
  '❯ ',
  '  ? for shortcuts',
].join('\n')

const busyPane = (seconds: number) => [
  '  Running the test suite...',
  '',
  `✻ Worked for ${seconds}s`,
  '',
  '  esc to interrupt',
].join('\n')

describe('detectsHeldPeerMessage', () => {
  it('recognises the held cross-session message dialog', () => {
    expect(detectsHeldPeerMessage(HELD_PEER_PANE)).toBe(true)
    // It is NOT the tool-permission card: that detector must stay quiet here.
    expect(detectsPermissionDialog(HELD_PEER_PANE)).toBe(false)
  })
  it('stays quiet on a busy pane that merely echoes the phrase', () => {
    const pane = HELD_PEER_PANE + '\n✻ Worked for 3s\n  esc to interrupt'
    expect(detectsHeldPeerMessage(pane)).toBe(false)
  })
  it('stays quiet when the idle footer is live (the phrase is quoted text)', () => {
    const pane = '  "A message from another session needs your approval" was the line I saw.\n\n❯ \n  ? for shortcuts'
    expect(detectsHeldPeerMessage(pane)).toBe(false)
  })
  it('stays quiet on an empty or idle pane', () => {
    expect(detectsHeldPeerMessage('')).toBe(false)
    expect(detectsHeldPeerMessage(IDLE_PANE)).toBe(false)
  })
})

describe('classifyAgentWait', () => {
  it('maps the two dialogs and nothing else', () => {
    expect(classifyAgentWait(PERMISSION_PANE)).toBe('permission')
    expect(classifyAgentWait(HELD_PEER_PANE)).toBe('peer-message')
    expect(classifyAgentWait(IDLE_PANE)).toBeNull()
    expect(classifyAgentWait(busyPane(12))).toBeNull()
    expect(classifyAgentWait(null)).toBeNull()
  })
})

describe('alert texts', () => {
  it('a waiting prompt is framed as a question, names the agent and the pane, never as a crash', () => {
    const t = formatAgentWaitAlert('kigyo', 'agent-kigyo', 'permission', 4 * 60_000, { title: 'Bash command', reason: 'needs approval' })
    expect(t).toContain('kigyo')
    expect(t).toContain('4 perce')
    expect(t).toContain('Bash command: needs approval')
    expect(t).toContain('tmux attach -t agent-kigyo')
    expect(t).not.toMatch(/összeomlott|beragadt/)
    const p = formatAgentWaitAlert('cella', 'agent-cella', 'peer-message', 60_000, null)
    expect(p).toContain('másik sessionből')
    expect(p).toContain('tmux attach -t agent-cella')
  })
  it('a stuck counter says it was NOT restarted', () => {
    const st: StuckToolCallState = { tag: 'worked', spellStartSeconds: 31, spellPeakSeconds: 31, firstSeenAt: 1, lastSeconds: 31, stagnantPolls: 7, stagnantSince: 1, attempts: 1 }
    const t = formatAgentStuckAlert('konnektor', 'agent-konnektor', st, { freezeSeconds: 180, stagnantPolls: 2, minPeakSeconds: 20 })
    expect(t).toContain('konnektor')
    expect(t).toContain('31s')
    expect(t).toContain('NEM indítottam újra')
  })
})

type Alert = { agent: string; kind: string; waitingMs?: number; ask?: unknown }

function makeDeps(panes: Record<string, () => string | null>, clock: { now: number }, running: (a: string) => boolean = () => true) {
  const alerts: Alert[] = []
  const deps: SubAgentSweepDeps = {
    listAgents: () => Object.keys(panes),
    isRunning: running,
    capture: (agent) => panes[agent]?.() ?? null,
    now: () => clock.now,
    alertWait: (agent, _session, kind, waitingMs, ask) => { alerts.push({ agent, kind, waitingMs, ask }) },
    alertStuck: (agent) => { alerts.push({ agent, kind: 'stuck' }) },
  }
  return { deps, alerts }
}

describe('sweepSubAgents', () => {
  beforeEach(() => resetSubAgentWatchState())
  const MIN = 60_000

  it('alerts once a permission prompt outlives the confirm window, with the question quoted', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ kigyo: () => PERMISSION_PANE }, clock)
    sweepSubAgents(deps)                       // first sighting: record only
    clock.now += 1 * MIN; sweepSubAgents(deps)  // 1 min: inside the confirm window
    expect(alerts).toEqual([])
    clock.now += 2.5 * MIN; sweepSubAgents(deps) // 3.5 min: sustained
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ agent: 'kigyo', kind: 'permission' })
    expect(alerts[0].waitingMs).toBe(3.5 * MIN)
    expect((alerts[0].ask as { title: string }).title).toMatch(/Bash command/)
  })

  it('does not repeat inside the dedup window, repeats after it while still waiting, clears when answered', () => {
    const clock = { now: 1_000_000 }
    let pane: string | null = HELD_PEER_PANE
    const { deps, alerts } = makeDeps({ kigyo: () => pane }, clock)
    sweepSubAgents(deps)
    clock.now += AGENT_WAIT_THRESHOLDS.confirmMs + 1000; sweepSubAgents(deps)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('peer-message')
    clock.now += 5 * MIN; sweepSubAgents(deps)
    expect(alerts).toHaveLength(1)               // dedup
    clock.now += AGENT_WAIT_THRESHOLDS.dedupMs; sweepSubAgents(deps)
    expect(alerts).toHaveLength(2)               // still waiting: say so again
    pane = IDLE_PANE                             // answered
    clock.now += 1 * MIN; sweepSubAgents(deps)
    clock.now += AGENT_WAIT_THRESHOLDS.clearMs + 1000; sweepSubAgents(deps)
    pane = HELD_PEER_PANE                        // a NEW question later starts a fresh spell
    clock.now += 1 * MIN; sweepSubAgents(deps)
    clock.now += 1 * MIN; sweepSubAgents(deps)   // 1 min into the new spell: no alert yet
    expect(alerts).toHaveLength(2)
  })

  it('a prompt answered quickly never alerts', () => {
    const clock = { now: 1_000_000 }
    let pane: string | null = PERMISSION_PANE
    const { deps, alerts } = makeDeps({ kigyo: () => pane }, clock)
    sweepSubAgents(deps)
    clock.now += 1 * MIN; pane = IDLE_PANE; sweepSubAgents(deps)
    clock.now += 10 * MIN; sweepSubAgents(deps)
    expect(alerts).toEqual([])
  })

  it('skips the main agent and agents that are not running', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ [MAIN_AGENT_ID]: () => PERMISSION_PANE, cella: () => PERMISSION_PANE, konnektor: () => PERMISSION_PANE }, clock, (a) => a !== 'konnektor')
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts.map((a) => a.agent)).toEqual(['cella'])
  })

  it('a capture failure on one agent does not hide the others', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => { throw new Error('tmux down') }, kigyo: () => PERMISSION_PANE }, clock)
    for (let i = 0; i < 3; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts.map((a) => a.agent)).toEqual(['kigyo'])
  })

  it('reports a stagnant tool-call counter once per spell and never for an idle residual', () => {
    const clock = { now: 1_000_000 }
    let pane: string | null = busyPane(31)
    const { deps, alerts } = makeDeps({ ketely: () => pane }, clock)
    // Same cadence as the main-path contract: 30s polls, 180s of stagnation.
    for (let i = 0; i < 8; i++) { sweepSubAgents(deps); clock.now += 30_000 }
    expect(alerts).toEqual([{ agent: 'ketely', kind: 'stuck' }])
    for (let i = 0; i < 4; i++) { sweepSubAgents(deps); clock.now += 30_000 }
    expect(alerts).toHaveLength(1)               // one report per spell
    // A residual footer above a live idle prompt is a completed turn, not a wedge.
    resetSubAgentWatchState()
    pane = busyPane(31).replace('  esc to interrupt', '❯ \n  ? for shortcuts')
    for (let i = 0; i < 10; i++) { sweepSubAgents(deps); clock.now += 30_000 }
    expect(alerts).toHaveLength(1)
  })

  it('a progressing counter never alerts', () => {
    const clock = { now: 1_000_000 }
    let s = 20
    const { deps, alerts } = makeDeps({ kigyo: () => busyPane(s) }, clock)
    for (let i = 0; i < 12; i++) { sweepSubAgents(deps); clock.now += 30_000; s += 30 }
    expect(alerts).toEqual([])
  })
})
