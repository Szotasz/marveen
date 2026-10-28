// A context-guard restart must not silently destroy the agent's in-flight
// heavy-job gate job (scripts/heavy-job-gate.sh). Measured on a production
// install: a restart stopped a gated test run with 143 after 2182 s, no result.
//
// BEHAVIOUR tests through the real runner and the real state machine. Mocked:
// process/tmux/DB edges, the pane classifier (so busy/idle/saturated are set
// per sweep), the job probe and process liveness. "Killing" is simulated by
// the restart mock removing pids from the live set.
//
// The invariant under test (heavy-job-hold.ts): a hold EPISODE is one
// unbroken run of restarting sweeps for one agent (busy turns inside the same
// restart sequence included); within it the total hold is at most the cap,
// whatever jobs come and go; anything else closes it, and a new episode
// starts fresh. What the restart did to each job comes from liveness before
// and after the restart call, and a stopped job is reported where that
// becomes known (a failed restart reports it at once).

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(homedir(), '.cgheavy2-test-'))
const STORE = join(ROOT, 'store')
const PENDING = join(STORE, 'context-guard-pending-resume.json')
const CONFIG = join(STORE, 'context-guard.json')
const HOLDS = join(STORE, 'context-guard-heavy-holds.json')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))

type Job = { pid: number; label: string; state: 'running' | 'queued'; start: string }
const h = vi.hoisted(() => ({
  paneState: 'idle' as 'idle' | 'busy',
  saturated: false,
  tokens: null as number | null,
  panes: [4242] as number[] | null,
  jobs: [] as Job[],
  alive: new Set<number>(),
  killOnRestart: true,
  /** gates exit this many ms AFTER the restart call returned (0 = at once) */
  exitDelayMs: 0,
  notifyOk: true as boolean | undefined,
  mainRunning: false,
  runState: 'running' as 'running' | 'stopped',
  notifyChannel: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<boolean | undefined>>,
  startOk: true,
  sendSystemDirective: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<string>>,
  restartAgentProcess: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>,
  createAgentMessage: null as unknown as import('vitest').Mock<(...a: unknown[]) => { id: number }>,
  log: { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => { h.log.info.push(a) },
    warn: (...a: unknown[]) => { h.log.warn.push(a) },
    error: (...a: unknown[]) => { h.log.error.push(a) },
    debug: () => {},
  },
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: () => h.paneState,
  paneShowsContextSaturation: () => h.saturated,
  paneShowsContextSaturationHardError: () => h.saturated,
  // upstream IDLEFLUSHVETO812: the runner asks whether the pane runs background work
  hasBackgroundWork: () => false,
}))

vi.mock('../web/agent-process.js', async () => {
  const { vi } = await import('vitest')
  h.restartAgentProcess = vi.fn(async () => {
    // the stop half: the agent's tree dies with the pane
    if (h.killOnRestart) {
      if (h.exitDelayMs > 0) {
        const doomed = [...h.alive]
        setTimeout(() => { for (const p of doomed) h.alive.delete(p); h.jobs = [] }, h.exitDelayMs)
      } else { h.alive.clear(); h.jobs = [] }
    }
    return h.startOk ? { ok: true } : { ok: false, error: 'lost the start race' }
  })
  return {
    agentRunState: () => h.runState,
    agentSessionName: (n: string) => `agent-${n}`,
    restartAgentProcess: (...a: unknown[]) => h.restartAgentProcess(...a),
    capturePane: (session: string) => (session.startsWith('agent-') || h.mainRunning ? 'pane' : null),
    isSessionReadyForPrompt: async () => true,
    noteSaturationBannerUntrusted: () => {},
    clearSaturationBannerOverride: () => {},
    tmuxInvocationFor: (args: string[]) => ({ file: 'tmux', args }),
  }
})

vi.mock('../web/heavy-job-owner.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sessionPanePids: () => h.panes,
  agentHeavyJobs: () => h.jobs.filter((j) => h.alive.has(j.pid)),
  gateAlive: (pid: number) => h.alive.has(pid),
}))

vi.mock('../web/system-directive.js', async () => {
  const { vi } = await import('vitest')
  h.sendSystemDirective = vi.fn(async () => 'sent')
  return { sendSystemDirective: (...a: unknown[]) => h.sendSystemDirective(...a) }
})
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => ({ ok: true }),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
  markAgentRestartPending: () => {},
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['boni'],
  listAllAgentNames: () => ['boni'],
  agentDir: (n: string) => join(ROOT, 'agents', n),
  readAgentModel: () => null,
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => h.tokens,
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => null,
  readTranscriptTailFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', async () => {
  const { vi } = await import('vitest')
  h.notifyChannel = vi.fn(async () => h.notifyOk)
  return { notifyChannel: (...a: unknown[]) => h.notifyChannel(...a) }
})
vi.mock('../db.js', async () => {
  const { vi } = await import('vitest')
  h.createAgentMessage = vi.fn(() => ({ id: 1 }))
  return { createAgentMessage: (...a: unknown[]) => h.createAgentMessage(...a) }
})

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000
const T0 = 1_790_000_000_000

let timers: NodeJS.Timeout[] = []

async function boot() {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  timers.push(runner.startContextGuardRunner())
  return runner
}
// The runner sweeps at boot+270 s (setTimeout) AND on its own 300 s interval
// (boot+300, +600, ...). Tests therefore move the clock to absolute seconds.
const at = (sec: number) => vi.advanceTimersByTimeAsync(T0 + sec * 1000 - Date.now())
const mins = (fromSec: number, toSec: number) => Math.round((toSec - fromSec) / 60)

/** Hard-threshold tier: restart decided on every idle sweep, deferred while busy. */
function hardTier(cap: number): void {
  writeFileSync(CONFIG, JSON.stringify({ boni: { enabled: true, limitTokens: 100_000, heavyJobDeferMaxMinutes: cap } }))
  h.tokens = 99_000
}
function job(pid: number, label: string, state: 'running' | 'queued' = 'running'): Job {
  h.alive.add(pid)
  const j = { pid, label, state, start: String(pid * 10) }
  h.jobs.push(j)
  return j
}
function pending(): Record<string, { heavyJobs?: unknown }> {
  return existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf-8')) : {}
}
const restarts = () => h.restartAgentProcess.mock.calls.length
const alerts = () => h.createAgentMessage.mock.calls.filter((c) => String(c[2]).includes('LEALLITJA'))
/** The "a restart STOPPED these jobs" reports to the main agent. */
const stopReports = () => h.createAgentMessage.mock.calls.filter((c) => String(c[3]) === 'context-guard heavy-job stopped report')
const resumeTexts = () => h.sendSystemDirective.mock.calls.map((c) => String(c[2])).filter((t) => t.includes('Friss kontextussal indultál'))

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.paneState = 'idle'
  h.saturated = false
  h.tokens = null
  h.panes = [4242]
  h.jobs = []
  h.alive = new Set()
  h.killOnRestart = true
  h.exitDelayMs = 0
  h.notifyOk = true
  h.startOk = true
  h.runState = 'running'
  h.log = { info: [], warn: [], error: [] }
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
  h.sendSystemDirective?.mockClear()
  h.restartAgentProcess?.mockClear()
  h.createAgentMessage?.mockClear()
  h.notifyChannel?.mockClear()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('heavy-job gate restart hold', () => {
  it('no job: restarts at once, as before, and nothing is said about jobs', async () => {
    hardTier(45)
    await boot()
    await at(270)
    expect(restarts()).toBe(1)
    expect(pending().boni.heavyJobs).toBeUndefined()
    expect(alerts()).toHaveLength(0)
    await at(600)
    expect(resumeTexts()[0]).not.toContain('NEHÉZ FELADAT')
  })

  it('hard-threshold path: busy/idle sweeps do NOT restart the clock; the restart comes at the ORIGINAL bound with one alert', async () => {
    hardTier(20)
    job(5001, 'agent-tests')
    await boot()
    await at(270)                                   // first sighting, held
    // sweeps at 300 busy, 600 idle (5.5 min), 900 busy, 1200 idle (15.5), 1500 busy
    for (const [t, busy] of [[300, true], [600, false], [900, true], [1200, false], [1500, true]] as const) {
      h.paneState = busy ? 'busy' : 'idle'
      await at(t)
    }
    expect(restarts()).toBe(0)
    h.paneState = 'idle'
    await at(1800)                                  // 25.5 min since the FIRST sighting >= 20
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(1)
    expect(String(alerts()[0]![2])).toContain('agent-tests')
    // held 25.5 min by the sweep clock; reported as the hold window, capped at the cap (20)
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: 20, ended: [], killed: [{ label: 'agent-tests', state: 'running' }] })
    await at(2100)
    expect(resumeTexts()[0]).toContain('LEÁLLÍTOTTA')
    expect(resumeTexts()[0]).toContain('agent-tests')
    // the upstream gate's log, where the exit code of the stopped job is
    expect(resumeTexts()[0]).toContain('store/heavy-job-log.jsonl')
    expect(resumeTexts()[0]).not.toContain('nehez-feladat')
  })

  it('queued job: held the same way', async () => {
    hardTier(45)
    job(5002, 'agent-build', 'queued')
    await boot()
    await at(600)
    expect(restarts()).toBe(0)
  })

  it('job ends during the hold: restart on the next sweep, reported as ended (not killed), no alert', async () => {
    hardTier(45)
    job(5001, 'a11y-check')
    await boot()
    await at(600)
    expect(restarts()).toBe(0)
    h.alive.delete(5001)                             // it finished on its own
    await at(900)
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(0)
    // heldMinutes belongs to stopped jobs; none was stopped
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: 0, ended: ['a11y-check'], killed: [] })
  })

  it('the first sighting survives a dashboard restart (persisted)', async () => {
    hardTier(20)
    job(5001, 'x')
    await boot()
    await at(310)                                   // first sighting at 270, held at 300
    for (const t of timers) clearInterval(t)
    timers = []
    await boot()                                    // new process at 310: sweeps 580, 610, 910, 1210, 1510
    await at(1210)
    expect(restarts()).toBe(0)                      // 15.7 min since the first sighting
    await at(1510)                                  // 20.7 >= 20, counted from the ORIGINAL sighting
    expect(restarts()).toBe(1)
    expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})   // the restart closed the episode
  })

  it('failed restart (stop ran, start failed): the killed job is kept and reported by the retry; still one alert', async () => {
    hardTier(10)
    job(5001, 'video-render')
    await boot()
    await at(600)                                   // held (5.5 min)
    h.startOk = false
    await at(900)                                   // 10.5: bound, alert, restart FAILS after the stop
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(1)
    expect(pending().boni).toBeUndefined()
    h.startOk = true
    await at(1200)                                  // retry: nothing live any more
    expect(restarts()).toBe(2)
    expect(alerts()).toHaveLength(1)
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: 10, ended: [], killed: [{ label: 'video-render', state: 'running' }] })
    const notice = h.createAgentMessage.mock.calls.filter((c) => String(c[2]).includes('Ujrainditottam')).pop()
    expect(String(notice?.[2])).toContain('LEALLITOTTA: "video-render"')
    expect(String(notice?.[2])).not.toContain('veget ert')
    expect(stopReports()).toHaveLength(1)           // and the main agent was told at the failure itself
  })

  it('failed restart, then the agent is NOT RUNNING: the stopped job is reported at the failure, before the episode closes', async () => {
    hardTier(10)
    job(5001, 'video-render')
    await boot()
    await at(600)                                   // held
    h.startOk = false
    h.restartAgentProcess.mockImplementationOnce(async () => {
      h.alive.clear(); h.jobs = []; h.runState = 'stopped'   // the stop ran, the start did not
      return { ok: false, error: 'start failed' }
    })
    await at(900)
    expect(restarts()).toBe(1)
    expect(stopReports()).toHaveLength(1)
    expect(String(stopReports()[0]![2])).toContain('"video-render"')
    expect(h.log.error.some((a) => a.includes('context-guard: a restart of this agent STOPPED its heavy-job gate job(s)'))).toBe(true)
    await at(1200)                                  // "not running": the sweep closes the episode
    expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})
    expect(stopReports()).toHaveLength(1)           // reported once, not again on close
  })

  it('failed restart (lost the start race), then a NEW session: the stopped job was reported, the new episode starts clean', async () => {
    hardTier(10)
    job(5001, 'video-render')
    await boot()
    await at(600)
    h.restartAgentProcess.mockImplementationOnce(async () => {
      h.alive.clear(); h.jobs = []; h.panes = [7777]          // another supervisor started a new session
      return { ok: false, error: 'lost the start race' }
    })
    await at(900)
    expect(stopReports()).toHaveLength(1)
    expect(String(stopReports()[0]![2])).toContain('"video-render"')
    await at(1200)                                  // restart decision on the new panes: replaced, fresh episode
    expect(stopReports()).toHaveLength(1)
  })

  it('the first report fails: the episode reports the stopped job when it is closed', async () => {
    hardTier(10)
    job(5001, 'video-render')
    await boot()
    await at(600)
    h.restartAgentProcess.mockImplementationOnce(async () => {
      h.alive.clear(); h.jobs = []; h.runState = 'stopped'
      return { ok: false, error: 'start failed' }
    })
    let failOnce = true
    h.createAgentMessage.mockImplementation((...a: unknown[]) => {
      if (failOnce && String(a[3]) === 'context-guard heavy-job stopped report') { failOnce = false; return undefined as unknown as { id: number } }
      return { id: 1 }
    })
    try {
      await at(900)
      expect(h.log.error.some((a) => a.includes('context-guard: FAILED TO REPORT the stopped heavy-job gate job(s)'))).toBe(true)
      await at(1200)                                // not running: the closing sweep reports it
      expect(stopReports()).toHaveLength(2)         // the failed attempt + the one that went out
      expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})
    } finally {
      h.createAgentMessage.mockImplementation(() => ({ id: 1 }))
    }
  })

  it('a gate that takes seconds to exit after the restart call is still reported as killed', async () => {
    hardTier(10)
    job(5001, 'slow-teardown')
    h.exitDelayMs = 18_000                          // forward SIGTERM, wait, scope teardown
    await boot()
    await at(920)                                   // bound at 900: restart, the gate exits at 918 (before the resume goes out)
    expect(restarts()).toBe(1)
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: 10, ended: [], killed: [{ label: 'slow-teardown', state: 'running' }] })
  })

  it('a job that survives the restart is not reported, and the restart closes the episode', async () => {
    hardTier(10)
    job(5001, 'nohup-job')
    h.killOnRestart = false
    await boot()
    await at(931)                                   // bound at 900: restart; alive after the 30 s exit wait
    expect(restarts()).toBe(1)
    expect(pending().boni?.heavyJobs).toBeUndefined()
    expect(resumeTexts().join(' ')).not.toContain('NEHÉZ FELADAT')
    expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})
  })

  it('a job that survives is held again only in a NEW restart need, bounded by the cap again, alerted once per need', async () => {
    hardTier(10)
    job(5001, 'long-job')
    h.killOnRestart = false
    await boot()
    await at(900)                                   // bound -> restart 1, job survives; cooldown follows
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(1)
    // resume at 1200, cooldown to 2100: the next restart need opens a new episode at 2400
    await at(2400 + 9 * 60)
    expect(restarts()).toBe(1)                      // held inside the new episode
    await at(2400 + 10 * 60)
    expect(restarts()).toBe(2)                      // released at its cap
    expect(alerts()).toHaveLength(2)
  })

  it('heavyJobDeferMaxMinutes 0: never holds; still one alert and the fact-based report', async () => {
    hardTier(0)
    job(5001, 'x')
    await boot()
    await at(270)
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(1)
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: 0, ended: [], killed: [{ label: 'x', state: 'running' }] })
  })

  it('ownership unmeasurable after a hold began: no hold, but the recorded job is alerted and reported from facts', async () => {
    hardTier(45)
    job(5001, 'x')
    await boot()
    await at(300)                                   // held, recorded
    h.panes = null
    await at(600)
    expect(restarts()).toBe(1)
    expect(alerts()).toHaveLength(1)
    expect(pending().boni.heavyJobs).toEqual({ heldMinutes: mins(270, 600), ended: [], killed: [{ label: 'x', state: 'running' }] })
  })

  it('saturation-net path holds the same way', async () => {
    writeFileSync(CONFIG, JSON.stringify({ boni: { saturationRestart: true, heavyJobDeferMaxMinutes: 45 } }))
    h.saturated = true
    job(5001, 'x')
    await boot()
    await at(900)                                   // the net decides at 300, then every sweep: held
    expect(restarts()).toBe(0)
  })
})

describe('stale hold records (no restart decision follows)', () => {
  it('a job held, then no longer a restart case, then ended: its record is pruned, and a much later restart reports nothing about it', async () => {
    hardTier(45)
    job(5001, 'old-job')
    await boot()
    await at(270)                                   // held, recorded
    expect(restarts()).toBe(0)
    expect(Object.keys(JSON.parse(readFileSync(HOLDS, 'utf-8')).boni.jobs)).toHaveLength(1)
    h.tokens = 10_000                               // the context dropped: no restart decision any more
    await at(600)                                   // that sweep closes the episode
    expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})
    h.alive.delete(5001)                            // the job ends while nothing wants a restart
    await at(900)
    h.tokens = 99_000                               // a later, unrelated restart
    await at(1200)
    expect(restarts()).toBe(1)
    expect(pending().boni.heavyJobs).toBeUndefined()
    expect(h.createAgentMessage.mock.calls.some((c) => String(c[2]).includes('old-job'))).toBe(false)
  })

  it('the restart need dissolved, then a NEW need with a fresh gated job: held again with a full bound', async () => {
    hardTier(10)
    job(5001, 'first')
    await boot()
    await at(900)                                   // 270 .. 900 held, released at the cap: restart 1 (kills it)
    expect(restarts()).toBe(1)
    // the next need comes after the cooldown; a NEW job runs then
    job(5002, 'fresh')
    await at(2400 + 9 * 60)
    expect(restarts()).toBe(1)                      // held: a fresh episode, not the old one's leftovers
    await at(2400 + 10 * 60)
    expect(restarts()).toBe(2)
  })

  it('held, then the context drops (no restart need), then a new need: a fresh episode, not a spent one', async () => {
    hardTier(10)
    job(5001, 'job-a')
    await boot()
    await at(600)                                   // held 270 .. 600 (5.5 min)
    h.tokens = 10_000
    await at(1500)                                  // need gone for 15 min: the episode is closed
    h.tokens = 99_000
    await at(1800)                                  // new need, same live job: held again (old code: spent window)
    expect(restarts()).toBe(0)
    await at(1800 + 10 * 60)
    expect(restarts()).toBe(1)
  })

  it('guard disabled mid-episode, then re-enabled: a new episode', async () => {
    hardTier(10)
    job(5001, 'job-a')
    await boot()
    await at(600)                                   // held 270 .. 600
    writeFileSync(CONFIG, JSON.stringify({ boni: { enabled: false, heavyJobDeferMaxMinutes: 10 } }))
    await at(900)                                   // the guard returns early for a disabled agent; the sweep closes the episode
    expect(JSON.parse(readFileSync(HOLDS, 'utf-8'))).toEqual({})
    hardTier(10)
    await at(1200)                                  // re-enabled: a new episode starts here
    expect(restarts()).toBe(0)
    await at(1200 + 10 * 60)
    expect(restarts()).toBe(1)
  })

  it('a stale record that no sweep pruned (written by an older build, last seen days ago) is not reported as ended', async () => {
    writeFileSync(HOLDS, JSON.stringify({ boni: { '5001:50010:old-job': {
      pid: 5001, start: '50010', label: 'old-job', state: 'running', firstSeenMs: T0 - 2 * 3600_000, alerted: false,
    } } }))
    hardTier(45)
    await boot()
    await at(270)                                   // first sweep decides a restart at once
    expect(restarts()).toBe(1)
    expect(pending().boni.heavyJobs).toBeUndefined()
  })
})

describe('the agent\'s total hold is at most the cap, however jobs come and go', () => {
  const firstRestartAt = async (untilSec: number, step?: (t: number) => void): Promise<number | null> => {
    for (let t = 300; t <= untilSec; t += 300) {
      step?.(t)
      await at(t)
      if (restarts() > 0) return t
    }
    return null
  }

  it('cap 1440 and a job living 48 h: the restart comes at the cap (+1 sweep), with one alert', async () => {
    hardTier(1440)
    job(5001, 'hung-job')
    await boot()
    await at(270)                                   // first sighting, held
    const released = await firstRestartAt(48 * 3600)
    expect(released).not.toBeNull()
    expect(released! - 270).toBeLessThanOrEqual(1440 * 60 + 300)
    expect(alerts()).toHaveLength(1)
  }, 60_000)

  it('a stream of new gated jobs every 10 min (busy/idle alternating) does not hold past the cap', async () => {
    hardTier(45)
    let n = 0
    job(6000 + n++, 'stream-0')
    await boot()
    await at(270)                                   // first held decision
    const released = await firstRestartAt(4 * 3600, (t) => {
      if (t % 600 === 0) {
        job(6000 + n, `stream-${n}`); n++
        for (const j of h.jobs) if (j.pid < 6000 + n - 2) h.alive.delete(j.pid)   // two live at a time
      }
      h.paneState = (t / 300) % 2 === 0 ? 'busy' : 'idle'
    })
    expect(released).not.toBeNull()
    expect(released! - 270).toBeLessThanOrEqual(45 * 60 + 600)   // + the busy sweep before the next idle one
  }, 60_000)

  it('cap 45 and a job living past 24 h (it survives every restart): every restart need is held at most the cap', async () => {
    hardTier(45)
    job(5001, 'long-lived')
    h.killOnRestart = false                         // it survives every restart
    await boot()
    await at(270)
    const restartTimes: number[] = []
    const episodeStart = (): number | null => {
      const ep = JSON.parse(readFileSync(HOLDS, 'utf-8')).boni
      return ep ? (ep.startMs - T0) / 1000 : null
    }
    let openSince: number | null = episodeStart()
    let longest = 0
    for (let t = 300; t <= 30 * 3600; t += 300) {
      const before = restarts()
      await at(t)
      if (restarts() > before) {
        restartTimes.push(t)
        if (openSince !== null) longest = Math.max(longest, t - openSince)
      }
      openSince = episodeStart()
    }
    expect(restartTimes.length).toBeGreaterThan(10)   // restarts keep coming; nothing parks the agent
    expect(longest).toBeLessThanOrEqual(45 * 60 + 300)
    expect(alerts().length).toBe(restartTimes.length) // one alert per restart need
  }, 120_000)
})

describe('unreadable /proc is never "no job" or "killed"', () => {
  it('a liveness read error counts as alive: the recorded job is not reported as killed', async () => {
    hardTier(0)                                     // restart at once, the job is at risk
    job(5001, 'hidden')
    const realHas = h.alive.has.bind(h.alive)
    let failReads = false
    h.alive.has = ((pid: number) => {
      if (failReads) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return realHas(pid)
    }) as typeof h.alive.has
    h.restartAgentProcess.mockImplementationOnce(async () => { failReads = true; h.alive.clear(); h.jobs = []; return { ok: true } })
    await boot()
    await at(310)                                   // restart at 270, then the bounded 30 s exit wait
    expect(restarts()).toBe(1)
    expect(h.log.warn.some((a) => a.some((x) => typeof x === 'string' && x.includes('liveness unreadable')))).toBe(true)
    const notice = h.createAgentMessage.mock.calls.filter((c) => String(c[2]).includes('Ujrainditottam')).pop()
    expect(String(notice?.[2])).not.toContain('LEALLITOTTA')   // unreadable is not "stopped by the restart"
    expect(resumeTexts().join(' ')).not.toContain('LEÁLLÍTOTTA')
  })
})

describe('main agent: the alert counts only when the channel took it', () => {
  it('a failed operator send is logged as a failed alert', async () => {
    writeFileSync(CONFIG, JSON.stringify({ marveen: { enabled: true, limitTokens: 100_000, heavyJobDeferMaxMinutes: 0 } }))
    h.tokens = 99_000
    job(5001, 'main-job')
    h.notifyOk = false
    h.mainRunning = true
    try {
      await boot()
      await at(270)
      expect(h.notifyChannel.mock.calls.filter((c) => String(c[0]).includes('main-job'))).toHaveLength(1)
      expect(h.log.error.some((a) => a.includes('context-guard: FAILED TO RAISE the heavy-job restart alert'))).toBe(true)
    } finally {
      h.mainRunning = false
    }
  })
})

describe('main agent: a notifyChannel that does not report delivery', () => {
  it('a void result (a build whose notifyChannel resolves undefined) counts as sent', async () => {
    writeFileSync(CONFIG, JSON.stringify({ marveen: { enabled: true, limitTokens: 100_000, heavyJobDeferMaxMinutes: 0 } }))
    h.tokens = 99_000
    job(5001, 'main-job')
    h.notifyOk = undefined
    h.mainRunning = true
    try {
      await boot()
      await at(270)
      expect(h.notifyChannel.mock.calls.filter((c) => String(c[0]).includes('main-job'))).toHaveLength(1)
      expect(h.log.error.some((a) => a.includes('context-guard: FAILED TO RAISE the heavy-job restart alert'))).toBe(false)
    } finally {
      h.mainRunning = false
    }
  })
})

describe('hold store read failures are loud', () => {
  it('a corrupt store is logged at ERROR and treated as empty', async () => {
    writeFileSync(HOLDS, '{not json')
    hardTier(45)
    job(5001, 'x')
    await boot()
    await at(270)
    expect(h.log.error.some((a) => a.some((x) => typeof x === 'string' && x.includes('hold store unreadable or corrupt')))).toBe(true)
    expect(restarts()).toBe(0)                      // the job is still held from a fresh first sighting
  })
})

describe('resume store carries the note', () => {
  it('parses and validates it', async () => {
    const { parsePendingResumes } = await import('../web/context-guard-resume-store.js')
    const p = parsePendingResumes({
      a: { restartedAtMs: 1, heavyJobs: { heldMinutes: 5, ended: ['j', 7], killed: [{ label: 'k', state: 'running' }, { label: 'z', state: 'x' }] } },
      b: { restartedAtMs: 2, heavyJobs: { ended: [] } },
    })
    expect(p.a.heavyJobs).toEqual({ heldMinutes: 5, ended: ['j'], killed: [{ label: 'k', state: 'running' }] })
    expect(p.b.heavyJobs).toBeUndefined()
  })
})
