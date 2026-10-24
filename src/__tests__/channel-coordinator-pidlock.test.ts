import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryAcquirePidLock, isCoordinatorArgv, realPidLockDeps } from '../channel-coordinator.js'
import { spawnSync } from 'node:child_process'

const SELF = 4242
const PREV = 31337
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pidlock-'))
  file = join(dir, 'coordinator.pid')
})
afterEach(() => {
  try { chmodSync(dir, 0o700) } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
})

const deps = (alive: boolean, argv: string | null | undefined) => ({ isAlive: vi.fn(() => alive), argvOf: vi.fn(() => argv) })

describe('tryAcquirePidLock', () => {
  it('T1 creates the file with mode 0600 when absent', () => {
    expect(tryAcquirePidLock(file, SELF, deps(false, null))).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8')).toBe(String(SELF))
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('T2 refuses when a live coordinator holds it', () => {
    writeFileSync(file, String(PREV))
    expect(tryAcquirePidLock(file, SELF, deps(true, 'node /x/dist/channel-coordinator.js'))).toEqual({ ok: false, holder: PREV, reason: 'held' })
    expect(readFileSync(file, 'utf-8')).toBe(String(PREV))
  })

  it('T3 reclaims from a live unrelated process', () => {
    writeFileSync(file, String(PREV))
    expect(tryAcquirePidLock(file, SELF, deps(true, '/usr/bin/sleep 100'))).toEqual({ ok: true, reclaimed: PREV })
    expect(readFileSync(file, 'utf-8')).toBe(String(SELF))
  })

  it('T4 reclaims from a dead pid', () => {
    writeFileSync(file, String(PREV))
    const d = deps(false, null)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: PREV })
    expect(d.isAlive).toHaveBeenCalledWith(PREV)
  })

  it('T5 treats garbage as stale', () => {
    writeFileSync(file, 'abc')
    expect(tryAcquirePidLock(file, SELF, deps(true, 'channel-coordinator'))).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8')).toBe(String(SELF))
  })

  it('T6 accepts its own pid file unchanged', () => {
    writeFileSync(file, String(SELF))
    expect(tryAcquirePidLock(file, SELF, deps(true, 'channel-coordinator'))).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8')).toBe(String(SELF))
  })

  it('T7 live pid with undeterminable argv is held (fail closed)', () => {
    writeFileSync(file, String(PREV))
    expect(tryAcquirePidLock(file, SELF, deps(true, undefined))).toEqual({ ok: false, holder: PREV, reason: 'unknown' })
    expect(readFileSync(file, 'utf-8')).toBe(String(PREV))
  })

  it('T7b live pid whose argv is null (gone) is stale', () => {
    writeFileSync(file, String(PREV))
    expect(tryAcquirePidLock(file, SELF, deps(true, null))).toEqual({ ok: true, reclaimed: PREV })
  })

  it('isCoordinatorArgv matches only the coordinator script token', () => {
    for (const a of ['node /opt/x/dist/channel-coordinator.js', 'node dist/channel-coordinator.js --flag', 'tsx src/channel-coordinator.ts']) {
      expect(isCoordinatorArgv(a)).toBe(true)
    }
    for (const a of ['tail -f /var/log/channel-coordinator.log', 'vim src/channel-coordinator.ts.bak', 'grep channel-coordinator', 'node /x/channel-coordinator-old.js']) {
      expect(isCoordinatorArgv(a)).toBe(false)
    }
  })

  it('a live tail of the log does not block', () => {
    writeFileSync(file, String(PREV))
    expect(tryAcquirePidLock(file, SELF, deps(true, 'tail -f channel-coordinator.log'))).toEqual({ ok: true, reclaimed: PREV })
  })

  it('strict parse: numeric prefix is garbage', () => {
    writeFileSync(file, '31337garbage')
    expect(tryAcquirePidLock(file, SELF, deps(true, 'node /x/dist/channel-coordinator.js'))).toEqual({ ok: true, reclaimed: null })
    rmSync(file)
    writeFileSync(file, '4242garbage')
    expect(tryAcquirePidLock(file, 4242, deps(true, 'node /x/dist/channel-coordinator.js'))).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8')).toBe('4242')
  })

  it('re-read guard: does not unlink a file replaced after our read', () => {
    const S = 1111, OTHER = 2222
    writeFileSync(file, String(S))
    const d = {
      isAlive: vi.fn((pid: number) => {
        if (pid === S) { writeFileSync(file, String(OTHER)); return false }
        return pid === OTHER
      }),
      argvOf: vi.fn((pid: number) => (pid === OTHER ? 'node /x/dist/channel-coordinator.js' : null)),
    }
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: OTHER, reason: 'held' })
    expect(readFileSync(file, 'utf-8')).toBe(String(OTHER))
  })

  it('contention: three attempts exhausted', () => {
    writeFileSync(file, '1111')
    const d = {
      isAlive: vi.fn((pid: number) => { writeFileSync(file, String(pid + 1)); return false }),
      argvOf: vi.fn(() => null),
    }
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: null, reason: 'contention' })
    expect(d.isAlive).toHaveBeenCalledTimes(3)
  })

  it.skipIf(process.getuid?.() === 0)('T8 does not swallow an unlink failure other than ENOENT', () => {
    writeFileSync(file, String(PREV))
    chmodSync(dir, 0o500)
    try {
      expect(() => tryAcquirePidLock(file, SELF, deps(false, null))).toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('T9 rethrows a non-EEXIST write error', () => {
    expect(() => tryAcquirePidLock(join(dir, 'missing', 'x.pid'), SELF, deps(false, null))).toThrow()
  })

  it('T10 acquireSingleInstanceLock uses tryAcquirePidLock with O_EXCL', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'channel-coordinator.ts'), 'utf-8')
    const body = src.slice(src.indexOf('function acquireSingleInstanceLock'))
    expect(body.slice(0, body.indexOf('function releaseLock'))).toContain('tryAcquirePidLock(')
    expect(src).toContain("flag: 'wx'")
  })
})

describe('realPidLockDeps (real kill and ps)', () => {
  it('a live process: alive, with a readable command line', () => {
    expect(realPidLockDeps.isAlive(process.pid)).toBe(true)
    const argv = realPidLockDeps.argvOf(process.pid)
    expect(typeof argv).toBe('string')
    expect(argv).toMatch(/node/)
  })

  it('a process of another user (pid 1): alive, even though kill(pid, 0) is refused with EPERM', () => {
    // As root kill(1, 0) succeeds; as any other user it fails with EPERM. Alive either way.
    expect(realPidLockDeps.isAlive(1)).toBe(true)
  })

  it('a process that has exited: not alive, and its command line is "gone" (null), not "unknown"', () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    expect(realPidLockDeps.isAlive(child.pid)).toBe(false)
    expect(realPidLockDeps.argvOf(child.pid)).toBeNull()
  })
})
