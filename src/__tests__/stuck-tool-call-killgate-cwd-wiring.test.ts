// KILLGATECWD1022, driven end to end: checkSession poll by poll (the STUCKATTEMPTS1018 harness: mocked tmux/ps/pane,
// transcript mtimes per working directory). The session writes its transcript under its own working directory (the tmux
// pane_current_path); PROJECT_ROOT holds nothing, or only an old transcript. A live session must not be respawned, a real
// wedge still must be, and a failed pane-path read falls back to exactly the old read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ROOT = '/nonexistent-project-root'
const SESSION_CWD = '/srv/session-cwd'

const h = vi.hoisted(() => ({
  pane: '',
  paneCwdOut: '' as string | Error,          // what `tmux list-panes -F '#{pane_current_path}'` prints or throws
  paneCwdCalls: [] as Array<{ args: string[]; opts: Record<string, unknown> }>,
  pidTargets: [] as string[],                // the -t of the pane_pid reads (the CPU sampler)
  byDir: {} as Record<string, number | null>, // transcript mtime per working directory
  t0: 0,
  times: [] as number[],
  resume: vi.fn(async () => { h.times.push(Date.now() - h.t0); return true }),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => {
    if (args[0] === 'list-panes' && args.includes('#{pane_current_path}')) {
      h.paneCwdCalls.push({ args, opts })
      if (h.paneCwdOut instanceof Error) throw h.paneCwdOut
      return h.paneCwdOut
    }
    if (args[0] === 'list-panes') { h.pidTargets.push(args[args.indexOf('-t') + 1]); return '100\n' }
    if (args.includes('%cpu=')) return '1.8\n'
    if (args.includes('pid=,ppid=,stat=,cputime=,comm=')) {
      return '100 1 S+ 5:00.00 /opt/homebrew/bin/claude\n150 100 S 0:30.00 /opt/homebrew/bin/bun\n'
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: h.debug } }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/bin/tmux' }))
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-project-root', STORE_DIR: '/nonexistent-store-dir' }))
vi.mock('../web/agent-process.js', () => ({ capturePane: () => h.pane, isAgentRunning: () => false, agentSessionName: (a: string) => a, agentHasChannel: () => true }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [], readAgentRemoteHost: () => null }))
vi.mock('../web/state-observer.js', () => ({ STATE_OBSERVER_STATE_DIR: '/nonexistent-state-dir' }))
vi.mock('../web/active-model.js', () => ({ readTranscriptMtimeAcrossConfigDirs: (workingDir: string) => h.byDir[workingDir] ?? null }))
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => [] }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-test', withoutMainAgent: (a: string[]) => a }))
vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: h.resume,
  sendAlert: vi.fn(),
  lastMainRespawnAt: () => 0,
  MARVEEN_POST_RESPAWN_GRACE_MS: 120_000,
}))
vi.mock('../web/routine-alert.js', () => ({ sendRoutineAlert: vi.fn() }))

let startWatcher: typeof import('../web/stuck-tool-call-watcher.js').startStuckToolCallWatcher

const FROZEN_PANE = ['⏺ Bash(python3 harness.py)', '  ⎿  Running…', '', '✻ Baked for 20s', ''].join('\n')
const pollT = (i: number) => (i === 0 ? 35_000 : (i + 1) * 30_000)
const FIRST_VERDICT_MS = pollT(7)

async function drive(polls: number, before: (i: number) => void = () => {}): Promise<void> {
  h.t0 = Date.now()
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
/** the session writes 1 s before every poll from the first stagnant poll on: alive throughout */
const aliveIn = (dir: string) => (i: number) => { h.byDir[dir] = h.t0 + pollT(i) - 1_000 }

beforeEach(async () => {
  vi.resetModules()
  startWatcher = (await import('../web/stuck-tool-call-watcher.js')).startStuckToolCallWatcher
  vi.useFakeTimers()
  h.pane = FROZEN_PANE
  h.paneCwdOut = SESSION_CWD + '\n'
  h.paneCwdCalls.length = 0
  h.pidTargets.length = 0
  h.byDir = {}
  h.times.length = 0
  h.resume.mockClear()
  h.info.mockClear()
  h.warn.mockClear()
  h.debug.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('KILLGATECWD1022 wiring: the kill gate reads the transcript under the session\'s own working directory', () => {
  it('a live session writing under its own cwd (nothing under PROJECT_ROOT) is not respawned', async () => {
    await drive(30, aliveIn(SESSION_CWD))
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('EPERM shape: PROJECT_ROOT holds only a two-day-old transcript and the session writes under its cwd, so it is not respawned', async () => {
    await drive(30, i => { h.byDir[PROJECT_ROOT] = h.t0 - 2 * 24 * 3600_000; aliveIn(SESSION_CWD)(i) })
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('a real wedge (the last write under the session cwd predates the freeze) is still recovered at the first verdict', async () => {
    await drive(30, () => { h.byDir[SESSION_CWD] = h.t0 + 20_000 })
    expect(h.times).toEqual([FIRST_VERDICT_MS])
  })

  it('the pane path is read only at the kill boundary, once per verdict, from the same exact target as the CPU sampler, with a timeout', async () => {
    await drive(30, () => { h.byDir[SESSION_CWD] = h.t0 + 20_000 })
    expect(h.paneCwdCalls).toHaveLength(1)                       // one verdict, one kill boundary, one read
    const { args, opts } = h.paneCwdCalls[0]
    expect(args[args.indexOf('-t') + 1]).toBe(h.pidTargets[0])
    expect(args[args.indexOf('-t') + 1]).toBe('=main-test:')
    expect(opts.timeout).toBe(3000)
    expect(args.slice(0, 2)).toEqual(['list-panes', '-s'])     // the single-pane check counts every window of the session
  })

  it('more than one pane on the target: the single-pane precondition fails, so the result is exactly the old read (no guessing which pane is the session)', async () => {
    h.paneCwdOut = SESSION_CWD + '\n/srv/other\n'
    await drive(30, aliveIn(SESSION_CWD))
    expect(h.times).toEqual([FIRST_VERDICT_MS])          // the session dir is not read: the PROJECT_ROOT read (nothing) lets the kill through, as before
    h.times.length = 0; h.resume.mockClear(); h.byDir = {}; vi.resetModules()
    startWatcher = (await import('../web/stuck-tool-call-watcher.js')).startStuckToolCallWatcher
    await drive(30, aliveIn('/srv/other'))
    expect(h.times).toEqual([FIRST_VERDICT_MS])
  })

  it('tmux fails on the pane path: exactly the old read (PROJECT_ROOT), the wedge is recovered, and the failure is logged as a warning with its site', async () => {
    h.paneCwdOut = new Error('no server running')
    await drive(30, aliveIn(SESSION_CWD))
    expect(h.times).toEqual([FIRST_VERDICT_MS])
    expect(h.warn.mock.calls.filter(c => (c[0] as Record<string, unknown>)?.site === 'stuck-tool-call-watcher.mainPaneCwd')).toHaveLength(1)
  })

  it('an empty tmux output counts as no cwd: the old read, never the projects/ root (an empty working dir)', async () => {
    h.paneCwdOut = '\n'
    await drive(30, aliveIn(''))
    expect(h.times).toEqual([FIRST_VERDICT_MS])
  })
})
