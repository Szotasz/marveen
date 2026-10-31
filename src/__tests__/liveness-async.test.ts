import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { etimeOutputToMs } from '../web/agent-restart-policy.js'
import {
  recheckSharedVerdict,
  probeChannelPluginLivenessAsync,
  getClaudePidForSession,
  getClaudePidForSessionAsync,
  takeProcSnapshotAsync,
} from '../channel-coordinator/liveness.js'

describe('recheckSharedVerdict', () => {
  it.each([
    ['alive', 'alive'],
    ['down', 'down'],
    ['unknown', 'unknown'],
  ] as const)('shared down + recheck %s -> %s', async (re, want) => {
    const recheck = vi.fn(async () => re)
    expect(await recheckSharedVerdict('down', true, recheck)).toBe(want)
    expect(recheck).toHaveBeenCalledTimes(1)
  })
  it('a shared alive is rechecked only with confirmAlive', async () => {
    const recheck = vi.fn(async () => 'down' as const)
    expect(await recheckSharedVerdict('alive', true, recheck)).toBe('alive')
    expect(recheck).not.toHaveBeenCalled()
    expect(await recheckSharedVerdict('alive', true, recheck, true)).toBe('down')
    expect(recheck).toHaveBeenCalledTimes(1)
  })
  it('never rechecks unknown or a verdict from a fresh snapshot', async () => {
    const recheck = vi.fn(async () => 'alive' as const)
    expect(await recheckSharedVerdict('unknown', true, recheck, true)).toBe('unknown')
    expect(await recheckSharedVerdict('down', false, recheck, true)).toBe('down')
    expect(await recheckSharedVerdict('alive', false, recheck, true)).toBe('alive')
    expect(recheck).not.toHaveBeenCalled()
  })
})

// A real process under this test's pid whose argv the telegram matcher accepts (a runtime
// token plus a /telegram path end) stands in for the channel poller. The agent name points
// at a state dir that does not exist, so no bot.pid of this host can answer instead.
const AGENT = 'no-such-agent-liveness-async'
async function startFakePoller() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/liveness-async-fixture/telegram'], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return child
}

describe('async probes', () => {
  it('a shared snapshot without a poller stays down after the fresh re-probe', async () => {
    const r = await probeChannelPluginLivenessAsync(999999, 'telegram', AGENT, {}, 'PID PPID COMMAND\n  1     0 /sbin/init\n')
    expect(r).toBe('down')
  })
  it('a down from a stale shared snapshot is re-probed with a fresh ps', async () => {
    const child = await startFakePoller()
    try {
      // Positive control: a fresh probe sees the fixture at all.
      expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', AGENT)).toBe('alive')
      // The stale snapshot has no poller; only the re-probe can turn it into 'alive'.
      expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', AGENT, {}, 'PID PPID COMMAND\n')).toBe('alive')
    } finally {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      await exited
    }
  })
  it('an alive from a stale shared snapshot is re-probed when confirmAlive asks', async () => {
    const child = await startFakePoller()
    let stale: string | null = null
    try {
      stale = await takeProcSnapshotAsync()
      expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', AGENT, {}, stale!)).toBe('alive')
    } finally {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      await exited
    }
    // The poller is gone, the snapshot still shows it.
    expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', AGENT, {}, stale!)).toBe('alive')
    expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', AGENT, { confirmAlive: true }, stale!)).toBe('down')
  })
  it('getClaudePidForSessionAsync resolves null for unknown session', async () => {
    expect(await getClaudePidForSessionAsync('no-such-session-xyz-123')).toBeNull()
  })
  it('takeProcSnapshotAsync returns ps output', async () => {
    const s = await takeProcSnapshotAsync()
    expect(typeof s).toBe('string')
    expect(s!.split('\n')[0]).toContain('PID')
  })
})

describe('check() source pin', () => {
  it('uses the async probes with one shared snapshot', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain('const sweepSnapshot = await takeProcSnapshotAsync()')
    expect(src).toContain('await getClaudePidForSessionAsync(t.session)')
    expect(src).toContain('await probeChannelPluginLivenessAsync(claudePid, t.provider, t.agentName, { confirmAlive: openDownSpell }, sweepSnapshot ?? undefined)')
    expect(src).toContain('agentDownSince.has(t.session) || (t.agentName !== undefined && agentRestartFailures.has(t.agentName))')
    expect(src).toContain('marveenSuspectFirstSeen !== null || marveenDownState !== null || marveenRecreatedOutage !== null')
    // Every restart-state read comes after the last await before decideDownAgentAction.
    const age = src.indexOf('const processAgeMs = await getProcessAgeMsAsync(claudePid)')
    const last = src.indexOf('const lastRestart = agentLastRestart.get(t.agentName!)')
    const decide = src.indexOf('const action = decideDownAgentAction({', last)
    expect(age).toBeGreaterThan(0)
    expect(age).toBeLessThan(last)
    expect(src.indexOf('const lastRestart = agentLastRestart.get(t.agentName!)', last + 1)).toBe(-1) // one anchor only
    expect(src.slice(last, decide)).not.toMatch(/\bawait\b/)
    expect(src.slice(decide, src.indexOf('}, maxRestartAttempts)', decide))).not.toMatch(/\bawait\b/)
    expect(src).not.toContain('const liveness = probeChannelPluginLiveness(claudePid, t.provider, t.agentName)')
  })
})

describe('etimeOutputToMs (shared by the sync and the async process-age probe)', () => {
  it('converts ps etime output to milliseconds', () => {
    expect(etimeOutputToMs('      05:23\n')).toBe(323_000)
    expect(etimeOutputToMs('2-03:04:05\n')).toBe(183_845_000)
    // A process 0 seconds old is age 0, not an unparseable -1.
    expect(etimeOutputToMs('      00:00\n')).toBe(0)
  })
  it('keeps -1 for output it cannot parse', () => {
    expect(etimeOutputToMs('')).toBe(-1)
    expect(etimeOutputToMs('garbage')).toBe(-1)
  })
})

let tmuxBin: string | null = null
try { tmuxBin = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf-8' }).trim() || null } catch { tmuxBin = null }

describe.skipIf(!tmuxBin)('getClaudePidForSessionAsync against an isolated tmux server', () => {
  it('finds a claude that is the pane process AND one that runs under a shell, like the sync probe', async () => {
    const sockDir = mkdtempSync(join(tmpdir(), 'livenessasync-'))
    const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR }
    const tmux = (args: string[]) => execFileSync(tmuxBin as string, args, { encoding: 'utf-8', env: { ...process.env, TMUX: '', TMUX_TMPDIR: sockDir } })
    try {
      // A process NAMED claude: a symlink to node, so `ps -o comm=` reads claude. Not a
      // symlink to sleep: a multi-call coreutils (uutils) dispatches on argv[0] and exits
      // at once as "unknown program 'claude'".
      const fakeClaude = join(sockDir, 'claude')
      symlinkSync(process.execPath, fakeClaude)
      const idle = `${fakeClaude} -e "setTimeout(() => {}, 300000)"`
      tmux(['new-session', '-d', '-s', 'agent-direct', idle])
      // `; true` keeps sh from exec-ing the last command, so claude stays sh's CHILD.
      tmux(['new-session', '-d', '-s', 'agent-child', `sh -c '${idle}; true'`])
      expect(tmux(['display-message', '-p', '-t', '=agent-child:', '#{socket_path}']).startsWith(sockDir)).toBe(true)
      process.env.TMUX = ''
      process.env.TMUX_TMPDIR = sockDir
      for (const session of ['agent-direct', 'agent-child']) {
        let syncPid: number | null = null
        for (let i = 0; i < 20 && syncPid == null; i++) {
          syncPid = getClaudePidForSession(session)
          if (syncPid == null) await new Promise((r) => setTimeout(r, 100))
        }
        expect(syncPid).toBeGreaterThan(1) // positive control: the sync probe sees it
        expect(await getClaudePidForSessionAsync(session)).toBe(syncPid)
      }
      const panePid = Number(tmux(['list-panes', '-t', '=agent-child:', '-F', '#{pane_pid}']).trim())
      expect(await getClaudePidForSessionAsync('agent-child')).not.toBe(panePid) // the child, not the shell
    } finally {
      if (saved.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = saved.TMUX
      if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR
      try { tmux(['kill-server']) } catch { /* already gone */ }
      rmSync(sockDir, { recursive: true, force: true })
    }
  })
})
