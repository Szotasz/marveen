// The context-guard's "restarted, resume prompt
// still owed" state survives a dashboard restart.
//
// Before this change the await-ready phase lived only in the runner's
// in-memory guardStates map. A dashboard restart between the agent's fresh
// restart and the next sweep re-armed the agent at 'idle', the resume prompt
// was never sent, and the fresh session sat at an empty prompt (measured
// 2026-09-24 10:18).
//
// These are BEHAVIOUR tests against the real runner and the real state
// machine; only the process/tmux/DB edges are mocked. The "dashboard restart"
// is simulated the only honest way available in-process: vi.resetModules()
// throws away every module-level Map, and a fresh import + startContextGuardRunner()
// is a new dashboard process that has nothing but store/ to go on.
//
// NEGATIVE CONTROL: delete the restorePendingResumes(...) call from
// startContextGuardRunner() and the first two runner tests go red -- the agent
// is back at 'idle' and sendSystemDirective is never called.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Under HOME, not /tmp: other guards in this repo reject /tmp-rooted PROJECT_ROOTs.
const ROOT = mkdtempSync(join(homedir(), '.cgresume-test-'))
const STORE = join(ROOT, 'store')
const PENDING = join(STORE, 'context-guard-pending-resume.json')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// A hard-error saturation banner: the net trusts it without a transcript
// probe, so the in-run restart path can be driven with no transcript fixture.
const SATURATED_PANE = [
  '  some prior assistant output',
  '',
  'Context limit reached · use /compact or /clear to continue',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const h = vi.hoisted(() => ({
  pane: null as string | null,
  sessionReady: true,
  restartOk: true,
  sendOutcome: 'sent' as 'sent' | 'aborted-busy' | 'skipped-locked',
  sendThrows: false,
  // When set, the send waits on it: holds a send open, as the per-pane lane does.
  sendGate: null as Promise<void> | null,
  sendSystemDirective: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<string>>,
  restartAgentProcess: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>,
}))

vi.mock('../web/agent-process.js', async () => {
  const { vi } = await import('vitest')
  h.restartAgentProcess = vi.fn(async () => (h.restartOk ? { ok: true } : { ok: false, error: 'boom' }))
  return {
    agentRunState: () => 'running',
    agentSessionName: (n: string) => `agent-${n}`,
    restartAgentProcess: (...a: unknown[]) => h.restartAgentProcess(...a),
    // Main agent's pane is absent -> main reads as not running and stays idle.
    capturePane: (session: string) => (session.startsWith('agent-') ? h.pane : null),
    isSessionReadyForPrompt: async () => h.sessionReady,
    noteSaturationBannerUntrusted: () => {},
    clearSaturationBannerOverride: () => {},
  }
})

vi.mock('../web/system-directive.js', async () => {
  const { vi } = await import('vitest')
  h.sendSystemDirective = vi.fn(async () => {
    if (h.sendGate) await h.sendGate
    if (h.sendThrows) throw new Error('tmux send failed')
    return h.sendOutcome
  })
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
  readContextTokensFromProjectDir: () => null,
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => null,
  readTranscriptTailFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({ createAgentMessage: () => ({ id: 1 }) }))

const INITIAL_DELAY_MS = 270_000
const INTERVAL_MS = 300_000
const T0 = 1_790_000_000_000

type Runner = typeof import('../web/context-guard-runner.js')
let timers: NodeJS.Timeout[] = []

/** A new dashboard process: fresh module state, only store/ carries over. */
async function bootDashboard(): Promise<Runner> {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  timers.push(runner.startContextGuardRunner())
  return runner
}

function readPending(): Record<string, { restartedAtMs: number }> {
  return existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf-8')) : {}
}

function writePending(obj: unknown): void {
  writeFileSync(PENDING, JSON.stringify(obj))
}

function resumeCalls(): unknown[][] {
  return h.sendSystemDirective.mock.calls.filter((c) =>
    String(c[2]).includes('Friss kontextussal indultál'),
  )
}

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.pane = null
  h.sessionReady = true
  h.restartOk = true
  h.sendOutcome = 'sent'
  h.sendThrows = false
  h.sendGate = null
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
  h.sendSystemDirective?.mockClear()
  h.restartAgentProcess?.mockClear()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('context-guard resume obligation across a dashboard restart', () => {
  it('re-arms await-ready on startup and delivers the resume on the first sweep', async () => {
    // The pane is not ready yet, so only the re-armed state is visible at boot;
    // delivery (loop or sweep) needs it to turn ready.
    h.sessionReady = false
    writePending({ boni: { restartedAtMs: T0 - 60_000, handoffStaleMinutes: null, reason: 'pane saturated' } })

    const runner = await bootDashboard()
    // The load-on-startup itself: before any sweep has run.
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')

    h.sessionReady = true
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)

    expect(resumeCalls()).toHaveLength(1)
    expect(resumeCalls()[0][0]).toBe('boni')
    expect(resumeCalls()[0][1]).toBe('agent-boni')
    // Delivered -> cleared, so a later dashboard restart does not send it again.
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
  })

  it('end to end: restart in one dashboard process, resume from the next', async () => {
    // Process 1: the saturation net restarts boni (two confirming sweeps). The
    // fresh pane is not ready yet, so the resume is still owed when it dies.
    h.pane = SATURATED_PANE
    h.sessionReady = false
    const first = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(first.getHardGuardPhase('boni')).toBe('await-ready')
    expect(Object.keys(readPending())).toEqual(['boni'])
    expect(resumeCalls()).toHaveLength(0)

    // The dashboard dies before the next sweep could deliver the resume.
    // (Its initial setTimeout has already fired; clearing the interval is
    // the whole of its timer state.)
    for (const t of timers) clearInterval(t)
    timers = []
    // ...and so does its delivery loop (its pending sleep is a timer too).
    // clearAllTimers drops the fake clock back to real time; put it back.
    const now = Date.now()
    vi.clearAllTimers()
    vi.setSystemTime(now)
    h.pane = null
    h.sessionReady = true

    // Process 2: nothing in memory, only the file.
    const second = await bootDashboard()
    expect(second.getHardGuardPhase('boni')).toBe('await-ready')
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
  })

  it('drops an obligation older than the TTL instead of sending it late', async () => {
    const { PENDING_RESUME_TTL_MS } = await import('../web/context-guard-resume-store.js')
    writePending({ boni: { restartedAtMs: T0 - PENDING_RESUME_TTL_MS - 1, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    expect(runner.getHardGuardPhase('boni')).toBe('idle')
    expect(readPending()).toEqual({})
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(0)
  })

  it('expires a restored obligation at the TTL edge if the session never gets ready', async () => {
    const { PENDING_RESUME_TTL_MS } = await import('../web/context-guard-resume-store.js')
    h.sessionReady = false
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(readPending()).toHaveProperty('boni') // still waiting, still owed
    await vi.advanceTimersByTimeAsync(PENDING_RESUME_TTL_MS)
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
    expect(readPending()).toEqual({})
    expect(resumeCalls()).toHaveLength(0)
  })

  it('keeps the obligation and retries when nothing was injected', async () => {
    h.sendOutcome = 'aborted-busy'
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    // The delivery loop tries again on its backoff, the sweep as the backstop.
    expect(resumeCalls().length).toBeGreaterThan(1)
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    expect(readPending()).toHaveProperty('boni')

    h.sendOutcome = 'sent'
    const before = resumeCalls().length
    await vi.advanceTimersByTimeAsync(30_000) // the longest backoff step
    expect(resumeCalls()).toHaveLength(before + 1)
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
  })

  it('a resume delivery that threw is not sent again by the next dashboard process', async () => {
    h.sendThrows = true
    writePending({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } })

    await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    // Part of the text may already be in the pane: the obligation is dropped.
    expect(readPending()).toEqual({})

    // A dashboard restart well within the TTL must not deliver a second copy.
    for (const t of timers) clearInterval(t)
    timers = []
    h.sendThrows = false
    const second = await bootDashboard()
    expect(second.getHardGuardPhase('boni')).toBe('idle')
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(1)
  })

  it('never persists an obligation for a restart that failed', async () => {
    h.pane = SATURATED_PANE
    h.restartOk = false
    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(runner.getHardGuardPhase('boni')).toBe('idle')
    expect(existsSync(PENDING) ? readPending() : {}).toEqual({})
  })
})

// The restart starts a delivery loop instead of waiting for the
// next 300 s sweep.
describe('immediate resume delivery after a guard restart', () => {
  it('delivers ONE resume within 60 s of the restart, not 5 minutes later', async () => {
    h.pane = SATURATED_PANE
    await bootDashboard()
    // Two saturated sweeps: 270 s (setTimeout) and 300 s (first interval tick).
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    // The guard owns the first prompt, so the generic recovery brief stays out.
    expect(h.restartAgentProcess.mock.calls[0][1]).toMatchObject({ fresh: true, ownsResume: true })
    const restartedAt = readPending().boni?.restartedAtMs
    expect(restartedAt).toBeDefined()
    h.pane = null

    // Not at the restart instant (the identity-setup keystrokes are still
    // landing), but well before the next sweep.
    expect(resumeCalls()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(25_000)
    const calls = resumeCalls()
    expect(calls).toHaveLength(1)
    expect(Date.now() - restartedAt!).toBeLessThanOrEqual(60_000)
    // 'abort': the loop never types best-effort into a busy pane.
    expect(calls[0][4]).toMatchObject({ onBusyTimeout: 'abort' })
    expect(readPending()).toEqual({})

    // The sweeps that follow find nothing owed: still exactly one.
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(1)
  })

  it('the loop settles the obligation BEFORE it releases its send claim (no gap for a second resume)', async () => {
    // The loop's .then runs a few microtasks after the send returns. If the
    // claim were released first, a sweep in that gap would see no claim and a
    // still-owed obligation in await-ready, and send a second resume. Observed
    // at the loop's own "delivered" log line, which runs after the send (and
    // its claim release) returned but before the .then.
    h.pane = SATURATED_PANE
    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    h.pane = null
    const { logger } = await import('../logger.js')
    let atDelivered: { pending: Record<string, unknown>; phase: string } | null = null
    ;(logger.info as unknown as ReturnType<typeof vi.fn>).mockImplementation((_o: unknown, msg?: unknown) => {
      if (msg === 'resume-delivery: delivered') atDelivered = { pending: readPending(), phase: runner.getHardGuardPhase('boni') }
    })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(resumeCalls()).toHaveLength(1)
    expect(atDelivered).not.toBeNull()
    expect(atDelivered!.pending).toEqual({})
    expect(atDelivered!.phase).toBe('cooldown')
  })

  it('a sweep tick while the loop\'s send is in flight sends nothing (the sweep honours the claim)', async () => {
    // The other half of "one prompt per restart": the loop's send is async and
    // goes through the per-pane send lane, so it can stay open across a sweep
    // tick. In await-ready the sweep would send its own resume; the loop's
    // claim is the only thing that stops it.
    h.pane = SATURATED_PANE
    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    h.pane = null

    let releaseSend!: () => void
    h.sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(resumeCalls()).toHaveLength(1) // the loop's send, held open
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    expect(readPending()).toHaveProperty('boni')

    // One sweep tick while the send is still open.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(1)

    h.sendGate = null
    releaseSend()
    await vi.advanceTimersByTimeAsync(0)
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(1)
  })

  it('backstop: with the loop dead, the sweep still delivers the resume on its own', async () => {
    // The loop is the fast path, the sweep the safety net. After the restart
    // every timer dies (the loop's pending sleep with them) and only the sweep
    // is re-armed; the loop's registration is still in memory, so no new loop
    // starts. If the sweep stopped being a backstop, nothing would deliver.
    h.pane = SATURATED_PANE
    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS) // restart; the loop is sleeping
    expect(Object.keys(readPending())).toEqual(['boni'])
    expect(resumeCalls()).toHaveLength(0)
    h.pane = null

    for (const t of timers) clearInterval(t)
    timers = []
    const now = Date.now()
    vi.clearAllTimers()
    vi.setSystemTime(now)
    timers.push(runner.startContextGuardRunner())

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
  })

  it('sends nothing while the pane is busy, then delivers once it is ready', async () => {
    h.sessionReady = false
    h.pane = SATURATED_PANE
    await bootDashboard()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS)
    h.pane = null
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(resumeCalls()).toHaveLength(0)
    expect(readPending()).toHaveProperty('boni')

    h.sessionReady = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
  })
})

describe('restartLossLine (pure)', () => {
  // The through-the-runner proof is context-guard-idle-flush-restart-notice.test.ts;
  // these pin the two branches of the wording itself.
  it('idle-flush + worksource: the queue redelivers, do not resend', async () => {
    const { restartLossLine } = await import('../web/context-guard-runner.js')
    const line = restartLossLine(true, true, 30)
    expect(line).toContain('NE kuldj ujra')
    expect(line).toContain('ujrakezbesulnek')
    expect(line).not.toContain('ELVESZHETTEK')
  })

  it('keeps the generic line elsewhere: not worksource, or not an idle-flush', async () => {
    const { restartLossLine } = await import('../web/context-guard-runner.js')
    expect(restartLossLine(true, false, 30)).toContain('ELVESZHETTEK')
    expect(restartLossLine(false, true, 30)).toContain('ELVESZHETTEK')
  })
})

describe('context-guard-resume-store: pure parts', () => {
  it('parses defensively: malformed entries are dropped, staleness is validated', async () => {
    const { parsePendingResumes } = await import('../web/context-guard-resume-store.js')
    expect(parsePendingResumes(null)).toEqual({})
    expect(parsePendingResumes([1, 2])).toEqual({})
    expect(parsePendingResumes({
      a: { restartedAtMs: 5, handoffStaleMinutes: 12, reason: 'r' },
      b: { restartedAtMs: 'nope' },
      c: { restartedAtMs: 7, handoffStaleMinutes: 'garbage' },
      d: { restartedAtMs: 8, handoffStaleMinutes: 'unknown' },
    })).toEqual({
      a: { restartedAtMs: 5, handoffStaleMinutes: 12, reason: 'r' },
      c: { restartedAtMs: 7, handoffStaleMinutes: null, reason: '' },
      d: { restartedAtMs: 8, handoffStaleMinutes: 'unknown', reason: '' },
    })
  })

  it('restores with the TTL edge as deadline and carries the staleness', async () => {
    const { restorableResumeStates } = await import('../web/context-guard-resume-store.js')
    const { live, expired } = restorableResumeStates({
      fresh: { restartedAtMs: 1_000, handoffStaleMinutes: 7, reason: '' },
      old: { restartedAtMs: 0, handoffStaleMinutes: null, reason: '' },
      // A future timestamp (clock change) must not make the entry immortal.
      future: { restartedAtMs: 10_000_000, handoffStaleMinutes: null, reason: '' },
    }, 1_500, 1_000)
    expect(expired).toEqual(['old'])
    expect(live.get('fresh')).toMatchObject({ phase: 'await-ready', deadlineMs: 2_000, handoffStaleMinutes: 7 })
    expect(live.get('future')).toMatchObject({ phase: 'await-ready', deadlineMs: 2_500 })
  })

  it('reads a missing or corrupt file as empty', async () => {
    const { readPendingResumes } = await import('../web/context-guard-resume-store.js')
    expect(readPendingResumes(join(STORE, 'does-not-exist.json'))).toEqual({})
    writeFileSync(join(STORE, 'corrupt.json'), '{not json')
    expect(readPendingResumes(join(STORE, 'corrupt.json'))).toEqual({})
  })
})
