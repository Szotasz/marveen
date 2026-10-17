// SUBWAIT925 (card c3f8f062): a sub-agent parked on an approval dialog must
// reach the owner as an alert. The 2026-09-23 incident: kigyo's strict-profile
// session held a cross-session message for approval for hours; no watcher
// recognised that dialog, so nothing alerted. These tests pin the detector for
// that dialog (anchored on its title), the classification, the menu pass never
// Escaping it, and the alert-only sweep (confirm window, dedup, clearing, one
// owner per state, never a keystroke).
//
// #1596 review: the stagnant-counter half is not part of this change (it needs
// a per-agent transcript-mtime guard first), and a permission prompt on a
// channel-owning agent is the channel-monitor's to report.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsHeldPeerMessage, detectsPermissionDialog, detectsBlockingMenu } from '../pane-state.js'
import {
  classifyAgentWait,
  sweepSubAgents,
  resetSubAgentWatchState,
  formatAgentWaitAlert,
  AGENT_WAIT_THRESHOLDS,
  type SubAgentSweepDeps,
} from '../web/stuck-tool-call-watcher.js'
import { MAIN_AGENT_ID } from '../config.js'

const load = (n: string) => readFileSync(join(__dirname, `fixtures/pane/${n}.txt`), 'utf8')
const PERMISSION_PANE = load('permission-prompt-bash-grep')

// The held-peer-message dialog. NOT a live capture: assembled from the
// dialog's own strings in the installed Claude Code binary (checked in 2.1.282
// by the reviewer and in 2.1.296 here): the title, the body lines, and the two
// options "Deliver this message to Claude" / "Deny" ("drop it and tell the
// sender it was declined"). The footer line is the generic modal hint, so the
// pane is exactly the shape the channel-monitor's menu pass would Escape.
const HELD_PEER_PANE = [
  '  Reviewed the branch, waiting for the next instruction.',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  ' Held message from another session',
  '',
  ' Another Claude session sent a message: from uds:/tmp/cc-socks/21286.sock (peer claims name: Klaudia)',
  '',
  ' Message body (this is what will be delivered):',
  ' │ Please rebase the PR onto develop.',
  '',
  ' ❯ 1. Deliver this message to Claude',
  '   2. Deny  drop it and tell the sender it was declined',
  '',
  ' Enter to confirm · Esc to cancel',
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
  it('recognises the held cross-session message dialog by its title', () => {
    expect(detectsHeldPeerMessage(HELD_PEER_PANE)).toBe(true)
    // It is NOT the tool-permission card: that detector must stay quiet here.
    expect(detectsPermissionDialog(HELD_PEER_PANE)).toBe(false)
  })
  it('the body strings alone are not an anchor (review: they appear outside the dialog too)', () => {
    // The wrapper of a DELIVERED peer message opens with the same sentence.
    const delivered = HELD_PEER_PANE.replace(' Held message from another session', ' (delivered)')
    expect(detectsHeldPeerMessage(delivered)).toBe(false)
    // The notification text of the state is not necessarily on screen.
    expect(detectsHeldPeerMessage(' A message from another session needs your approval\n Esc to cancel')).toBe(false)
  })
  it('stays quiet on a busy pane that merely echoes the title', () => {
    const pane = HELD_PEER_PANE + '\n✻ Worked for 3s\n  esc to interrupt'
    expect(detectsHeldPeerMessage(pane)).toBe(false)
  })
  it('stays quiet when the idle footer is live (the title is quoted text)', () => {
    const pane = '  "Held message from another session" was the title I saw.\n\n❯ \n  ? for shortcuts'
    expect(detectsHeldPeerMessage(pane)).toBe(false)
  })
  it('stays quiet on an empty or idle pane', () => {
    expect(detectsHeldPeerMessage('')).toBe(false)
    expect(detectsHeldPeerMessage(IDLE_PANE)).toBe(false)
  })
})

describe('the menu pass never Escapes a held peer message (#1596 review point 4)', () => {
  it('detectsBlockingMenu is false on the held-peer dialog', () => {
    expect(detectsBlockingMenu(HELD_PEER_PANE)).toBe(false)
  })
  it('...and it is the held-peer guard that makes the difference: the same modal without the title is a menu', () => {
    const genericModal = HELD_PEER_PANE.replace(' Held message from another session', ' Select an option')
    expect(detectsBlockingMenu(genericModal)).toBe(true)
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
})

type Alert = { agent: string; kind: string; waitingMs?: number; ask?: unknown }

function makeDeps(
  panes: Record<string, () => string | null>,
  clock: { now: number },
  opts: { running?: (a: string) => boolean; channel?: (a: string) => boolean } = {},
) {
  const alerts: Alert[] = []
  const deps: SubAgentSweepDeps = {
    listAgents: () => Object.keys(panes),
    isRunning: opts.running ?? (() => true),
    hasChannel: opts.channel ?? (() => false),
    capture: (agent) => panes[agent]?.() ?? null,
    now: () => clock.now,
    alertWait: (agent, _session, kind, waitingMs, ask) => { alerts.push({ agent, kind, waitingMs, ask }) },
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

  it('one owner per state: no permission alert for a channel-owning agent, the held peer message still alerts', () => {
    // review point 1: the channel-monitor's menu pass already reports a
    // permission prompt on an agent with a channel.
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps(
      { cella: () => PERMISSION_PANE, kigyo: () => PERMISSION_PANE, konnektor: () => HELD_PEER_PANE },
      clock,
      { channel: (a) => a !== 'kigyo' },
    )
    for (let i = 0; i < 3; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts.map((a) => `${a.agent}:${a.kind}`).sort()).toEqual(['kigyo:permission', 'konnektor:peer-message'])
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
    const { deps, alerts } = makeDeps(
      { [MAIN_AGENT_ID]: () => PERMISSION_PANE, cella: () => PERMISSION_PANE, konnektor: () => PERMISSION_PANE },
      clock,
      { running: (a) => a !== 'konnektor' },
    )
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts.map((a) => a.agent)).toEqual(['cella'])
  })

  it('a capture failure on one agent does not hide the others', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => { throw new Error('tmux down') }, kigyo: () => PERMISSION_PANE }, clock)
    for (let i = 0; i < 3; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts.map((a) => a.agent)).toEqual(['kigyo'])
  })

  it('a long busy turn (even with a frozen-looking summary line) never alerts: no counter watch on sub-agents', () => {
    // review point 2: "Worked for 31s" above "esc to interrupt" is a working
    // session with a residual summary, not a wedge.
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ ketely: () => busyPane(31) }, clock)
    for (let i = 0; i < 20; i++) { sweepSubAgents(deps); clock.now += 30_000 }
    expect(alerts).toEqual([])
  })
})
