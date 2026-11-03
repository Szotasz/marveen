import { describe, expect, it, vi } from 'vitest'

// FORKFA161A5921: probeChannelPluginLiveness must hand the state-dir env scan to
// the decider (the decider is tested in liveness-envscan-fallback.test.ts); this
// pins the binding on a fake `ps`. The poller carries THIS process's pid, so the
// probe's kill(pid, 0) finds it alive.
const POLLER_PID = process.pid
const PS = [
  '  PID  PPID COMMAND',
  '70994     1 claude --channels plugin:telegram@claude-plugins-official',
  `${String(POLLER_PID).padStart(5)}     1 /Users/u/.bun/bin/bun server.ts`,
].join('\n')
let envScan = ''
let etimes = ''
// When set, the `ps -o pid=,etime=` call throws like execFileSync on a non-zero exit, with this stdout (or none).
let etimesThrow: { stdout?: string } | null = null

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: (cmd: string, args: string[], opts: unknown) =>
      cmd !== '/bin/ps' ? (real.execFileSync as unknown as (c: string, a: string[], o: unknown) => string)(cmd, args, opts)
        : args[1] === 'pid=,etime=' ? (etimesThrow ? (() => { throw Object.assign(new Error('ps exit 1'), etimesThrow) })() : etimes)
        // The narrowed env scan (REAPERENOBUFS1101): the name listing, then the environment of the runtime pids.
        : args[0] === '-axo' ? `70994 claude\n${POLLER_PID} /Users/u/.bun/bin/bun`
        : args[0] === 'eww' ? envScan
        : PS,
  }
})
// REAPERENOBUFS1101: the env scan is ps on macOS and /proc on Linux; this test pins the ps path on any host (CI is Linux).
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => (p === '/proc/self' ? false : real.existsSync(p)) }
})

const { probeChannelPluginLiveness } = await import('../channel-coordinator/liveness.js')
const { channelStateDir } = await import('../channel-provider.js')
const { agentDir } = await import('../web/agent-config.js')

const AGENT = 'liveness-envscan-probe-agent'
const row = (chanDir: string) =>
  `${String(POLLER_PID).padStart(5)} ??  S 0:01.00 /Users/u/.bun/bin/bun server.ts TELEGRAM_STATE_DIR=${chanDir} CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6`

describe('probeChannelPluginLiveness asks the state-dir env scan', () => {
  it('the wrapper is gone, the poller carries this agent\'s state dir and started after the claude: alive', () => {
    envScan = row(channelStateDir('telegram', agentDir(AGENT)))
    etimes = `70994 10:00\n${POLLER_PID} 09:58`
    expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('alive')
  })
  it('...an orphan of an earlier session with the same state dir: down', () => {
    envScan = row(channelStateDir('telegram', agentDir(AGENT)))
    etimes = `70994 10:00\n${POLLER_PID} 1:10:00`
    expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('down')
  })
  it('...the start times cannot be read at all (ps throws, no output): down, never alive', () => {
    envScan = row(channelStateDir('telegram', agentDir(AGENT)))
    etimesThrow = {}
    try {
      expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('down')
    } finally {
      etimesThrow = null
    }
  })
  it('...ps exits 1 because a pid went away but prints the rest: those rows still count', () => {
    envScan = row(channelStateDir('telegram', agentDir(AGENT)))
    etimesThrow = { stdout: `70994 10:00\n${POLLER_PID} 09:58` }
    try {
      expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('alive')
      etimesThrow = { stdout: '70994 10:00' }
      expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('down')
    } finally {
      etimesThrow = null
    }
  })
  it('...and with no such row: down', () => {
    envScan = row('/elsewhere/.claude/channels/telegram')
    etimes = `70994 10:00\n${POLLER_PID} 09:58`
    expect(probeChannelPluginLiveness(70994, 'telegram', AGENT)).toBe('down')
  })
})
