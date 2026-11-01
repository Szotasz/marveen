// REAPERENOBUFS1101: the env scan reads only the processes a poller can be (the JS runtimes, plus the bot.pid holder).
// The whole-host `ps axeww` printed every process's environment (measured 2026-11-01: 17.5 MB, 2.3 s), over the 8 MB
// buffer: ENOBUFS, an empty scan, nothing reaped, and the dashboard's loop held ~2 s a round. Host-independent: ps and
// /proc are injected.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { envScan, runtimePidsFromComm, parseStateDirPollerPids, type EnvScanDeps } from '../web/channel-poller-reap.js'

const ROOT = 'CLAUDE_PLUGIN_ROOT=/Users/u/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6'
const DIR = '/Users/u/inst/agents/zara/.claude/channels/telegram'

function psDeps(listing: string, envRows: string | (() => string)): EnvScanDeps & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    useProc: false,
    ps: (args) => {
      calls.push([...args])
      if (args[0] === '-axo') return listing
      return typeof envRows === 'function' ? envRows() : envRows
    },
    procPids: () => { throw new Error('no /proc on this path') },
    procRead: () => { throw new Error('no /proc on this path') },
  }
}

describe('runtimePidsFromComm', () => {
  it('keeps the JS runtimes by the base name of comm (a full path on macOS), never pid 1', () => {
    const listing = [
      '    1 /sbin/launchd',
      '  101 /opt/homebrew/Cellar/node@22/22.22.3/bin/node',
      '  102 /Users/u/.bun/bin/bun',
      '  103 /usr/libexec/logd',
      '  104 node',
      '  105 claude',
      '  106 npx',
      '',
    ].join('\n')
    expect(runtimePidsFromComm(listing)).toEqual([101, 102, 104, 106])
  })
})

describe('envScan, the ps path (macOS)', () => {
  it('lists every process by name only, then reads the environment of the runtime ones and the extra pid', () => {
    const deps = psDeps('  101 /usr/local/bin/node\n  103 /usr/libexec/logd\n  104 bun\n', 'PID COMMAND\n  104 bun server.ts X=1\n')
    expect(envScan([777], deps)).toBe('PID COMMAND\n  104 bun server.ts X=1\n')
    expect(deps.calls).toEqual([['-axo', 'pid=,comm='], ['eww', '-o', 'pid,command', '-p', '101,104,777']])
  })

  it('no runtime and no extra pid: an empty scan, with no environment read at all', () => {
    const deps = psDeps('  103 /usr/libexec/logd\n', 'never')
    expect(envScan([], deps)).toBe('')
    expect(deps.calls).toEqual([['-axo', 'pid=,comm=']])
  })

  it('every listed pid exited before the read: ps prints the header and exits 1 (measured): an empty scan, not a failure', () => {
    const deps = psDeps('  104 bun\n', () => { throw Object.assign(new Error('ps exit 1'), { status: 1, stdout: '  PID COMMAND\n' }) })
    expect(envScan([], deps)).toBe('  PID COMMAND\n')
  })

  it('any other failure is thrown to the caller (which logs it loud and reaps nothing)', () => {
    const enobufs = psDeps('  104 bun\n', () => { throw Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS', stdout: 'x' }) })
    expect(() => envScan([], enobufs)).toThrow('ENOBUFS')
    const listingFails: EnvScanDeps = { ...psDeps('', ''), ps: () => { throw new Error('ps gone') } }
    expect(() => envScan([], listingFails)).toThrow('ps gone')
  })
})

describe('envScan, the /proc path (Linux)', () => {
  const proc: Record<number, Partial<Record<'comm' | 'cmdline' | 'environ', string>>> = {
    1: { comm: 'systemd\n', cmdline: '/sbin/init\0', environ: '' },
    200: { comm: 'bun\n', cmdline: 'bun\0server.ts\0', environ: `TELEGRAM_STATE_DIR=${DIR}\0${ROOT}\0HOME=/home/u\0` },
    201: { comm: 'node\n', cmdline: 'node\0build.js\0', environ: `TELEGRAM_STATE_DIR=${DIR}\0` },
    202: { comm: 'python3\n', cmdline: 'python3\0x.py\0', environ: 'A=1\0' },
    203: { comm: 'bun\n' }, // gone between the listing and the read
  }
  const deps: EnvScanDeps = {
    useProc: true,
    ps: () => { throw new Error('no ps on this path') },
    procPids: () => Object.keys(proc).map(Number),
    procRead: (pid, file) => proc[pid]?.[file] ?? null,
  }

  it('one row per runtime process (and the extra pid), `<pid> <cmdline> <environ>`; a gone process is skipped', () => {
    expect(envScan([202], deps).split('\n')).toEqual([
      `200 bun server.ts TELEGRAM_STATE_DIR=${DIR} ${ROOT} HOME=/home/u`,
      `201 node build.js TELEGRAM_STATE_DIR=${DIR}`,
      '202 python3 x.py A=1',
    ])
  })

  it('the rows feed the same parser: only the plugin poller of this state dir is a candidate', () => {
    expect(parseStateDirPollerPids(envScan([], deps), 'TELEGRAM_STATE_DIR', DIR, '/telegram')).toEqual([200])
  })
})

describe('the wiring', () => {
  it('a channel dir\'s snapshot also reads the bot.pid holder (a poller whose comm is not a known runtime name still counts)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'web', 'channel-poller-reap.ts'), 'utf8')
    const snap = src.slice(src.indexOf('function psEwwSnapshot(chanDir: string): string {'))
    expect(snap.slice(0, snap.indexOf('\n}\n'))).toContain("return envScanOrEmpty({ chanDir }, botPid !== null ? [botPid] : []) ?? ''")
  })
})

describe('a failing scan is loud (error level, counted in a row)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('node:child_process'); vi.doUnmock('node:fs') })

  it('logs at error level with failuresInARow 1, 2, ... and reaps nothing', async () => {
    vi.resetModules() // a fresh module under the mocks below (the static import above has none)
    vi.doMock('node:child_process', async (orig) => ({
      ...(await orig<typeof import('node:child_process')>()),
      execFileSync: () => { throw Object.assign(new Error('spawnSync /bin/ps ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
    }))
    vi.doMock('node:fs', async (orig) => {
      const real = await orig<typeof import('node:fs')>()
      return { ...real, existsSync: (p: string) => (p === '/proc/self' ? false : real.existsSync(p)) }
    })
    const reap = await import('../web/channel-poller-reap.js')
    const { logger } = await import('../logger.js')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    expect(reap.stateDirPluginPollerPids('telegram', '/tmp/envscan-loud-a')).toEqual([])
    expect(reap.stateDirPluginPollerPids('telegram', '/tmp/envscan-loud-b')).toEqual([])
    const fields = error.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(fields.map((f) => f.failuresInARow)).toEqual([1, 2])
    expect(fields[0]!.code).toBe('ETIMEDOUT')
    expect(String(error.mock.calls[0]![1])).toContain('env scan FAILED')
  })
})
