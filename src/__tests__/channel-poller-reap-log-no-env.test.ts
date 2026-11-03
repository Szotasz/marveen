// TESTENVLEAK1101: a failed `ps axeww` must never put the process environment into a log line. execSync's error
// carries the child's whole stdout; logged as `{ err }`, pino wrote it into dashboard.log (measured 2026-11-01: an
// 8.4 MB err.stdout from an ENOBUFS scan, every ~11 minutes, tokens included), and a failing reap test printed it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SECRET = 'leakprobe-7f3c9a1e5d'
const envDump = `  PID   TT  STAT      TIME COMMAND\n  42 ??  S  0:00.01 /usr/bin/bun server.ts GH_TOKEN=${SECRET} CLAUDE_CODE_OAUTH_TOKEN=${SECRET}x\n`
const failing = () => Object.assign(new Error('spawnSync /bin/sh ENOBUFS'), { code: 'ENOBUFS', status: null, signal: 'SIGTERM', stdout: envDump, stderr: '' })

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execSync: () => { throw failing() },
  // REAPERENOBUFS1101: the env scan runs /bin/ps through execFileSync now; it fails the same way.
  execFileSync: () => { throw failing() },
}))
// The ps path on any host (CI is Linux, where the scan would read /proc instead).
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => (p === '/proc/self' ? false : real.existsSync(p)) }
})

const { execFailure, stateDirPluginPollerPids } = await import('../web/channel-poller-reap.js')
const { logger } = await import('../logger.js')

afterEach(() => { vi.restoreAllMocks() })

describe('TESTENVLEAK1101: no environment in a failed scan\'s log line', () => {
  it('execFailure keeps the kind of failure and the output size, never the output', () => {
    const f = execFailure(failing())
    expect(f).toEqual({ code: 'ENOBUFS', signal: 'SIGTERM', status: null, stdoutBytes: Buffer.byteLength(envDump) })
    expect(JSON.stringify(f)).not.toContain(SECRET)
    expect(execFailure(undefined)).toEqual({ code: null, signal: null, status: null, stdoutBytes: 0 })
    expect(execFailure(Object.assign(new Error('x'), { stdout: Buffer.from(envDump) })).stdoutBytes).toBe(Buffer.byteLength(envDump))
  })

  it('a failing env scan logs no token-like value and no stdout field (the real catch, ps failing)', () => {
    // REAPERENOBUFS1101: a failed scan is logged at error level (a blind reaper is never quiet).
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    expect(stateDirPluginPollerPids('telegram', '/tmp/leakprobe-chan')).toEqual([])
    expect(error).toHaveBeenCalled()
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toMatch(/[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|KEY)=\S/)
    expect(logged).not.toContain('"stdout"')
    expect(logged).toContain('"stdoutBytes"')
  })

  it('channel-poller-reap.ts never logs a raw error object (source pin)', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'channel-poller-reap.ts'), 'utf8')
    // `{ err }`, `{ x, err }`, `{ err: e }`: the error object as a field (execFailure(err) is the allowed form)
    expect(src).not.toMatch(/logger\.\w+\(\s*\{(?:[^}]*[{,]\s*)?err\s*[,}:]/)
    expect(src).not.toMatch(/logger\.\w+\(\s*err\s*[,)]/)
    const catches = [...src.matchAll(/catch \((\w+)\) \{\n\s+logger\.\w+\(([^\n]*)/g)]
    // REAPERENOBUFS1101: the two env-scan catches became one (envScanOrEmpty), so 4 logging catches remain.
    expect(catches.length).toBeGreaterThanOrEqual(4)
    for (const [, name, args] of catches) expect(args, args).toContain(`execFailure(${name})`)
  })
})
