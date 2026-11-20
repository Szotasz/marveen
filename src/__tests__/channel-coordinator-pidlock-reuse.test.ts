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
// The fix reads the holder's command line from /proc/<pid>/cmdline before ps
// and records boot_id + start tick in new locks so reuse is decidable without ps.
//
// Round 4 (PR #2881 review, 2026-11-18): the first fix reclaimed a live
// unknown-argv holder when its start time (derived from the wall clock) was
// after the lock mtime. A forward clock step (NTP, VM resume) makes a LIVE
// coordinator look younger than its own lock, so that rule reclaimed it: two
// coordinators on one token. The rule is gone; a holder whose command line
// neither /proc nor ps can read is refused (fail closed), whatever the clocks say.
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
  // startEpochMs -- the DERIVED, jittering epoch ms. Since round 4 no decision
  // may consult it; C1/C2/R2/R4 still pass it to prove a clock step cannot reclaim.
  start?: (pid: number) => number | undefined
  // procArgvOf -- the command line from /proc/<pid>/cmdline, read before argvOf.
  proc?: (pid: number) => string | undefined
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
  if (o.proc) d.procArgvOf = vi.fn((pid: number) => o.proc!(pid))
  return d
}

const ageFile = (ms: number) => {
  const t = (NOW - ms) / 1000
  utimesSync(file, t, t)
}

describe('tryAcquirePidLock: legacy naked-pid lock after pid reuse', () => {
  it('R1 reclaims when ps cannot read the live pid but /proc/<pid>/cmdline shows an unrelated process (the measured WSL incident)', () => {
    writeFileSync(file, String(LEGACY))
    ageFile(7 * 24 * 3600 * 1000) // lock written a week ago
    const d = deps({ alive: true, argv: undefined, proc: () => '/usr/bin/node server.js' })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: LEGACY })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(SELF))
    expect(d.procArgvOf).toHaveBeenCalledWith(LEGACY)
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

// Round 4 (PR #2881 review): a forward clock step after the lock was written
// makes the derived start time land AFTER the lock mtime for the very process
// that wrote it. `start: NOW + 1h` simulates that step; a lock mtime in the
// future simulates a backward step.
describe('tryAcquirePidLock: clock steps cannot reclaim a live holder (round 4)', () => {
  const COORD = 'node /x/dist/channel-coordinator.js'
  const STEP = 3600_000

  it('C1 forward step, ps cannot read argv, /proc shows the coordinator: held, ps not asked', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined, proc: () => COORD, start: () => NOW + STEP })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'held' })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(LEGACY))
    expect(d.argvOf).not.toHaveBeenCalled()
  })

  it('C2 forward step, neither /proc nor ps can read argv: unknown (fail closed), not stale', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined, proc: () => undefined, start: () => NOW + STEP })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'unknown' })
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(LEGACY))
    expect(d.argvOf).toHaveBeenCalledWith(LEGACY) // /proc could not tell: ps is asked
  })

  it('C3 backward step (lock mtime in the future), no argv at all: unknown', () => {
    writeFileSync(file, String(LEGACY))
    ageFile(-STEP)
    const d = deps({ alive: true, argv: undefined, start: () => NOW })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'unknown' })
  })

  it('C4 a reused pid (other argv in /proc) is stale whatever the clocks say', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: undefined, proc: () => '/usr/bin/node server.js', start: () => NOW - STEP })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: LEGACY })
  })

  it('C5 new-format lock, tick unreadable, forward step, /proc shows the coordinator: held', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: true, argv: undefined, boot: BOOT, ticks: () => undefined, proc: () => COORD, start: () => NOW + STEP })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'held' })
    expect(readFileSync(file, 'utf-8').trim()).toBe(`31337 ${BOOT} 999000`)
  })

  it('C6 /proc is read before ps: a coordinator in /proc wins over a different ps answer', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: '/usr/bin/node server.js', proc: () => COORD })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: LEGACY, reason: 'held' })
    expect(d.argvOf).not.toHaveBeenCalled()
  })

  it('C7 /proc is read before ps, the other way round: a foreign /proc argv is stale even when ps would answer coordinator', () => {
    writeFileSync(file, String(LEGACY))
    const d = deps({ alive: true, argv: COORD, proc: () => '/usr/bin/node server.js' })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: true, reclaimed: LEGACY })
    expect(d.argvOf).not.toHaveBeenCalled()
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

  // Round 4: the derived startEpochMs member is gone (its only use was the
  // wall-clock reclaim); procArgvOf reads the command line before ps.
  it('startEpochMs is no longer a member', () => {
    expect('startEpochMs' in realPidLockDeps).toBe(false)
  })

  it.skipIf(!existsSync('/proc/self/cmdline'))('procArgvOf of a live child is its argv, space-joined', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(child.pid).toBeGreaterThan(0)
      let argv = realPidLockDeps.procArgvOf?.(child.pid!)
      // fork shows the parent's argv until exec: poll until the exec landed
      for (let i = 0; argv !== '/bin/sleep 30' && i < 100; i++) {
        await new Promise((r) => setTimeout(r, 20))
        argv = realPidLockDeps.procArgvOf?.(child.pid!)
      }
      expect(argv).toBe('/bin/sleep 30')
    } finally {
      child.kill('SIGKILL')
    }
  })

  it.skipIf(!existsSync('/proc/self/cmdline'))('procArgvOf of a dead pid is undefined', () => {
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    expect(realPidLockDeps.procArgvOf?.(child.pid!)).toBeUndefined()
  })
})

describe('round 3: zombie holder, unsafe tick, no-start deps', () => {
  const linux = realPidLockDeps.bootId?.() !== undefined

  async function withZombie(fn: (z: number) => void | Promise<void>) {
    const sh = spawn('/bin/sh', ['-c', 'sleep 0.3 & echo $!; exec sleep 10'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const out: string = await new Promise((res, rej) => {
        sh.once('error', rej)
        sh.once('exit', () => rej(new Error('shell exited before any stdout data')))
        sh.stdout!.once('data', (c) => res(String(c)))
      })
      const z = Number(out.trim())
      expect(z).toBeGreaterThan(0)
      const deadline = Date.now() + 3000
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
      const exited = new Promise<void>((r) => {
        if (sh.exitCode !== null || sh.signalCode !== null) r()
        else sh.once('exit', () => r())
      })
      sh.kill('SIGKILL')
      await exited
    }
  }

  it.skipIf(!linux)('Z1 a real zombie is alive to kill(0) but has no tick', async () => {
    await withZombie((z) => {
      expect(realPidLockDeps.isAlive(z)).toBe(true)
      expect(realPidLockDeps.startTicks?.(z)).toBeUndefined()
    })
  })

  it.skipIf(!linux)('Z3 /proc cannot tell a real zombie\'s argv (empty cmdline): undefined, ps decides', async () => {
    await withZombie((z) => {
      expect(realPidLockDeps.procArgvOf?.(z)).toBeUndefined()
    })
  })

  it.skipIf(!linux)('Z2 a lock held by a real zombie is reclaimed', async () => {
    await withZombie((z) => {
      const st = readFileSync(`/proc/${z}/stat`, 'utf-8')
      const rawTick = st.slice(st.lastIndexOf(')') + 2).split(' ')[19]
      writeFileSync(file, `${z} ${realPidLockDeps.bootId!()} ${rawTick}`)
      const d = { ...realPidLockDeps, argvOf: vi.fn((pid: number) => realPidLockDeps.argvOf(pid)) }
      expect(tryAcquirePidLock(file, SELF, d)).toMatchObject({ ok: true, reclaimed: z })
      expect(d.argvOf).toHaveBeenCalledWith(z)
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

  it('A3d new-format lock, unreadable tick, neither /proc nor ps can read argv: unknown (fail closed), lock untouched', () => {
    writeFileSync(file, `31337 ${BOOT} 999000`)
    const d = deps({ alive: true, argv: undefined, boot: BOOT, ticks: () => undefined, proc: () => undefined })
    expect(tryAcquirePidLock(file, SELF, d)).toEqual({ ok: false, holder: 31337, reason: 'unknown' })
    expect(d.procArgvOf).toHaveBeenCalledWith(31337)
    expect(d.argvOf).toHaveBeenCalledWith(31337)
    expect(readFileSync(file, 'utf-8').trim()).toBe(`31337 ${BOOT} 999000`)
  })
})
