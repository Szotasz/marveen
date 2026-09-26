import { describe, it, expect, vi } from 'vitest'

vi.mock('../web/agent-process.js', () => ({ isAgentRunning: vi.fn(), capturePane: vi.fn(), agentSessionName: vi.fn(), restartAgentProcess: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: vi.fn(), hardRestartMarveenChannels: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: vi.fn(() => []) }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))

import {
  parseUnsupportedModelError, semverGte, decideVersionGuard, modelVersionGuardTick,
  MODEL_VERSION_RESTART_COOLDOWN_MS, type GuardDeps, type GuardState, type SessionBinary,
} from '../web/model-version-guard.js'

// The real shape from an agent's pane (wrapped at the pane width).
const AGENT_PANE = [
  '  some earlier output',
  '',
  "⏺ API Error: 400 Claude Code 2.1.278 does not support this model;",
  "  version 2.1.280 or newer is required. Run 'claude update', or update",
  '  the Claude desktop app, then try again.',
  '',
  '✻ Baked for 1s · done 13:46',
  '❯ ',
].join('\n')

// A healthy session whose reply QUOTES the error (the review's counterexample).
const QUOTING_PANE = [
  '⏺ This is what the agent saw earlier:',
  '  > API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required.',
  '  It was fixed by a restart.',
  '',
  '❯ ',
].join('\n')

describe('parseUnsupportedModelError', () => {
  it('reads the running and required versions when the error is the last answer', () => {
    expect(parseUnsupportedModelError(AGENT_PANE)).toEqual({ running: '2.1.278', required: '2.1.280' })
  })
  it('ignores a reply that quotes the error', () => {
    expect(parseUnsupportedModelError(QUOTING_PANE)).toBeNull()
  })
  it('ignores the error once a later answer follows it', () => {
    const later = AGENT_PANE.replace('❯ ', '❯ hello\n\n⏺ Hi, all good.\n\n❯ ')
    expect(parseUnsupportedModelError(later)).toBeNull()
  })
  it('ignores a pane without the error or without a prompt', () => {
    expect(parseUnsupportedModelError('all good\n❯ ')).toBeNull()
    expect(parseUnsupportedModelError(AGENT_PANE.replace('❯ ', ''))).toBeNull()
    expect(parseUnsupportedModelError(null)).toBeNull()
  })
})

describe('semverGte', () => {
  it('compares numerically, not lexically', () => {
    expect(semverGte('2.1.280', '2.1.280')).toBe(true)
    expect(semverGte('2.1.280', '2.1.278')).toBe(true)
    expect(semverGte('2.1.99', '2.1.280')).toBe(false)
    expect(semverGte('2.2.0', '2.1.999')).toBe(true)
  })
})

describe('decideVersionGuard', () => {
  const error = { running: '2.1.278', required: '2.1.280' }
  const base = {
    error, installedVersion: '2.1.282', processInode: 1, installedInode: 2, processPid: 100, restartedPid: null,
    lastActionAt: null, now: 10_000, cooldownMs: MODEL_VERSION_RESTART_COOLDOWN_MS,
  }
  it('new build installed, the process still runs the old file -> restart', () => {
    expect(decideVersionGuard(base)).toBe('restart')
  })
  it('the process already runs the installed file -> none (stale text on screen)', () => {
    expect(decideVersionGuard({ ...base, processInode: 2 })).toBe('none')
  })
  it('a process this guard started is not restarted again for the same error', () => {
    expect(decideVersionGuard({ ...base, restartedPid: 100 })).toBe('none')
  })
  it('installed build too old -> alert, no restart', () => {
    expect(decideVersionGuard({ ...base, installedVersion: '2.1.279' })).toBe('alert-update')
  })
  it('does nothing inside the cooldown after an action', () => {
    expect(decideVersionGuard({ ...base, lastActionAt: 9_000 })).toBe('none')
  })
  it('does nothing destructive when an inode or the version is unknown', () => {
    expect(decideVersionGuard({ ...base, processInode: null })).toBe('none')
    expect(decideVersionGuard({ ...base, installedInode: null })).toBe('none')
    expect(decideVersionGuard({ ...base, installedVersion: null })).toBe('none')
  })
  it('no error -> none', () => {
    expect(decideVersionGuard({ ...base, error: null })).toBe('none')
  })
})

describe('modelVersionGuardTick', () => {
  function harness(opts: { pane?: string; bin?: SessionBinary | null; newPidAfterRestart?: number; restartOk?: boolean } = {}) {
    let now = 1_000_000
    let bin: SessionBinary | null = opts.bin === undefined ? { pid: 100, path: '/opt/claude/bin/claude', inode: 1 } : opts.bin
    const restart = vi.fn(async () => {
      if (bin && opts.newPidAfterRestart) bin = { ...bin, pid: opts.newPidAfterRestart, inode: 2 }
      return opts.restartOk ?? true
    })
    const installed = vi.fn(() => ({ version: '2.1.282', inode: 2 }))
    const deps: GuardDeps = {
      targets: () => [{ session: 'agent-a', name: 'a', isMain: false }],
      capture: () => opts.pane ?? AGENT_PANE,
      binary: () => bin,
      installed,
      restart,
      alert: vi.fn(),
      now: () => now,
    }
    const st: GuardState = { lastActionAt: new Map(), restartedPid: new Map() }
    return { deps, st, restart, installed, advance: (ms: number) => { now += ms }, setBin: (b: SessionBinary | null) => { bin = b } }
  }

  it('arms the cooldown: a failed restart is not retried on the next tick', async () => {
    const h = harness({ restartOk: false })
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.restart).toHaveBeenCalledTimes(1)
    h.advance(2 * 60_000)
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.restart).toHaveBeenCalledTimes(1)
  })

  it('after the cooldown, the process it started is still not restarted for the re-rendered error', async () => {
    const h = harness()
    await modelVersionGuardTick(h.deps, h.st)
    // The same pid still shows the error (e.g. history re-rendered), inode unchanged in this fixture.
    h.advance(MODEL_VERSION_RESTART_COOLDOWN_MS + 1)
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.restart).toHaveBeenCalledTimes(1)
  })

  it('reads the installed version from the binary the session runs, not from PATH', async () => {
    const h = harness()
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.installed).toHaveBeenCalledWith('/opt/claude/bin/claude')
  })

  it('does not restart a healthy session that quotes the error', async () => {
    const h = harness({ pane: QUOTING_PANE })
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.restart).not.toHaveBeenCalled()
  })

  it('does not restart when the running binary cannot be identified', async () => {
    const h = harness({ bin: null })
    await modelVersionGuardTick(h.deps, h.st)
    expect(h.restart).not.toHaveBeenCalled()
  })
})
