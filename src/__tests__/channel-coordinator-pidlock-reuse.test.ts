import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tryAcquirePidLock, realPidLockDeps } from '../channel-coordinator.js'

// PID-reuse regression (card c3f84534). Measured incident (2026-11-17/18, WSL):
// after a reboot the legacy lock still held the naked pid "1161" written Nov 1;
// pid 1161 was reused by /usr/bin/node server.js, /bin/ps could not inspect it
// (argvOf -> undefined), so the coordinator refused to start 2213 times in a row.
// The fix reclaims such locks from start-time evidence and records boot_id +
// start time in new locks so reuse is decidable without ps.

const SELF = 4242
const LEGACY = 1161 // the pid from the measured incident
const NOW = Date.now()
const BOOT = 'b0000000-0000-0000-0000-000000000001'
const OTHER_BOOT = 'aaaaaaaa-0000-0000-0000-000000000002'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pidlock-reuse-'))
  file = join(dir, 'coordinator.pid')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface DepSpec {
  alive?: boolean
  argv?: string | null | undefined
  boot?: string | undefined
  start?: (pid: number) => number | undefined
}

// PidLockDeps today has isAlive + argvOf only. The fix adds OPTIONAL bootId()
// and startEpochMs(pid); when absent the behavior must stay today's.
const deps = (o: DepSpec = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = {
    isAlive: vi.fn(() => o.alive ?? true),
    argvOf: vi.fn(() => o.argv),
  }
  if (o.boot !== undefined) d.bootId = vi.fn(() => o.boot)
  if (o.start) d.startEpochMs = vi.fn((pid: number) => o.start!(pid))
  return d
}

const ageFile = (ms: number) => {
  const t = (NOW - ms) / 1000
  utimesSync(file, t, t)
}

describe('tryAcquirePidLock: legacy naked-pid lock after pid reuse', () => {
  it('R1 reclaims when the live unknown-argv pid started long after the lock was written (the measured WSL incident)', () => {
    writeFileSync(file, String(LEGACY))
    ageFile(7 * 24 * 3600 * 1000) // lock written a week ago
    const d = deps({ alive: true, argv: undefined, start: () => NOW }) // the pid-1161 process started now
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: LEGACY })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(SELF))
  })

  it('R2 still refuses (fail closed) when the live unknown-argv pid may be the writer: it started before the lock mtime', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined, start: () => NOW - 3600_000 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'unknown' })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(LEGACY))
  })

  it('R3 unknown argv without start-time evidence still refuses (deps unchanged from today)', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined }) // no startEpochMs member at all
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'unknown' })
  })

  it('R4 start time within a small skew of the lock mtime stays conservative, not stale', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined, start: () => NOW + 200 }) // started ~when the lock was written
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'unknown' })
  })
})

describe('tryAcquirePidLock: new-format locks ("pid boot_id starttime")', () => {
  it('N1 writes its own lock in the new format when bootId and start time are available', () => {
    const d = deps({ boot: BOOT, start: (pid) => (pid === SELF ? 123456 : undefined) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('N2 writes the legacy naked-pid format when bootId is unavailable', () => {
    const d = deps({}) // no bootId member
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(SELF))
  })

  it('N3 same boot_id and same starttime: held, decided without ps (argvOf not called)', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: true, argv: undefined, boot: BOOT, start: () => 999000 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'held' })
    expect(d.argvOf).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf-8').trim()).toBe(`31337 ${BOOT} 999000`)
  })

  it('N4 different boot_id (reboot): stale, reclaimed', () => {
    writeFileSync(file, `31337 ${OTHER_BOOT} 999000`)
    const d = deps({ boot: BOOT, start: (pid) => (pid === SELF ? 123456 : 999000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N5 same boot_id, different starttime (pid reuse): stale, reclaimed', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ boot: BOOT, start: (pid) => (pid === SELF ? 123456 : 888000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N6 same boot_id, dead pid: stale, reclaimed', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: false, boot: BOOT, start: (pid) => (pid === SELF ? 123456 : 999000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N7 its own new-format lock is accepted unchanged', () => {
    writeFileSync(file, `${SELF} ${BOOT} 123456`)
    const d = deps({ boot: BOOT, start: () => 123456 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('E1 its own pid after a reboot (stale boot token in a new-format lock) rewrites a fresh lock, still ok', () => {
    writeFileSync(file, `${SELF} ${OTHER_BOOT} 999000`)
    const d = deps({ boot: BOOT, start: () => 123456 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })
})

describe('realPidLockDeps extended members', () => {
  it('bootId() reads a nonempty boot id when /proc is available (skipped when undefined)', () => {
    const boot = realPidLockDeps.bootId?.()
    if (boot !== undefined) expect(boot).toMatch(/^[0-9a-f][0-9a-f-]{7,}$/)
  })

  it('startEpochMs(self) is a plausible epoch ms: within [now-24h, now]', () => {
    const s = realPidLockDeps.startEpochMs?.(process.pid)
    expect(s).toBeGreaterThanOrEqual(NOW - 24 * 3600 * 1000)
    expect(s).toBeLessThanOrEqual(Date.now())
  })

  it('startEpochMs of a dead pid is undefined', () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    expect(realPidLockDeps.startEpochMs?.(child.pid!)).toBeUndefined()
  })
})
