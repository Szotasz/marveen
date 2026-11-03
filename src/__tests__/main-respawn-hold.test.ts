import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1954 (part A): the scheduler must not fire into the main session while it is
// being respawned in-process. Measured on our host, 2026-10-11:
//   16:40:02.995  stuck-tool-call-watcher: recovering main channels session
//   16:40:04.545  Scheduled task fired
//   16:40:07.720  Marveen session respawned with --continue
//   16:40:31.978  Scheduled prompt did NOT arrive as typed (head-lost)
// The respawn paths stamp lastMainRespawnAt() only at the END, so the fix marks
// the START (main-respawn-hold.ts). What is pinned here:
//   1. the mark's own expiry and settle, and that it is cleared on every exit;
//   2. the real resumeMarveenSession holds from its first line, through the
//      awaits where the 16:40:04 fire happened -- a mark set at the end fails;
//   3. the wiring of all three in-process respawn functions.
// Everything that could reach the live host is stubbed: tmux (child_process),
// the reapers, the onboarding re-seed and the settings writer.

const execCalls: string[][] = []
let execHook: (args: string[]) => void = () => {}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: vi.fn((_cmd: string, args: string[] = []) => {
      execCalls.push(args)
      execHook(args)
      return ''
    }),
    // `which <bin>` (module-level resolveFromPath) is the only command that
    // reaches the real shell: a lookup, never an action.
    execSync: vi.fn((cmd: string, opts?: unknown) => /^which [a-z-]+$/.test(cmd) ? real.execSync(cmd, opts as never) : ''),
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null })),
    execFile: vi.fn(() => { throw new Error('execFile is not allowed in this test') }),
    exec: vi.fn(() => { throw new Error('exec is not allowed in this test') }),
    spawn: vi.fn(() => { throw new Error('spawn is not allowed in this test') }),
  }
})

// The binaries resolve to fixed fake paths: nothing here may look up or run a
// real tmux or claude (the respawn-pane call itself goes to the stub above).
vi.mock('../platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../platform.js')>()
  return { ...real, makeLazyBinResolver: (name: string) => () => `/nonexistent/fake-${name}` }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/channel-poller-reap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/channel-poller-reap.js')>()
  return {
    ...real,
    reapChannelOrphans: vi.fn(() => ({ reaped: [], skippedLivePane: [], skippedOtherUid: [], skippedNotPlugin: [], source: { fromBotPid: null, fromEnvScan: [] } })),
    reapDetachedChannelClaudes: vi.fn(() => []),
  }
})

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...real,
    ensureSharedClaudeOnboarded: vi.fn(),
    scheduleIdentitySetup: vi.fn(async () => {}),
    dismissResumeSummaryModalIfPresent: vi.fn(async () => {}),
  }
})

vi.mock('../web/channel-plugin-unlock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/channel-plugin-unlock.js')>()
  return { ...real, schedulePluginUnlockAfterRespawn: vi.fn() }
})

vi.mock('../web/main-extra-plugins-settings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/main-extra-plugins-settings.js')>()
  return { ...real, writeMainExtraPluginsSettings: vi.fn(() => null) }
})

import {
  decideMainRespawnHold,
  beginMainRespawn,
  mainRespawnHold,
  MAIN_RESPAWN_MAX_INFLIGHT_MS,
  MAIN_RESPAWN_SETTLE_MS,
  _resetMainRespawnHoldForTest,
} from '../web/main-respawn-hold.js'

const T0 = Date.UTC(2026, 9, 11, 14, 40, 2, 995)

describe('decideMainRespawnHold: the mark expires on its own', () => {
  it('in flight from the start, for at most MAIN_RESPAWN_MAX_INFLIGHT_MS', () => {
    const s = { inFlightSince: T0, endedAt: 0 }
    expect(decideMainRespawnHold(s, T0)).toBe('in-flight')
    expect(decideMainRespawnHold(s, T0 + 1_550)).toBe('in-flight') // the 16:40:04.545 fire
    expect(decideMainRespawnHold(s, T0 + MAIN_RESPAWN_MAX_INFLIGHT_MS - 1)).toBe('in-flight')
    // An end that never came does not hold the schedule forever.
    expect(decideMainRespawnHold(s, T0 + MAIN_RESPAWN_MAX_INFLIGHT_MS)).toBeNull()
  })

  it('settling for MAIN_RESPAWN_SETTLE_MS after the end, then free', () => {
    const end = T0 + 4_725
    const s = { inFlightSince: 0, endedAt: end }
    expect(decideMainRespawnHold(s, end + 14_055)).toBe('settling') // the 16:40:21.8 /rename
    expect(decideMainRespawnHold(s, end + MAIN_RESPAWN_SETTLE_MS - 1)).toBe('settling')
    expect(decideMainRespawnHold(s, end + MAIN_RESPAWN_SETTLE_MS)).toBeNull()
  })

  it('no respawn ever: no hold', () => {
    expect(decideMainRespawnHold({ inFlightSince: 0, endedAt: 0 }, T0)).toBeNull()
  })
})

describe('beginMainRespawn: the end function', () => {
  beforeEach(() => _resetMainRespawnHoldForTest())

  it('clears the in-flight mark and starts the settle', () => {
    let clock = T0
    const end = beginMainRespawn(() => clock)
    expect(mainRespawnHold(clock)).toBe('in-flight')
    clock += 5_000
    end()
    expect(mainRespawnHold(clock)).toBe('settling')
    expect(mainRespawnHold(clock + MAIN_RESPAWN_SETTLE_MS)).toBeNull()
  })

  it('is idempotent, and an earlier respawn ending cannot clear a later one', () => {
    let clock = T0
    const endFirst = beginMainRespawn(() => clock)
    clock += 1_000
    const endSecond = beginMainRespawn(() => clock)
    clock += 1_000
    endFirst()
    endFirst()
    expect(mainRespawnHold(clock)).toBe('in-flight')
    endSecond()
    expect(mainRespawnHold(clock)).toBe('settling')
  })
})

describe('the real resumeMarveenSession holds from its first line to its last', () => {
  beforeEach(() => {
    _resetMainRespawnHoldForTest()
    execCalls.length = 0
    execHook = () => {}
    vi.useFakeTimers({ now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the 16:40 order: a fire 1.5 s into the recovery meets an in-flight hold, and the end starts the settle', async () => {
    const { resumeMarveenSession } = await import('../web/channel-monitor.js')
    const atRespawnPane: Array<string | null> = []
    execHook = (args) => { if (args.includes('respawn-pane')) atRespawnPane.push(mainRespawnHold(Date.now())) }

    const done = resumeMarveenSession()
    // The respawn-pane already ran (it is synchronous); the function now sits in
    // its post-respawn modal waits -- the window the 16:40:04.545 fire landed in.
    expect(atRespawnPane).toEqual(['in-flight'])
    await vi.advanceTimersByTimeAsync(1_550)
    expect(mainRespawnHold(Date.now())).toBe('in-flight')

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(done).resolves.toBe(true)
    expect(mainRespawnHold(Date.now())).toBe('settling')
    await vi.advanceTimersByTimeAsync(MAIN_RESPAWN_SETTLE_MS)
    expect(mainRespawnHold(Date.now())).toBeNull()
  })

  it('a respawn-pane that throws still clears the mark (finally), so the schedule is not held for a minute', async () => {
    const { resumeMarveenSession } = await import('../web/channel-monitor.js')
    execHook = (args) => { if (args.includes('respawn-pane')) throw new Error("can't find pane") }

    await expect(resumeMarveenSession()).resolves.toBe(false)
    expect(mainRespawnHold(Date.now())).toBe('settling')
  })

  it('respawnMainSessionFresh (synchronous) leaves a settle behind, also when it throws', async () => {
    const { respawnMainSessionFresh } = await import('../web/channel-monitor.js')
    execHook = (args) => {
      // mainChannelsSessionExists() asks tmux has-session; '' (no throw) = exists.
      if (args.includes('respawn-pane')) expect(mainRespawnHold(Date.now())).toBe('in-flight')
    }
    respawnMainSessionFresh()
    expect(mainRespawnHold(Date.now())).toBe('settling')

    _resetMainRespawnHoldForTest()
    execHook = (args) => { if (args.includes('respawn-pane')) throw new Error('tmux died') }
    expect(() => respawnMainSessionFresh()).toThrow('tmux died')
    expect(mainRespawnHold(Date.now())).toBe('settling')
  })
})

describe('wiring: every in-process respawn of the main session is marked', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  const body = (header: string): string => {
    const start = src.indexOf(header)
    expect(start, `${header} not found`).toBeGreaterThan(0)
    const end = src.indexOf('\n}\n', start)
    return src.slice(start, end + 2)
  }

  it.each([
    'export async function resumeMarveenSession',
    'function respawnMarveenSessionFresh',
    'export function respawnMainSessionFresh',
  ])('%s: begin before the first reap or respawn-pane, end in a finally that closes the function', (header) => {
    const fn = body(header)
    const beginAt = fn.indexOf('const endRespawn = beginMainRespawn()')
    expect(beginAt, 'beginMainRespawn() missing').toBeGreaterThan(0)
    const firstWork = Math.min(
      ...['reapChannelOrphans(', 'ensureSharedClaudeOnboarded()', "'respawn-pane'"]
        .map((m) => fn.indexOf(m))
        .filter((i) => i >= 0),
    )
    expect(beginAt).toBeLessThan(firstWork)
    expect(fn.trimEnd()).toMatch(/\} finally \{\n\s+endRespawn\(\)\n\s+\}\n\}$/)
  })
})
