// STUCKCHILD1016: the stuck-tool-call watcher looked only at the pane-leader
// claude's CPU and respawned a session whose long FOREGROUND tool call (a python
// child) was working. These tests pin the pane-leader's tool-child check: pure
// helpers first, then the whole checkSession path driven poll by poll with
// mocked tmux/ps/pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  panePid: '100\n',
  pane: '',
  procs: '' as string | null,   // null = the ps call fails
  times: [] as number[],
  t0: 0,
  resume: vi.fn(async () => { h.times.push(Date.now() - h.t0); return true }),
  info: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[]) => {
    if (args[0] === 'list-panes') return h.panePid
    if (args.includes('%cpu=')) return '1.8\n'
    if (args.includes('pid=,ppid=,stat=,cputime=,comm=')) {
      if (h.procs === null) throw new Error('ps failed')
      return h.procs
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() } }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/bin/tmux' }))
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-project-root', STORE_DIR: '/nonexistent-store-dir' }))
// The watcher also imports the sub-agent sweep's helpers (SUBWAIT925); they are
// mocked inert here so this file only drives the main session's checkSession.
vi.mock('../web/agent-process.js', () => ({ capturePane: () => h.pane, isAgentRunning: () => false, agentSessionName: (a: string) => a, agentHasChannel: () => true }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [], readAgentRemoteHost: () => null }))
vi.mock('../web/state-observer.js', () => ({ STATE_OBSERVER_STATE_DIR: '/nonexistent-state-dir' }))
vi.mock('../web/active-model.js', () => ({ readTranscriptMtimeAcrossConfigDirs: () => null }))
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => [] }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-test', withoutMainAgent: (a: string[]) => a }))
vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: h.resume,
  sendAlert: vi.fn(),
  lastMainRespawnAt: () => 0,
  MARVEEN_POST_RESPAWN_GRACE_MS: 120_000,
}))
vi.mock('../web/routine-alert.js', () => ({ sendRoutineAlert: vi.fn() }))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let startWatcher: typeof import('../web/stuck-tool-call-watcher.js').startStuckToolCallWatcher
import {
  CHILD_ACTIVE_CPU_DELTA_MS,
  CHILD_ACTIVITY_WINDOW_MS,
  MAX_CHILD_DEFER_MS,
  childDeferExpired,
  observeToolChildren,
  parseProcSnapshot,
  parsePsCpuTimeMs,
  toolChildRecentlyActive,
  toolDescendants,
  resolveToolRoot,
  type ChildActivity,
  type ProcSample,
} from '../web/stuck-tool-call-watcher.js'

const NO_ACT: ChildActivity = { cpuMs: null, lastActiveAt: null }
const P = (pid: number, ppid: number, state: string, cpuMs: number, comm: string): ProcSample => ({ pid, ppid, state, cpuMs, comm })

describe('childDeferExpired', () => {
  it('false before the cap, true at and after it; no stagnation recorded -> false', () => {
    expect(childDeferExpired(1_000, 1_000 + MAX_CHILD_DEFER_MS - 1)).toBe(false)
    expect(childDeferExpired(1_000, 1_000 + MAX_CHILD_DEFER_MS)).toBe(true)
    expect(childDeferExpired(null, 9e12)).toBe(false)
  })
})

describe('parsePsCpuTimeMs', () => {
  it('parses the macOS and Linux cputime shapes', () => {
    expect(parsePsCpuTimeMs('0:01.50')).toBe(1500)
    expect(parsePsCpuTimeMs('12:34.00')).toBe(754_000)
    expect(parsePsCpuTimeMs('01:02:03')).toBe(3_723_000)
    expect(parsePsCpuTimeMs('2-00:00:01')).toBe(172_801_000)
  })
  it('rejects garbage', () => {
    expect(parsePsCpuTimeMs('abc')).toBeNull()
    expect(parsePsCpuTimeMs('')).toBeNull()
  })
})

describe('parseProcSnapshot', () => {
  it('parses rows, keeps a command with spaces whole, skips unparseable lines', () => {
    const rows = parseProcSnapshot([
      '  100     1 S+     0:42.10 /opt/homebrew/bin/claude',
      '  102   101 R      3:00.00 /Applications/Some App/python3.12',
      'garbage line',
      '  103   102 S      xx:yy /bin/zsh',
    ].join('\n'))
    expect(rows).toEqual([
      { pid: 100, ppid: 1, state: 'S+', cpuMs: 42_100, comm: '/opt/homebrew/bin/claude' },
      { pid: 102, ppid: 101, state: 'R', cpuMs: 180_000, comm: '/Applications/Some App/python3.12' },
    ])
  })
})

describe('resolveToolRoot', () => {
  it('a non-shell pane leader is its own root', () => {
    expect(resolveToolRoot([P(100, 1, 'S', 0, '/opt/claude')], 100)).toEqual({ root: 100, viaShell: false })
  })
  it('a shell/wrapper leader resolves to its claude child (preferred by name, else the only non-shell child)', () => {
    const procs = [P(90, 1, 'S', 0, '-zsh'), P(100, 90, 'S', 0, '/x/claude'), P(110, 90, 'S', 0, '/x/caffeinate')]
    expect(resolveToolRoot(procs, 90)).toEqual({ root: 100, viaShell: true })
    expect(resolveToolRoot([P(90, 1, 'S', 0, 'bash'), P(120, 90, 'S', 0, '/x/node')], 90)).toEqual({ root: 120, viaShell: true })
  })
  it('a shell leader with no usable child (none, or several unnamed) resolves to null; an unknown pid too', () => {
    expect(resolveToolRoot([P(90, 1, 'S', 0, 'zsh')], 90)).toEqual({ root: null, viaShell: true })
    expect(resolveToolRoot([P(90, 1, 'S', 0, 'zsh'), P(1, 90, 'S', 0, '/a'), P(2, 90, 'S', 0, '/b')], 90)).toEqual({ root: null, viaShell: true })
    expect(resolveToolRoot([], 90)).toEqual({ root: null, viaShell: false })
  })
})

describe('toolDescendants', () => {
  const procs = [
    P(100, 1, 'S', 0, 'claude'),
    P(101, 100, 'S', 0, '/bin/zsh'),
    P(102, 101, 'S', 0, '/usr/bin/python3'),
    P(103, 102, 'R', 0, '/usr/bin/git'),
    P(104, 103, 'S', 0, '-bash'),
    P(105, 104, 'S', 0, '/usr/bin/make'),
    P(150, 100, 'S', 0, '/Users/x/.bun/bin/bun'),        // MCP / channel plugin: direct non-shell child of the pane leader
    P(151, 150, 'R', 0, '/Users/x/.bun/bin/bun'),        // its poller
    P(160, 100, 'S', 0, '/usr/bin/caffeinate'),
    P(200, 1, 'R', 0, '/usr/bin/python3'),
  ]
  it('counts only non-shell processes under a SHELL child of the root (nested shells walked through)', () => {
    expect(toolDescendants(procs, 100).map(p => p.pid).sort()).toEqual([102, 103, 105])
  })
  it('the root\'s non-shell direct children (bun MCP, caffeinate) and their subtrees are excluded; so are strangers', () => {
    const pids = toolDescendants(procs, 100).map(p => p.pid)
    for (const x of [150, 151, 160, 200]) expect(pids).not.toContain(x)
  })
})

describe('observeToolChildren / toolChildRecentlyActive', () => {
  const NOW = 1_000_000
  it('first poll has no baseline: only the running state counts', () => {
    const idle = [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(102, 101, 'S', 999_000, 'python3')]
    expect(observeToolChildren(NO_ACT, idle, 100, NOW).lastActiveAt).toBeNull()
    const running = [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(102, 101, 'R', 0, 'python3')]
    expect(observeToolChildren(NO_ACT, running, 100, NOW).lastActiveAt).toBe(NOW)
  })

  it('CPU growth >= the delta threshold marks a sleeping-state child active; below it does not', () => {
    const base = observeToolChildren(NO_ACT, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(102, 101, 'S', 5_000, 'node')], 100, NOW)
    const small = observeToolChildren(base, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(102, 101, 'S', 5_000 + CHILD_ACTIVE_CPU_DELTA_MS - 1, 'node')], 100, NOW + 30_000)
    expect(small.lastActiveAt).toBeNull()
    const big = observeToolChildren(base, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(102, 101, 'S', 5_000 + CHILD_ACTIVE_CPU_DELTA_MS, 'node')], 100, NOW + 30_000)
    expect(big.lastActiveAt).toBe(NOW + 30_000)
  })

  it('a pid first seen after the baseline counts its whole CPU time (spawned within the last poll)', () => {
    const base = observeToolChildren(NO_ACT, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh')], 100, NOW)
    const next = observeToolChildren(base, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'S', 0, 'zsh'), P(300, 101, 'S', 4_000, 'python3')], 100, NOW + 30_000)
    expect(next.lastActiveAt).toBe(NOW + 30_000)
  })

  it('shell wrappers never count as activity', () => {
    const base = observeToolChildren(NO_ACT, [P(100, 1, 'S', 0, 'claude'), P(101, 100, 'R', 0, '/bin/zsh')], 100, NOW)
    expect(base.lastActiveAt).toBeNull()
  })

  it('activity expires after the window', () => {
    const act: ChildActivity = { cpuMs: new Map(), lastActiveAt: NOW }
    expect(toolChildRecentlyActive(act, NOW + CHILD_ACTIVITY_WINDOW_MS - 1)).toBe(true)
    expect(toolChildRecentlyActive(act, NOW + CHILD_ACTIVITY_WINDOW_MS)).toBe(false)
    expect(toolChildRecentlyActive(undefined, NOW)).toBe(false)
  })
})

// --- end to end through checkSession: poll-by-poll -------------------------------------
// Pane: a frozen "Baked for 20s" footer with no idle prompt (the 16:17 shape:
// tag=baked, seconds=20, pane leader at 1.8% CPU).
const FROZEN_PANE = ['⏺ Bash(python3 harness.py)', '  ⎿  Running…', '', '✻ Baked for 20s', ''].join('\n')

function snapshot(rows: Array<[number, number, string, string, string]>): string {
  return rows.map(([pid, ppid, st, cpu, comm]) => `${pid} ${ppid} ${st} ${cpu} ${comm}`).join('\n') + '\n'
}

// Drive N polls (first at 35 s, then every 30 s); `at(i)` supplies the ps output of poll i.
async function drive(polls: number, at: (i: number) => string | null): Promise<void> {
  h.t0 = Date.now()
  const timer = startWatcher()
  try {
    for (let i = 0; i < polls; i++) {
      h.procs = at(i)
      await vi.advanceTimersByTimeAsync(i === 0 ? 35_000 : 30_000)
    }
  } finally {
    clearInterval(timer)
  }
}

describe('checkSession end to end: tool child check', () => {
  beforeEach(async () => {
    vi.resetModules()      // the watcher keeps per-session state in module maps: a fresh copy per test
    startWatcher = (await import('../web/stuck-tool-call-watcher.js')).startStuckToolCallWatcher
    vi.useFakeTimers()
    h.pane = FROZEN_PANE
    h.resume.mockClear()
    h.panePid = '100\n'
    h.times.length = 0
    h.info.mockClear()
    h.warn.mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  const claude: [number, number, string, string, string] = [100, 1, 'S+', '5:00.00', '/opt/homebrew/bin/claude']
  const bun: [number, number, string, string, string] = [150, 100, 'S', '0:30.00', '/opt/homebrew/bin/bun']
  const zsh: [number, number, string, string, string] = [101, 100, 'S', '0:00.10', '/bin/zsh']

  it('16:17 profile: frozen counter, claude at 1.8% CPU, a python tool child burning CPU -> NO respawn', async () => {
    // python (pid 102) keeps accumulating CPU: +5 s per 30 s poll; its test child is running.
    await drive(12, i => snapshot([
      claude, bun, zsh,
      [102, 101, 'S', `${Math.floor((10 + i * 5) / 60)}:${String((10 + i * 5) % 60).padStart(2, '0')}.00`, '/usr/bin/python3'],
      [103, 102, 'R', '0:02.00', '/usr/bin/node'],
    ]))
    expect(h.resume).not.toHaveBeenCalled()
    const logged = h.info.mock.calls.map(c => String(c[1]))
    expect(logged.some(m => m.includes('a tool child process is active'))).toBe(true)
  })

  it('real wedge: same frozen counter, only an idle MCP poller below claude -> respawn stays', async () => {
    await drive(12, () => snapshot([claude, bun, zsh]))
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.warn.mock.calls.some(c => String(c[1]).includes('recovering main channels session'))).toBe(true)
  })

  it('a tool call that ends does not block a later real wedge (the deferral expires)', async () => {
    // Child active for the first 4 polls, then gone; the counter stays frozen.
    await drive(20, i => i < 4
      ? snapshot([claude, bun, zsh, [102, 101, 'S', `0:${String(10 + i * 5).padStart(2, '0')}.00`, '/usr/bin/python3'], [103, 102, 'R', '0:01.00', '/usr/bin/node']])
      : snapshot([claude, bun, zsh]))
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  const bunBusy: [number, number, string, string, string] = [150, 100, 'R', '0:40.00', '/opt/homebrew/bin/bun']
  const cpuT = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}.00`
  const pyGrowing = (i: number): [number, number, string, string, string] => [102, 101, 'S', cpuT(10 + i * 5), '/usr/bin/python3']
  const pollT = (i: number) => (i === 0 ? 35_000 : (i + 1) * 30_000)   // ms after the watcher start: interval polls at 30 s multiples + the initial one at 35 s
  const FIRST_STAGNANT_MS = 35_000                                     // 30 s opens the spell, 35 s is the first stagnant observation

  it('S-state python with growing CPU time (no R child at all) keeps the deferral alive', async () => {
    await drive(12, i => snapshot([claude, bun, zsh, pyGrowing(i)]))
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.info.mock.calls.some(c => String(c[1]).includes('a tool child process is active'))).toBe(true)
  })

  it('HARD CAP: an endlessly active tool child + a frozen counter -> recovery after MAX_CHILD_DEFER_MS of stagnation, never before', async () => {
    await drive(45, i => snapshot([claude, bun, zsh, pyGrowing(i), [103, 102, 'R', '0:02.00', '/usr/bin/node']]))
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.times[0]).toBeGreaterThanOrEqual(FIRST_STAGNANT_MS + MAX_CHILD_DEFER_MS)
    expect(h.times[0]).toBeLessThan(FIRST_STAGNANT_MS + MAX_CHILD_DEFER_MS + 60_000)
    expect(h.warn.mock.calls.some(c => String(c[1]).includes('past the hard cap'))).toBe(true)
  })

  it('real wedge + an ACTIVE bun direct child (running state): recovery is NOT deferred (infrastructure is not a tool call)', async () => {
    await drive(12, () => snapshot([claude, bunBusy, zsh]))
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it('real wedge + a busy bun (growing CPU) with its busy poller and a busy caffeinate: recovery is NOT deferred either', async () => {
    await drive(12, i => snapshot([claude, [150, 100, 'S', cpuT(30 + i * 20), '/opt/homebrew/bin/bun'], [151, 150, 'R', '0:10.00', '/opt/homebrew/bin/bun'],
      [170, 100, 'S', cpuT(5 + i * 9), '/usr/bin/caffeinate'], zsh]))
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it('failed ps polls never refresh the deferral: a persistent failure after the tool call ends lets the window run out -> recovery', async () => {
    // active tool child for polls 0-3, then ps fails from poll 4 on
    await drive(20, i => i < 4 ? snapshot([claude, bun, zsh, pyGrowing(i), [103, 102, 'R', '0:02.00', '/usr/bin/node']]) : null)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.times[0]).toBeGreaterThanOrEqual(pollT(3) + CHILD_ACTIVITY_WINDOW_MS)       // not before the window after the last REAL activity
    expect(h.times[0]).toBeLessThanOrEqual(pollT(3) + CHILD_ACTIVITY_WINDOW_MS + 60_000)
  })

  it('a failed poll zeroes the CPU baseline: the CPU jump across the gap is not read as fresh activity', async () => {
    // R child (active) for polls 0-5; ps fails at poll 6; from poll 7 the python is in S state with a +100 s CPU jump, constant afterwards
    await drive(16, i => i <= 5 ? snapshot([claude, bun, zsh, pyGrowing(i), [103, 102, 'R', '0:02.00', '/usr/bin/node']])
      : i === 6 ? null : snapshot([claude, bun, zsh, [102, 101, 'S', cpuT(200), '/usr/bin/python3']]))
    expect(h.resume).toHaveBeenCalledTimes(1)
    // last REAL activity: poll 5. Without the baseline reset the poll-7 jump would extend the deferral to poll 7 + window.
    expect(h.times[0]).toBeGreaterThanOrEqual(pollT(5) + CHILD_ACTIVITY_WINDOW_MS)
    expect(h.times[0]).toBeLessThanOrEqual(pollT(5) + CHILD_ACTIVITY_WINDOW_MS + 30_000)
  })

  it('the deferral resets `attempts`: after the tool call ends a later REAL wedge still recovers (the spell is not held)', async () => {
    await drive(20, i => i < 4
      ? snapshot([claude, bun, zsh, pyGrowing(i), [103, 102, 'R', '0:02.00', '/usr/bin/node']])
      : snapshot([claude, bun, zsh]))
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it('pane leader is a SHELL wrapper above claude: the tool children are scoped under its claude child (deferral works)', async () => {
    h.panePid = '90\n'
    const wrapper: [number, number, string, string, string] = [90, 1, 'S+', '0:01.00', '/bin/zsh']
    const claudeUnder: [number, number, string, string, string] = [100, 90, 'S+', '5:00.00', '/opt/homebrew/bin/claude']
    await drive(12, i => snapshot([wrapper, claudeUnder, bun, zsh, pyGrowing(i), [103, 102, 'R', '0:02.00', '/usr/bin/node']]))
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('pane leader is a shell with NO identifiable claude child: one WARN, deferral inactive, a real wedge still recovers', async () => {
    h.panePid = '90\n'
    const wrapper: [number, number, string, string, string] = [90, 1, 'S+', '0:01.00', '/bin/zsh']
    await drive(12, () => snapshot([wrapper]))
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.warn.mock.calls.filter(c => String(c[1]).includes('no identifiable claude child')).length).toBe(1)
  })
})

// --- wiring pins ------------------------------------------------------------------------
describe('wiring: the tool child guard', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')
  const start = SRC.indexOf('async function checkSession')
  const body = SRC.slice(start, SRC.indexOf('\n}', start))
  const code = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('the guard line is live and sits after the CPU guard, before the transcript gate and the kill (cap check inside)', () => {
    const cpuIdx = code.indexOf('confirmsWedgeProfile(')
    const guardIdx = code.indexOf('if (toolChildRecentlyActive(toolChildState.get(session), Date.now())) {')
    const capIdx = code.indexOf('if (!childDeferExpired(next.stagnantSince, Date.now())) {')
    const gateIdx = code.indexOf('if (verdictStaleByTranscript(transcriptMtime, Date.now())) {')
    const killIdx = code.indexOf('resumeMarveenSession()')
    expect(cpuIdx).toBeGreaterThanOrEqual(0)
    expect(guardIdx).toBeGreaterThan(cpuIdx)
    expect(capIdx).toBeGreaterThan(guardIdx)
    expect(gateIdx).toBeGreaterThan(capIdx)
    expect(killIdx).toBeGreaterThan(gateIdx)
  })

  it('the tracker is fed while the counter is stagnant and dropped otherwise', () => {
    expect(code).toContain('if (next.tag !== null && next.stagnantPolls >= 1) {')
    expect(code).toContain('sampleToolChildren(session, Date.now())')
    expect(code).toContain('toolChildState.delete(session)')
  })
})
