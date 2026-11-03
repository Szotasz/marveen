import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The active rotated plan's config dir (configDir-mode plan under
// MAIN_AGENT_ISOLATED_CONFIG=1 with 2+ plans) is where the launcher points the
// main agent's CLAUDE_CONFIG_DIR. Without it among the dirs the deafness check
// scans, the hub's transcript is never read: the check would see no ingestion
// at all on a healthy hub and restart it. The root is added for the probe
// scan only; mainConfigRoots() feeds other readers and stays as it was.
const rotated = vi.hoisted(() => ({ dir: null as string | null, throws: false }))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    resolveMainAgentRotatedConfigDir: () => {
      if (rotated.throws) throw new Error('plans store unreadable')
      return rotated.dir
    },
  }
})

// startInboundProber may try to spawn the Python prober on a host that has
// its session file; never start a real process from a unit test.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => { throw new Error('spawn disabled in tests') }) }
})

import { mainConfigRoots, mainTranscriptDirs, probeTranscriptDirs, defaultProbeTickDeps, startInboundProber, runInboundProbeTick, INITIAL_PROBE_TICK_STATE, type ProbeLoopState } from '../web/inbound-probe.js'
import { logger } from '../logger.js'
import { projectsDirFor } from '../web/active-model.js'
import { PROJECT_ROOT } from '../config.js'

// Every shared module-level fake is reset before EVERY test, whatever block it
// is in, so no test depends on the order the runner picks: the resolver mock,
// spies, fake timers and the probe's own module-level tick state.
const INITIAL_LOOP_STATE: ProbeLoopState = { tick: INITIAL_PROBE_TICK_STATE, lastInboundRespawn: 0, warnedAmbiguous: false }
beforeEach(() => {
  rotated.dir = null
  rotated.throws = false
  vi.restoreAllMocks()
  vi.useRealTimers()
  defaultProbeTickDeps.saveState(INITIAL_LOOP_STATE)
})

describe('probeTranscriptDirs: active rotated plan dir', () => {
  let seen: Set<string>
  beforeEach(() => {
    seen = new Set()
  })

  it('includes the rotated plan transcript dir when a plan is active', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    expect(probeTranscriptDirs(seen)).toContain(projectsDirFor(PROJECT_ROOT, rotated.dir))
  })

  it('equals mainTranscriptDirs() when no rotated plan has been active', () => {
    expect(probeTranscriptDirs(seen)).toEqual(mainTranscriptDirs())
  })

  it('keeps the other dirs when the resolver throws', () => {
    rotated.throws = true
    expect(probeTranscriptDirs(seen)).toEqual(mainTranscriptDirs())
  })

  it('does not add a rotated dir that is one of the existing roots', () => {
    rotated.dir = join(PROJECT_ROOT, '.channels-config')
    const dirs = probeTranscriptDirs(seen)
    expect(dirs.filter(d => d === projectsDirFor(PROJECT_ROOT, rotated.dir as string)).length).toBe(1)
  })

  // The hub keeps writing to the dir it was launched into until it restarts,
  // even when the plan store stops resolving that dir (plan deleted, configDir
  // edited, isolation turned off, rotation restart failed).
  it('keeps scanning a rotated dir after the resolver stops returning it', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    const launched = projectsDirFor(PROJECT_ROOT, rotated.dir)
    probeTranscriptDirs(seen)
    rotated.dir = null
    expect(probeTranscriptDirs(seen)).toContain(launched)
  })

  it('keeps the previous rotated dir when the resolver moves to another one', () => {
    const first = join(tmpdir(), 'plan-config-dir-a')
    const second = join(tmpdir(), 'plan-config-dir-b')
    rotated.dir = first
    probeTranscriptDirs(seen)
    rotated.dir = second
    const dirs = probeTranscriptDirs(seen)
    expect(dirs).toContain(projectsDirFor(PROJECT_ROOT, first))
    expect(dirs).toContain(projectsDirFor(PROJECT_ROOT, second))
  })

  it('keeps a seen rotated dir while the resolver throws', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    probeTranscriptDirs(seen)
    rotated.throws = true
    expect(probeTranscriptDirs(seen)).toContain(projectsDirFor(PROJECT_ROOT, rotated.dir))
  })

  it('lists a dir seen many times only once', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    probeTranscriptDirs(seen)
    probeTranscriptDirs(seen)
    const dirs = probeTranscriptDirs(seen)
    expect(dirs.filter(d => d === projectsDirFor(PROJECT_ROOT, rotated.dir as string)).length).toBe(1)
    expect(dirs.length).toBe(mainTranscriptDirs().length + 1)
  })

  it('the deafness tick scans these dirs (production deps)', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-tick-deps')
    expect(defaultProbeTickDeps.transcriptDirs()).toContain(projectsDirFor(PROJECT_ROOT, rotated.dir))
    expect(defaultProbeTickDeps.transcriptDirs()).toEqual(expect.arrayContaining(mainTranscriptDirs()))
  })

  it('a tick records the rotated dir even without a session file or marker', async () => {
    const dir = join(tmpdir(), 'plan-config-dir-tick-no-session')
    rotated.dir = dir
    vi.spyOn(defaultProbeTickDeps, 'sessionExists').mockReturnValue(false)
    await runInboundProbeTick(180_000, defaultProbeTickDeps)
    rotated.dir = null
    expect(probeTranscriptDirs()).toContain(projectsDirFor(PROJECT_ROOT, dir))
  })

  it('remembers across calls by default (module-level record)', () => {
    const dir = join(tmpdir(), 'plan-config-dir-default-seen')
    rotated.dir = dir
    probeTranscriptDirs()
    rotated.dir = null
    expect(probeTranscriptDirs()).toContain(projectsDirFor(PROJECT_ROOT, dir))
  })
})

// Scope pin: mainConfigRoots() and mainTranscriptDirs() are shared by token
// usage, the context guard and the schedule runner. Changing them changes
// those readers, which is not this fix. The rotated root lives only in
// probeTranscriptDirs().
describe('mainConfigRoots stays as on the base branch', () => {
  it('does not include an active rotated plan dir', () => {
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    expect(mainConfigRoots()).not.toContain(rotated.dir)
    expect(mainTranscriptDirs()).not.toContain(projectsDirFor(PROJECT_ROOT, rotated.dir))
  })

  it('source: mainConfigRoots and mainTranscriptDirs do not consult the rotation resolver', () => {
    const src = readFileSync(join(__dirname, '../web/inbound-probe.ts'), 'utf-8')
    // Comments stripped, so a call left behind as a comment does not count.
    const body = (name: string): string => {
      const start = src.indexOf(`export function ${name}(`)
      return src.slice(start, src.indexOf('\n}\n', start))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1')
    }
    expect(body('mainConfigRoots')).not.toContain('resolveMainAgentRotatedConfigDir')
    expect(body('mainTranscriptDirs')).not.toContain('resolveMainAgentRotatedConfigDir')
    expect(body('probeTranscriptDirs')).toMatch(/^\s*const rotated = resolveMainAgentRotatedConfigDir\(\)\s*$/m)
    expect(body('probeTranscriptDirs')).toMatch(/^\s*if \(rotated\) seen\.add\(projectsDirFor\(PROJECT_ROOT, rotated\)\)\s*$/m)
    expect(body('probeTranscriptDirs')).toMatch(/^\s*dirs\.push\(\.\.\.seen\)\s*$/m)
  })

  it('returns the same roots whether or not a rotated plan is active', () => {
    const without = mainConfigRoots()
    rotated.dir = join(tmpdir(), 'plan-config-dir-test')
    expect(mainConfigRoots()).toEqual(without)
  })
})

// startInboundProber records the active rotated plan dir when it starts, so a
// plan-store change before the first tick cannot hide the dir the hub was
// launched into, and runs the deafness tick on every interval.
describe('startInboundProber', () => {
  // Drop this test's fake timers; every other reset is the file-level hook's.
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('records the rotated plan dir at start and ticks once per interval', () => {
    vi.useFakeTimers()
    const info = vi.spyOn(logger, 'info')
    const tick = vi.spyOn(defaultProbeTickDeps, 'sessionExists').mockReturnValue(false)
    rotated.dir = join(tmpdir(), 'plan-config-dir-at-start')
    startInboundProber()
    const started = info.mock.calls.find(c => (c[1] as unknown) === 'Inbound prober started')
    const interval = (started?.[0] as { probeIntervalMs: number }).probeIntervalMs
    expect(interval).toBeGreaterThan(0)

    // The plan store stops resolving the dir before the first tick.
    rotated.dir = null
    expect(probeTranscriptDirs()).toContain(projectsDirFor(PROJECT_ROOT, join(tmpdir(), 'plan-config-dir-at-start')))
    expect(tick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(interval - 1)
    expect(tick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(interval * 2)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('the timer tick uses the configured interval for the 2x threshold', async () => {
    vi.useFakeTimers()
    const info = vi.spyOn(logger, 'info')
    const P = Date.parse('2026-10-01T00:00:00.000Z')
    let now = 0
    const restart = vi.fn(() => ({ ok: true }))
    vi.spyOn(defaultProbeTickDeps, 'sessionExists').mockReturnValue(true)
    vi.spyOn(defaultProbeTickDeps, 'readMarker').mockReturnValue(P)
    vi.spyOn(defaultProbeTickDeps, 'now').mockImplementation(() => now)
    vi.spyOn(defaultProbeTickDeps, 'scan').mockReturnValue({ lastTs: P - 5000, lastProbeTs: P - 5000 })
    vi.spyOn(defaultProbeTickDeps, 'countWriters').mockReturnValue(1)
    let state: ProbeLoopState = { tick: { ...INITIAL_PROBE_TICK_STATE, pendingSince: P, probeHeard: true }, lastInboundRespawn: 0, warnedAmbiguous: false }
    vi.spyOn(defaultProbeTickDeps, 'loadState').mockImplementation(() => state)
    vi.spyOn(defaultProbeTickDeps, 'saveState').mockImplementation((x) => { state = x })
    vi.spyOn(defaultProbeTickDeps, 'respawnSide').mockResolvedValue({ lastCrossPathRespawnAt: () => 0, paneState: () => 'idle', restart })
    startInboundProber()
    const started = info.mock.calls.find(c => (c[1] as unknown) === 'Inbound prober started')
    const interval = (started?.[0] as { probeIntervalMs: number }).probeIntervalMs

    now = P + 2 * interval - 1
    await vi.advanceTimersByTimeAsync(interval)
    expect(restart).not.toHaveBeenCalled()
    now = P + 2 * interval
    await vi.advanceTimersByTimeAsync(interval)
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
