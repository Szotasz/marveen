// STUCKATTEMPTS1018: a guard that defers a stuck-tool-call verdict must leave the
// spell able to fire again. decideStuckToolCallRecovery() stores attempts=1 with
// every verdict, and attempts >= 1 means "recovery already fired: hold" for the
// rest of the spell. The CPU guard, the post-respawn grace and the STUCKFREEZE819
// transcript gate returned without resetting it, so ONE deferral stood the
// watcher down for good and a real wedge behind it was never recovered. These
// tests drive checkSession poll by poll (mocked tmux/ps/pane/transcript): each
// guard defers once, then the same frozen spell must recover on a later poll.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pane: '',
  cpu: [] as string[],               // per CPU sample, shifted; empty -> the idle wedge profile
  respawnAt: 0,                      // lastMainRespawnAt() epoch ms, 0 = none
  mtime: null as number | null,      // transcript mtime the kill gate reads
  t0: 0,
  times: [] as number[],
  resume: vi.fn(async () => { h.times.push(Date.now() - h.t0); return true }),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args: string[]) => {
    if (args[0] === 'list-panes') return '100\n'
    if (args.includes('%cpu=')) return h.cpu.shift() ?? '1.8\n'
    if (args.includes('pid=,ppid=,stat=,cputime=,comm=')) {
      return '100 1 S+ 5:00.00 /opt/homebrew/bin/claude\n150 100 S 0:30.00 /opt/homebrew/bin/bun\n'
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: h.debug } }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/bin/tmux' }))
vi.mock('../config.js', () => ({ PROJECT_ROOT: '/nonexistent-project-root', STORE_DIR: '/nonexistent-store-dir' }))
// The watcher also imports the sub-agent sweep's helpers (SUBWAIT925); they are
// mocked inert here so this file only drives the main session's checkSession.
vi.mock('../web/agent-process.js', () => ({ capturePane: () => h.pane, isAgentRunning: () => false, agentSessionName: (a: string) => a, agentHasChannel: () => true }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [], readAgentRemoteHost: () => null }))
vi.mock('../web/state-observer.js', () => ({ STATE_OBSERVER_STATE_DIR: '/nonexistent-state-dir' }))
vi.mock('../web/active-model.js', () => ({ readTranscriptMtimeAcrossConfigDirs: () => h.mtime }))
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => [] }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-test', withoutMainAgent: (a: string[]) => a }))
vi.mock('../web/channel-monitor.js', () => ({
  resumeMarveenSession: h.resume,
  sendAlert: vi.fn(),
  lastMainRespawnAt: () => h.respawnAt,
  MARVEEN_POST_RESPAWN_GRACE_MS: 120_000,
}))
vi.mock('../web/routine-alert.js', () => ({ sendRoutineAlert: vi.fn() }))

let startWatcher: typeof import('../web/stuck-tool-call-watcher.js').startStuckToolCallWatcher

// A frozen "Baked for 20s" footer, no idle prompt: the wedge shape.
const FROZEN_PANE = ['⏺ Bash(python3 harness.py)', '  ⎿  Running…', '', '✻ Baked for 20s', ''].join('\n')

// Poll i fires at 35 s (i = 0), then at (i + 1) * 30 s. The spell opens at poll 0, the first
// stagnant observation is poll 1 (60 s), and the 180 s freeze is reached at poll 7 (240 s):
// that is the first verdict.
const pollT = (i: number) => (i === 0 ? 35_000 : (i + 1) * 30_000)
const FIRST_VERDICT_MS = pollT(7)

// Drive N polls; `before(i)` runs just before poll i fires, so a test can set what poll i sees.
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
const logged = (fn: typeof h.info, needle: string) => fn.mock.calls.filter(c => String(c[1]).includes(needle)).length

beforeEach(async () => {
  vi.resetModules()      // per-session state lives in module maps: a fresh copy per test
  startWatcher = (await import('../web/stuck-tool-call-watcher.js')).startStuckToolCallWatcher
  vi.useFakeTimers()
  h.pane = FROZEN_PANE
  h.cpu = []
  h.respawnAt = 0
  h.mtime = null
  h.times.length = 0
  h.resume.mockClear()
  h.info.mockClear()
  h.warn.mockClear()
  h.debug.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('baseline: the undisturbed wedge', () => {
  it('recovers once at the first verdict, and the spell then holds (no second respawn)', async () => {
    await drive(30)
    expect(h.times).toEqual([FIRST_VERDICT_MS])
  })
})

describe('a deferred verdict re-fires on the next poll', () => {
  it('CPU guard: one CPU-busy verdict, then the idle profile -> recovery on the next poll', async () => {
    h.cpu = ['50\n']
    await drive(60)
    expect(logged(h.info, 'claude is CPU-active')).toBe(1)
    expect(h.times).toEqual([pollT(8)])
  })

  it('CPU guard: busy at every verdict -> never recovers, and is asked again on every poll', async () => {
    await drive(20, () => { h.cpu = ['50\n'] })
    expect(h.resume).not.toHaveBeenCalled()
    expect(logged(h.info, 'claude is CPU-active')).toBe(20 - 7)
  })

  it('post-respawn grace: deferred while the grace runs, recovery on the first poll after it', async () => {
    // an external respawn 20 s before the first verdict; the grace (120 s) ends at verdict + 100 s
    await drive(30, i => { if (i === 0) h.respawnAt = h.t0 + FIRST_VERDICT_MS - 20_000 })
    expect(logged(h.info, 'recent respawn within grace')).toBe(4)   // polls 7..10 (240..330 s; 330 s is 110 s after the respawn)
    expect(h.times).toEqual([pollT(11)])
  })

  it('STUCKFREEZE819 transcript gate: one fresh-transcript abort, then a stale one -> recovery on the next poll', async () => {
    await drive(30, i => { h.mtime = i === 7 ? h.t0 + pollT(7) - 1_000 : null })
    expect(logged(h.warn, 'ABORTING recovery (STUCKFREEZE819)')).toBe(1)
    expect(h.times).toEqual([pollT(8)])
  })

  it('the guards stack: CPU, then the transcript gate, then neither -> one recovery after both', async () => {
    await drive(30, i => {
      if (i === 7) h.cpu = ['50\n']
      h.mtime = i === 8 ? h.t0 + pollT(8) - 1_000 : null
    })
    expect(logged(h.info, 'claude is CPU-active')).toBe(1)
    expect(logged(h.warn, 'ABORTING recovery (STUCKFREEZE819)')).toBe(1)
    expect(h.times).toEqual([pollT(9)])
  })
})

describe('the transcript gate on a re-fired verdict: written since the freeze = alive (Samu, #2051 review)', () => {
  // The measured live shape: a fresh-transcript abort, then a 40 s write gap (a 30 s snapshot sees
  // a 31 s old write on the next poll and would let the kill through), then the session writes again.
  it('fresh abort, 40 s write gap, then a new write -> NO respawn, and the abort warns once per spell', async () => {
    await drive(30, i => {
      if (i >= 7) h.mtime = i < 9 ? h.t0 + pollT(7) - 1_000 : h.t0 + pollT(8) + 9_000
    })
    expect(h.resume).not.toHaveBeenCalled()
    const aborts = (fn: typeof h.warn) => fn.mock.calls.filter(c => /ABORTING recovery/.test(String(c[1]))).length
    expect(aborts(h.warn)).toBe(1)
    expect(aborts(h.debug)).toBe(30 - 7 - 1)
  })

  it('a long silence after a write inside the spell is still alive: no respawn for 30 minutes', async () => {
    await drive(60, i => { if (i >= 7) h.mtime = h.t0 + pollT(7) - 1_000 })
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('a real wedge whose last write PREDATES the freeze recovers at the first verdict, unchanged', async () => {
    await drive(30, () => { h.mtime = h.t0 + 20_000 })   // written at 20 s; the first stagnant poll is at 60 s
    expect(h.times).toEqual([FIRST_VERDICT_MS])
  })
})

describe('wiring: every deferring guard stores the spell through deferVerdict()', () => {
  it('each deferral log line is followed by deferVerdict(session, next) before its return', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')
    for (const needle of [
      'recent respawn within grace, deferring recovery',
      'claude is CPU-active (not the idle wedge profile) -- deferring recovery',
      'a tool child process is active (long foreground tool call, not a wedge) -- deferring recovery',
      'ABORTING recovery (STUCKFREEZE819)',
      'ABORTING recovery (STUCKATTEMPTS1018)',
    ]) {
      const at = src.indexOf(needle)
      expect(at, needle).toBeGreaterThan(-1)
      const tail = src.slice(at, src.indexOf('return', at))
      expect(tail, needle).toContain('deferVerdict(session, next)')
    }
  })
})
