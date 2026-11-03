// IDLEFLUSHVETO812: the idle-flush tier must not restart a session that still
// runs background work. A background shell, a Monitor or a sub-agent leaves the
// pane idle-looking and the transcript quiet -- the exact inputs the tier acts
// on -- and the restart kills that work.
//
// The footers below are the measured shapes already pinned in pane-state.test.ts
// (VAGTECHIDLE1009, COMMATAIL1022, MONITORTAIL1025) and the background-agent
// block from pane-background-agents.test.ts; they are reused, not invented.

import { describe, it, expect } from 'vitest'
import { detectBackgroundWork, detectPaneState, hasBackgroundWork } from '../pane-state.js'
import {
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  decideGuard,
  type ContextGuardConfig,
  type GuardInputs,
} from '../context-guard.js'

const SEP = '─'.repeat(80)
const modeFooter = (tail: string) => ['', SEP, '❯ ', SEP, tail].join('\n')

const IDLE_PLAIN = modeFooter('  ⏵⏵ bypass permissions on (shift+tab to cycle)')
const ONE_SHELL_ONE_MONITOR = modeFooter('  ⏵⏵ bypass permissions on · 1 shell, 1 monitor')
const SHELLS_THEN_MONITOR = modeFooter('  ⏵⏵ accept edits on · 3 shells · 1 monitor')
const MONITOR_ONLY = modeFooter('  ⏵⏵ bypass permissions on · 1 monitor')
const FULL_FOOTER_WITH_SHELL = modeFooter('  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage')

const agentRow = (label: string, elapsed: string) =>
  `  ◯ general-purpose  ${label} ${elapsed} · ↓ 12.0k tokens`
const withAgentBlock = (footer: string, rows: string[]) =>
  ['  waiting on the agents.', '', '─'.repeat(67) + ' AgentOne ─', '❯ ', SEP, footer, '', '  ⏺ main', ...rows].join('\n')

const AGENTS_RUNNING = withAgentBlock('  ⏵⏵ bypass permissions on · ↓ to manage', [
  agentRow('Reviewing the first result fi…', '17m 23s'),
  agentRow('Verifying the second checkout…', '16m 30s'),
])
// An agent that has finished its run shows a word in place of the clock.
const AGENT_WAITING = withAgentBlock('  ⏵⏵ bypass permissions on · ↓ to manage', [
  '  ◯ general-purpose  Reviewing the first result fi… waiting',
])

// The same counter words in the scrollback, above a plain idle footer, are a
// log line, not live work.
const COUNTS_IN_SCROLLBACK = [
  '  log: bypass permissions on · 2 shells · 1 monitor',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('detectBackgroundWork / hasBackgroundWork', () => {
  it('every fixture here is an idle pane, which is why the guard needs this second signal', () => {
    for (const p of [IDLE_PLAIN, ONE_SHELL_ONE_MONITOR, SHELLS_THEN_MONITOR, MONITOR_ONLY, FULL_FOOTER_WITH_SHELL, AGENTS_RUNNING, COUNTS_IN_SCROLLBACK]) {
      expect(detectPaneState(p)).toBe('idle')
    }
  })

  it('counts the shells and monitors on the live footer', () => {
    expect(detectBackgroundWork(ONE_SHELL_ONE_MONITOR)).toEqual({ shells: 1, monitors: 1, agents: 0 })
    expect(detectBackgroundWork(SHELLS_THEN_MONITOR)).toEqual({ shells: 3, monitors: 1, agents: 0 })
    expect(detectBackgroundWork(MONITOR_ONLY)).toEqual({ shells: 0, monitors: 1, agents: 0 })
    expect(detectBackgroundWork(FULL_FOOTER_WITH_SHELL)).toEqual({ shells: 2, monitors: 0, agents: 0 })
    for (const p of [ONE_SHELL_ONE_MONITOR, SHELLS_THEN_MONITOR, MONITOR_ONLY, FULL_FOOTER_WITH_SHELL]) {
      expect(hasBackgroundWork(p)).toBe(true)
    }
  })

  it('counts running background agents below the footer, not finished ones', () => {
    expect(detectBackgroundWork(AGENTS_RUNNING)).toEqual({ shells: 0, monitors: 0, agents: 2 })
    expect(hasBackgroundWork(AGENTS_RUNNING)).toBe(true)
    expect(detectBackgroundWork(AGENT_WAITING)).toEqual({ shells: 0, monitors: 0, agents: 0 })
    expect(hasBackgroundWork(AGENT_WAITING)).toBe(false)
  })

  it('a plain idle footer has no background work', () => {
    expect(detectBackgroundWork(IDLE_PLAIN)).toEqual({ shells: 0, monitors: 0, agents: 0 })
    expect(hasBackgroundWork(IDLE_PLAIN)).toBe(false)
  })

  it('never reads the counters from the scrollback', () => {
    expect(detectBackgroundWork(COUNTS_IN_SCROLLBACK)).toEqual({ shells: 0, monitors: 0, agents: 0 })
    expect(hasBackgroundWork(COUNTS_IN_SCROLLBACK)).toBe(false)
  })

  it('no pane or no recognised footer says nothing', () => {
    expect(detectBackgroundWork(null)).toBeNull()
    expect(detectBackgroundWork('')).toBeNull()
    expect(detectBackgroundWork('some text\nwith no footer')).toBeNull()
    expect(hasBackgroundWork(null)).toBe(false)
  })
})

describe('decideGuard -- idle-flush veto on background work', () => {
  const IDLE_CFG: ContextGuardConfig = {
    ...DEFAULT_CONTEXT_GUARD,
    enabled: false,
    idleFlushEnabled: true,
    idleFlushTokens: 400_000,
    idleMinutes: 20,
  }
  const armed: GuardInputs = {
    nowMs: 1_000_000_000,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    paneBackgroundWork: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    dailyHandoffDue: false,
    contextTokens: 600_000,
    idleMs: 21 * 60_000,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
  }

  // Stated as a difference: the same heavy, quiet, idle session flushes
  // without background work and waits with it, so the veto is what blocks.
  it('heavy, quiet and idle flushes; the same session with background work waits', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, armed, IDLE_CFG).action).toBe('request-handoff')
    const d = decideGuard(INITIAL_GUARD_STATE, { ...armed, paneBackgroundWork: true }, IDLE_CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('idle')
    expect(d.reason).toContain('background work')
  })

  it('the veto belongs to the idle-flush tier only: a saturated pane still restarts', () => {
    const sat: ContextGuardConfig = { ...IDLE_CFG, saturationRestart: true }
    const withWork = { ...armed, paneBackgroundWork: true, paneSaturated: true }
    const without = { ...armed, paneSaturated: true }
    const a = decideGuard(INITIAL_GUARD_STATE, withWork, sat)
    const b = decideGuard(INITIAL_GUARD_STATE, without, sat)
    expect(a.reason).toContain('saturated')
    expect(a.reason).not.toContain('background work')
    expect({ action: a.action, reason: a.reason, nextState: a.nextState })
      .toEqual({ action: b.action, reason: b.reason, nextState: b.nextState })
  })
})
