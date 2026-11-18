import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { tryAcquirePidLock, realPidLockDeps } from '../channel-coordinator.js'

// PID-reuse regression (card c3f84534). Measured incident (2026-11-17/18, WSL):
// after a reboot the legacy lock still held the naked pid "1161" written Nov 1;
// pid 1161 was reused by /usr/bin/node server.js, /bin/ps could not inspect it
// (argvOf -> undefined), so the coordinator refused to start 2213 times in a row.
// The fix reclaims such locks from start-time evidence and records boot_id +
// start time in new locks so reuse is decidable without ps.
//
// Revision round (defect B1, measured 2026-11-18): the new-format lock's third
// token is the RAW /proc/<pid>/stat field 22 tick, NOT the derived epoch ms of
// the first revision. epoch ms = Date.now() - uptime*1000 + (ticks/100)*1000
// over THREE separately-read clocks: 40 samples of one live pid gave 9-10
// DISTINCT values with a 9 ms spread, and the decision compares for EXACT
// equality -- so a live holder was recomputed as "pid reuse", reclaimed, and
// two coordinators landed on one token. The raw tick is one /proc read: exact.

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
  // startEpochMs -- the DERIVED, jittering epoch ms. Only the legacy mtime
  // hatch (R1-R4) still consults it; the new-format decisions must not.
  start?: (pid: number) => number | undefined
  // startTicks -- the RAW /proc tick, the lock's identity token.
  ticks?: (pid: number) => number | undefined
}

// PidLockDeps today has isAlive + argvOf only. The card adds OPTIONAL bootId(),
// startTicks(pid) (the identity token) and startEpochMs(pid) (legacy hatch);
// when absent the behavior must stay today's.
const deps = (o: DepSpec = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = {
    isAlive: vi.fn(() => o.alive ?? true),
    argvOf: vi.fn(() => o.argv),
  }
  if (o.boot !== undefined) d.bootId = vi.fn(() => o.boot)
  if (o.start) d.startEpochMs = vi.fn((pid: number) => o.start!(pid))
  if (o.ticks) d.startTicks = vi.fn((pid: number) => o.ticks!(pid))
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

describe('tryAcquirePidLock: new-format locks ("pid boot_id tick")', () => {
  it('N1 writes its own lock in the new format when bootId and the raw tick are available', () => {
    const d = deps({ boot: BOOT, ticks: (pid) => (pid === SELF ? 123456 : undefined) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('N2 writes the legacy naked-pid format when bootId is unavailable', () => {
    const d = deps({}) // no bootId member
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(SELF))
  })

  it('N3 same boot_id and same raw tick: held, decided without ps (argvOf not called)', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: true, argv: undefined, boot: BOOT, ticks: () => 999000 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'held' })
    expect(d.argvOf).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf-8').trim()).toBe(`31337 ${BOOT} 999000`)
  })

  it('N4 different boot_id (reboot): stale, reclaimed', () => {
    writeFileSync(file, `31337 ${OTHER_BOOT} 999000`)
    const d = deps({ boot: BOOT, ticks: (pid) => (pid === SELF ? 123456 : 999000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N5 same boot_id, different raw tick (pid reuse): stale, reclaimed', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ boot: BOOT, ticks: (pid) => (pid === SELF ? 123456 : 888000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N6 same boot_id, dead pid: stale, reclaimed', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: false, boot: BOOT, ticks: (pid) => (pid === SELF ? 123456 : 999000) })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: 31337 })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('N7 its own new-format lock is accepted unchanged', () => {
    writeFileSync(file, `${SELF} ${BOOT} 123456`)
    const d = deps({ boot: BOOT, ticks: () => 123456 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })

  it('E1 its own pid after a reboot (stale boot token in a new-format lock) rewrites a fresh lock, still ok', () => {
    writeFileSync(file, `${SELF} ${OTHER_BOOT} 999000`)
    const d = deps({ boot: BOOT, ticks: () => 123456 })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`)
  })
})

// The B1 red pins (card c3f84534, measured 2026-11-18): startEpochMs combines
// THREE separately-read clocks, so on a live pid it returned 9-10 distinct
// values over 40 samples (9 ms spread). The lock decision compares for EXACT
// equality, so an epoch-ms identity token declared a LIVE holder "pid reuse" ->
// STALE -> reclaimed -> two coordinators on one token. Here startEpochMs returns
// a DIFFERENT value on EVERY call (counter-based, >= 9 ms apart, as measured)
// while startTicks is constant: neither verdict may be influenced by it, and
// argvOf must not be consulted at all. On the pre-fix code both cases went
// STALE (J1 reclaimed the live holder, J2 rewrote our own lock).
describe('tryAcquirePidLock: jitter immunity of the identity token (B1)', () => {
  const jitterDeps = (holderTick: number, selfTick: number) => {
    let n = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = {
      isAlive: vi.fn(() => true),
      // If the raw tick does not decide, argvOf must not be reached at all:
      // make any consultation loud instead of silently returning a value.
      argvOf: vi.fn(() => { throw new Error('B1: argvOf consulted although the raw tick decides') }),
      bootId: vi.fn(() => BOOT),
      startTicks: vi.fn((pid: number) => (pid === SELF ? selfTick : holderTick)),
      // Counter-based jitter: every call returns a different value, consecutive
      // calls 9 ms apart -- the measured spread of the real implementation.
      startEpochMs: vi.fn(() => { n += 1; return 1_700_000_000_000 + n * 9 }),
    }
    return { d, epochSamples: () => Array.from({ length: 40 }, () => d.startEpochMs(0) as number) }
  }

  it('J1 a live holder with matching boot+tick is held, even though startEpochMs differs on every call', () => {
    const { d, epochSamples } = jitterDeps(777_777, 123_456)
    writeFileSync(file, `31337 ${BOOT} 777777`)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'held' })
    expect(d.argvOf).not.toHaveBeenCalled()
    expect(d.startEpochMs).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf-8').trim()).toBe(`31337 ${BOOT} 777777`)
    // The fake reproduces the measurement it stands for: many distinct values,
    // spread well beyond the 9 ms single-step jitter.
    const s = epochSamples()
    expect(new Set(s).size).toBeGreaterThanOrEqual(9)
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThanOrEqual(9 * 9)
  })

  it('J2 our own new-format lock is ours (ok, no reclaim) despite the jittering startEpochMs', () => {
    const { d } = jitterDeps(777_777, 123_456)
    writeFileSync(file, `${SELF} ${BOOT} 123456`)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null })
    expect(d.argvOf).not.toHaveBeenCalled()
    expect(d.startEpochMs).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf-8').trim()).toBe(`${SELF} ${BOOT} 123456`) // not rewritten
  })
})

// The B1 real-world pin: a GENUINE live child and a GENUINE new-format lock
// written from realPidLockDeps (bootId + startTicks of the child), then 20
// acquisition attempts from a DIFFERENT self pid. Every attempt must report
// held: the live child's recomputed identity token must equal the recorded one
// EXACTLY. On the pre-fix code the derived epoch ms token differed on nearly
// every read, so the first attempt already reclaimed the live child's lock.
// Skipped gracefully when /proc is unavailable (Linux CI has it).
describe('realPidLockDeps: a genuine live holder is held on every attempt (B1)', () => {
  it.skipIf(!existsSync('/proc/self/stat'))('20 acquisitions against a live child\'s new-format lock all report held', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
    try {
      expect(child.pid).toBeGreaterThan(0)
      const boot = realPidLockDeps.bootId?.()
      expect(boot).toBeDefined()
      // /proc/<pid>/stat exists from fork; poll briefly anyway so a slow spawn
      // cannot turn this into a test about a missing file.
      let tick = realPidLockDeps.startTicks?.(child.pid!)
      for (let i = 0; tick === undefined && i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50))
        tick = realPidLockDeps.startTicks?.(child.pid!)
      }
      expect(tick).toBeDefined()
      writeFileSync(file, `${child.pid} ${boot} ${tick}`)
      const selfPid = child.pid === SELF ? SELF + 1 : SELF // never the holder's pid
      for (let i = 0; i < 20; i++) {
        expect(tryAcquirePidLock(file, selfPid, realPidLockDeps)).toEqual({ ok: false, holder: child.pid, reason: 'held' })
      }
      expect(readFileSync(file, 'utf-8').trim()).toBe(`${child.pid} ${boot} ${tick}`) // never reclaimed
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('realPidLockDeps extended members', () => {
  it('bootId() reads a nonempty boot id when /proc is available (skipped when undefined)', () => {
    const boot = realPidLockDeps.bootId?.()
    if (boot !== undefined) expect(boot).toMatch(/^[0-9a-f][0-9a-f-]{7,}$/)
  })

  it('startTicks(self) is a non-negative integer (the raw /proc tick)', () => {
    const t = realPidLockDeps.startTicks?.(process.pid)
    if (t === undefined) return // /proc unavailable
    expect(Number.isSafeInteger(t)).toBe(true)
    expect(t).toBeGreaterThanOrEqual(0)
  })

  it('startTicks is EXACT: stable across 40 reads of the same live pid (the B1 property)', () => {
    // The B1 measurement (card c3f84534, 2026-11-18) that disqualifies the
    // derived epoch ms: the raw tick must give ONE value for one process.
    const first = realPidLockDeps.startTicks?.(process.pid)
    if (first === undefined) return // /proc unavailable
    for (let i = 0; i < 40; i++) expect(realPidLockDeps.startTicks?.(process.pid)).toBe(first)
  })

  it('startTicks of a dead pid is undefined', () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    expect(realPidLockDeps.startTicks?.(child.pid!)).toBeUndefined()
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

describe('round 3: zombie holder, unsafe tick, no-start deps', () => {
  const linux = realPidLockDeps.bootId?.() !== undefined

  async function withZombie(fn: (z: number) => void | Promise<void>) {
    const sh = spawn('/bin/sh', ['-c', 'true & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const out: string = await new Promise((res) => sh.stdout!.once('data', (c) => res(String(c))))
      const z = Number(out.trim())
      expect(z).toBeGreaterThan(0)
      const deadline = Date.now() + 2000
      const state = () => {
        try {
          const st = readFileSync(`/proc/${z}/stat`, 'utf-8')
          return st.slice(st.lastIndexOf(')') + 2).split(' ')[0]
        } catch { return undefined }
      }
      while (state() !== 'Z' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(state()).toBe('Z')
      await fn(z)
    } finally {
      sh.kill('SIGKILL')
    }
  }

  it.skipIf(!linux)('Z1 a real zombie is alive to kill(0) but has no tick', async () => {
    await withZombie((z) => {
      expect(realPidLockDeps.isAlive(z)).toBe(true)
      expect(realPidLockDeps.startTicks?.(z)).toBeUndefined()
    })
  })

  it.skipIf(!linux)('Z2 a lock held by a real zombie is reclaimed', async () => {
    await withZombie((z) => {
      const st = readFileSync(`/proc/${z}/stat`, 'utf-8')
      const rawTick = st.slice(st.lastIndexOf(')') + 2).split(' ')[19]
      writeFileSync(file, `${z} ${realPidLockDeps.bootId!()} ${rawTick}`)
      expect(tryAcquirePidLock(file, SELF, realPidLockDeps)).toMatchObject({ ok: true, reclaimed: z })
    })
  })

  it('G1 an unsafe-integer tick is garbage, not a reuse verdict', () => {
    const d = deps({ alive: true, boot: BOOT, ticks: () => 999000 })
    writeFileSync(file, `31337 ${BOOT} 99999999999999999999`)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: null }) // garbage has no parseable pid
    expect(d.isAlive).not.toHaveBeenCalled()
  })

  it('A3b unreadable tick, unreadable argv: unknown', () => {
    const d = deps({ alive: true, argv: undefined, boot: BOOT, ticks: () => undefined })
    writeFileSync(file, `31337 ${BOOT} 999000`)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'unknown' })
    expect(d.argvOf).toHaveBeenCalled()
  })

  it('A3c unreadable tick: argv decides', () => {
    const d = deps({ alive: true, argv: 'node /x/dist/channel-coordinator.js', boot: BOOT, ticks: () => undefined })
    writeFileSync(file, `31337 ${BOOT} 999000`)
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'held' })
    const d2 = deps({ alive: true, argv: 'node server.js', boot: BOOT, ticks: () => undefined })
    writeFileSync(file, `31337 ${BOOT} 999000`)
    expect(tryAcquirePidLock(file, SELF, d2)).toEqual({ ok: true, reclaimed: 31337 })
  })
})
