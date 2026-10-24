// #1596 follow-up: the main session's held peer message is reported, never
// answered. #1596 stopped the channel-monitor's menu pass from Escaping the
// dialog (Escape there may decline the message), and the sub-agent sweep leaves
// the main agent out, so on the main session nothing reported it. The watcher
// now checks the main session for this one shape on every poll. These tests
// drive the live watcher (mocked tmux/pane/alerts) and pin the owner alert after
// the confirm window, its dedup, the one-owner rule for the permission prompt,
// and that no key is ever sent.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pane: '',
  captured: [] as string[],          // every session capturePane was asked for
  exec: [] as string[][],
  routine: vi.fn(),
  alert: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (_file: string, args: string[]) => {
    h.exec.push(args)
    throw new Error('no tmux in this test')
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/bin/tmux' }))
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-project-root', STORE_DIR: '/nonexistent-store-dir', BOT_NAME: 'Marveen', MAIN_AGENT_ID: 'marveen' }))
vi.mock('../web/agent-process.js', () => ({ capturePane: (session: string) => { h.captured.push(session); return h.pane }, isAgentRunning: () => false, agentSessionName: (a: string) => a, agentHasChannel: () => true }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [], readAgentRemoteHost: () => null }))
vi.mock('../web/state-observer.js', () => ({ STATE_OBSERVER_STATE_DIR: '/nonexistent-state-dir' }))
vi.mock('../web/active-model.js', () => ({ readTranscriptMtimeAcrossConfigDirs: () => null }))
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => [] }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-test', withoutMainAgent: (a: string[]) => a }))
vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: vi.fn(async () => true),
  sendAlert: h.alert,
  lastMainRespawnAt: () => 0,
  MARVEEN_POST_RESPAWN_GRACE_MS: 120_000,
}))
vi.mock('../web/routine-alert.js', () => ({ sendRoutineAlert: h.routine }))

let startWatcher: typeof import('../web/stuck-tool-call-watcher.js').startStuckToolCallWatcher

// The same synthesised dialog as in subagent-wait-alert.test.ts (NOT a live
// capture: built from the dialog's strings in the installed binary).
const HELD_PEER_PANE = [
  '  Reviewed the branch, waiting for the next instruction.',
  '',
  ' Held message from another session',
  '',
  ' Another Claude session sent a message: from uds:/tmp/cc-socks/21286.sock (peer claims name: Kigyo)',
  '',
  ' Message body (this is what will be delivered):',
  ' │ The PR is green.',
  '',
  ' ❯ 1. Deliver this message to Claude',
  '   2. Deny  drop it and tell the sender it was declined',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')
const IDLE_PANE = ['  Done.', '', '❯ ', '  ? for shortcuts'].join('\n')
const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')

// Poll i fires at 35 s (i = 0), then every 30 s: the spell opens at 35 s and the
// 3-minute confirm window is reached at poll 6 (215 s).
async function drive(polls: number, before: (i: number) => void = () => {}): Promise<void> {
  const timer = startWatcher()
  try {
    for (let i = 0; i < polls; i++) {
      before(i)
      await vi.advanceTimersByTimeAsync(i === 0 ? 35_000 : 30_000)
    }
  } finally {
    clearInterval(timer)
  }
}
const sentKeys = () => h.exec.filter((args) => args.includes('send-keys'))

beforeEach(async () => {
  vi.resetModules()      // the spell state lives in module scope: a fresh copy per test
  startWatcher = (await import('../web/stuck-tool-call-watcher.js')).startStuckToolCallWatcher
  vi.useFakeTimers()
  h.pane = HELD_PEER_PANE
  h.captured.length = 0
  h.exec.length = 0
  h.routine.mockClear()
  h.alert.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('the main session holding a peer message', () => {
  it('alerts the owner once the dialog outlives the confirm window, never inside it, and sends no key', async () => {
    const alertsBeforePoll: number[] = []
    await drive(7, () => { alertsBeforePoll.push(h.routine.mock.calls.length) })
    expect(alertsBeforePoll[6]).toBe(0)          // nothing through poll 5 (185 s)
    expect(h.routine).toHaveBeenCalledTimes(1)   // poll 6 (215 s)
    const [key, text] = h.routine.mock.calls[0]
    expect(key).toBe('agent-wait:marveen')
    expect(text).toContain('Marveen')
    expect(text).toContain('másik sessionből')
    expect(text).toContain('tmux attach -t main-test')
    expect(h.alert).not.toHaveBeenCalled()
    expect(sentKeys()).toEqual([])
    // The pane read is the main channels session's: with any other session the
    // alert would go silent while the canned pane kept this test green (#2079 review, K7).
    expect([...new Set(h.captured)]).toEqual(['main-test'])
  })

  it('says it again only after the dedup window while the dialog still stands', async () => {
    await drive(60)        // 35 s .. 30 min 5 s: the first alert, then dedup
    expect(h.routine).toHaveBeenCalledTimes(1)
    await drive(10)        // past 30 min after the first alert
    expect(h.routine).toHaveBeenCalledTimes(2)
    expect(sentKeys()).toEqual([])
  })

  it('a dialog answered within the confirm window never alerts', async () => {
    await drive(20, (i) => { h.pane = i < 3 ? HELD_PEER_PANE : IDLE_PANE })
    expect(h.routine).not.toHaveBeenCalled()
  })
})

describe('everything else on the main pane stays out of this check', () => {
  it('a tool-permission prompt is the channel-monitor\'s to report (card 68cb6715): no alert here', async () => {
    h.pane = PERMISSION_PANE
    await drive(20)
    expect(h.routine).not.toHaveBeenCalled()
    expect(sentKeys()).toEqual([])
  })

  it('an idle prompt never alerts', async () => {
    h.pane = IDLE_PANE
    await drive(20)
    expect(h.routine).not.toHaveBeenCalled()
  })
})
