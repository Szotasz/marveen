// SUBWAIT925 (card c3f8f062): a sub-agent parked on an approval dialog must
// reach the owner as an alert. The 2026-09-23 incident: kigyo's strict-profile
// session held a cross-session message for approval for hours; no watcher
// recognised that dialog, so nothing alerted. These tests pin the detector for
// that dialog (anchored on its title), the classification, the menu pass never
// Escaping it while every typing guard still refuses it, and the alert-only
// sweep (confirm window, dedup, clearing, one owner per state, never a
// keystroke).
//
// #1596 review: the stagnant-counter half is not part of this change (it needs
// a per-agent transcript-mtime guard first), and a permission prompt on a
// channel-owning agent is the channel-monitor's to report.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsHeldPeerMessage, detectsPermissionDialog, detectsBlockingMenu, detectPaneState } from '../pane-state.js'
import {
  classifyAgentWait,
  sweepSubAgents,
  resetSubAgentWatchState,
  formatAgentWaitAlert,
  AGENT_WAIT_THRESHOLDS,
  parseAgentStateFile,
  stateFileSaysWaiting,
  AGENT_STATE_STALE_MS,
  type SubAgentSweepDeps,
  type AgentStateReading,
} from '../web/stuck-tool-call-watcher.js'
import { urgentEmitRefusal } from '../web/message-router.js'
import { paneRefusesIdentityCommand } from '../web/agent-process.js'
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

describe('a held peer message is still a dialog for every typing guard', () => {
  // detectsBlockingMenu leaves the held-peer dialog out so the menu pass never
  // Escapes it. The guards that refuse text + Enter used detectsBlockingMenu for
  // it too, and must not lose it with that: on this dialog the Enter confirms
  // the highlighted "Deliver this message to Claude" on the user's behalf.
  it('the STOP / urgent emit guard refuses it', () => {
    expect(urgentEmitRefusal(HELD_PEER_PANE)).toBe('held-peer-message')
  })
  it('the identity /rename refuses it', () => {
    expect(paneRefusesIdentityCommand(HELD_PEER_PANE)).toBe(true)
  })
  it('neither guard refuses an idle prompt', () => {
    expect(urgentEmitRefusal(IDLE_PANE)).toBeNull()
    expect(paneRefusesIdentityCommand(IDLE_PANE)).toBe(false)
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
  opts: { running?: (a: string) => boolean; channel?: (a: string) => boolean; state?: (a: string) => AgentStateReading | null } = {},
) {
  const alerts: Alert[] = []
  const deps: SubAgentSweepDeps = {
    listAgents: () => Object.keys(panes),
    isRunning: opts.running ?? (() => true),
    hasChannel: opts.channel ?? (() => false),
    capture: (agent) => panes[agent]?.() ?? null,
    now: () => clock.now,
    alertWait: (agent, _session, kind, waitingMs, ask) => { alerts.push({ agent, kind, waitingMs, ask }) },
    ...(opts.state ? { readState: opts.state } : {}),
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

// STATEOBS1012: the agent-state-observer file as a second signal for the
// tool-permission wait. It adds a wait the pane did not show (a hook's `ask`
// opens a dialog with no PermissionRequest, whose card the matcher may not
// know), never over a busy pane, never from a stale file, and the one-owner
// rule applies to it unchanged.

// A dialog the pane matcher does not know: no idle footer, no busy marker, no
// "Do you want to proceed?".
const UNKNOWN_DIALOG_PANE = [
  '  Checking the branch.',
  '',
  ' Some future approval card',
  '',
  ' ❯ 1. Allow',
  '   2. Deny',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

describe('parseAgentStateFile', () => {
  it('reads the state, the tool and alive_at of a well-formed file', () => {
    expect(parseAgentStateFile('{"v":1,"state":"awaiting_approval","tool":"Bash","alive_at":1792407339999}'))
      .toEqual({ state: 'awaiting_approval', tool: 'Bash', aliveAt: 1792407339999 })
  })
  it('a tool name that is not a plain word is dropped (it reaches an owner alert)', () => {
    expect(parseAgentStateFile('{"state":"awaiting_approval","tool":"Bash; rm -rf /","alive_at":1}')?.tool).toBeNull()
    expect(parseAgentStateFile('{"state":"awaiting_approval","tool":null,"alive_at":1}')?.tool).toBeNull()
  })
  it('anything else is no reading at all', () => {
    expect(parseAgentStateFile('{"state":')).toBeNull()
    expect(parseAgentStateFile('null')).toBeNull()
    expect(parseAgentStateFile('{"state":"awaiting approval!","alive_at":1}')).toBeNull()
    expect(parseAgentStateFile('{"state":"awaiting_approval"}')).toBeNull()
    expect(parseAgentStateFile('{"state":"awaiting_approval","alive_at":"1"}')).toBeNull()
  })
})

describe('stateFileSaysWaiting', () => {
  const NOW = 2_000_000_000_000
  const fresh = (state = 'awaiting_approval'): AgentStateReading => ({ state, tool: 'Bash', aliveAt: NOW - 30_000 })
  it('a fresh awaiting_approval over a pane that is not busy is a wait', () => {
    expect(stateFileSaysWaiting(fresh(), UNKNOWN_DIALOG_PANE, NOW)).toBe(true)
    // the captured permission card reads 'unknown', never 'busy'
    expect(stateFileSaysWaiting(fresh(), PERMISSION_PANE, NOW)).toBe(true)
    expect(stateFileSaysWaiting(fresh(), null, NOW)).toBe(true)
  })
  it('a busy pane is the approved tool running (the mod\'s known limit), not a wait', () => {
    expect(stateFileSaysWaiting(fresh(), busyPane(40), NOW)).toBe(false)
  })
  it('an idle prompt cannot sit under an open dialog, so a reading kept past it is not a wait', () => {
    expect(detectPaneState(IDLE_PANE)).toBe('idle')
    expect(stateFileSaysWaiting(fresh(), IDLE_PANE, NOW)).toBe(false)
  })
  it('a stale file, another state or no file says nothing', () => {
    expect(stateFileSaysWaiting({ ...fresh(), aliveAt: NOW - AGENT_STATE_STALE_MS }, UNKNOWN_DIALOG_PANE, NOW)).toBe(false)
    expect(stateFileSaysWaiting(fresh('working'), UNKNOWN_DIALOG_PANE, NOW)).toBe(false)
    expect(stateFileSaysWaiting(null, UNKNOWN_DIALOG_PANE, NOW)).toBe(false)
  })
})

describe('sweepSubAgents with the state file (STATEOBS1012)', () => {
  beforeEach(() => resetSubAgentWatchState())
  const MIN = 60_000
  const waitingFile = (clock: { now: number }, tool: string | null = 'Bash') => () => ({ state: 'awaiting_approval', tool, aliveAt: clock.now - 20_000 })

  it('adds the wait the pane did not show, after the same confirm window, naming the tool', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => UNKNOWN_DIALOG_PANE }, clock, { state: waitingFile(clock) })
    sweepSubAgents(deps)
    clock.now += 1 * MIN; sweepSubAgents(deps)
    expect(alerts).toEqual([])
    clock.now += 2.5 * MIN; sweepSubAgents(deps)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ agent: 'cella', kind: 'permission', waitingMs: 3.5 * MIN })
    expect(alerts[0].ask).toEqual({ title: 'Bash', reason: 'az állapotfigyelő szerint jóváhagyásra vár' })
  })

  it('without the state reader the same pane alerts nothing (the pane alone does not know that card)', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => UNKNOWN_DIALOG_PANE }, clock)
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toEqual([])
  })

  it('one owner per state: a channel-owning agent\'s state-file wait stays the channel-monitor\'s', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ kigyo: () => UNKNOWN_DIALOG_PANE }, clock, { state: waitingFile(clock), channel: () => true })
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toEqual([])
  })

  it('an approved tool still running (busy pane) never alerts', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => busyPane(90) }, clock, { state: waitingFile(clock) })
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toEqual([])
  })

  it('a stale file (session gone or frozen) never alerts', () => {
    const clock = { now: 1_000_000 }
    const stale = () => ({ state: 'awaiting_approval', tool: 'Bash', aliveAt: clock.now - AGENT_STATE_STALE_MS - 1 })
    const { deps, alerts } = makeDeps({ cella: () => UNKNOWN_DIALOG_PANE }, clock, { state: stale })
    for (let i = 0; i < 4; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toEqual([])
  })

  it('when the pane shows the card itself, the pane\'s question is quoted and the file is not read', () => {
    const clock = { now: 1_000_000 }
    let reads = 0
    const { deps, alerts } = makeDeps({ cella: () => PERMISSION_PANE }, clock, { state: () => { reads++; return waitingFile(clock, 'Edit')() } })
    for (let i = 0; i < 3; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toHaveLength(1)
    expect((alerts[0].ask as { title: string }).title).toMatch(/Bash command/)
    expect(reads).toBe(0)
  })

  it('a file with no plain-word tool still alerts, without inventing a name', () => {
    const clock = { now: 1_000_000 }
    const { deps, alerts } = makeDeps({ cella: () => UNKNOWN_DIALOG_PANE }, clock, { state: waitingFile(clock, null) })
    for (let i = 0; i < 3; i++) { clock.now += 2 * MIN; sweepSubAgents(deps) }
    expect(alerts).toHaveLength(1)
    expect(alerts[0].ask).toEqual({ title: 'ismeretlen eszköz', reason: 'az állapotfigyelő szerint jóváhagyásra vár' })
  })
})

describe('the live wiring reads the state file (STATEOBS1012)', () => {
  const SRC = readFileSync(join(__dirname, '../web/stuck-tool-call-watcher.ts'), 'utf-8')
  it('passes the local reader into the live sweep, from the observer\'s own state folder', () => {
    const live = SRC.slice(SRC.indexOf('const LIVE_SUB_AGENT_DEPS'))
    expect(live.slice(0, 900)).toMatch(/readState: readLocalAgentState/)
    expect(SRC).toMatch(/join\(STATE_OBSERVER_STATE_DIR, `\$\{agent\}\.json`\)/)
    // a remote agent's name never reaches a local file
    const reader = SRC.slice(SRC.indexOf('function readLocalAgentState'))
    expect(reader.slice(0, 400)).toMatch(/readAgentRemoteHost\(agent\)\) return null/)
  })
})
