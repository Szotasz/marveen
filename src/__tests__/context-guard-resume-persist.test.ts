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
  h.sendSystemDirective = vi.fn(async () => h.sendOutcome)
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
    writePending({ boni: { restartedAtMs: T0 - 60_000, handoffStaleMinutes: null, reason: 'pane saturated' } })

    const runner = await bootDashboard()
    // The load-on-startup itself: before any sweep has run.
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)

    expect(resumeCalls()).toHaveLength(1)
    expect(resumeCalls()[0][0]).toBe('boni')
    expect(resumeCalls()[0][1]).toBe('agent-boni')
    // Delivered -> cleared, so a later dashboard restart does not send it again.
    expect(readPending()).toEqual({})
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
  })

  it('end to end: restart in one dashboard process, resume from the next', async () => {
    // Process 1: the saturation net restarts boni (two confirming sweeps).
    h.pane = SATURATED_PANE
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
    h.pane = null

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
    expect(resumeCalls()).toHaveLength(1)
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    expect(readPending()).toHaveProperty('boni')

    h.sendOutcome = 'sent'
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(resumeCalls()).toHaveLength(2)
    expect(readPending()).toEqual({})
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
