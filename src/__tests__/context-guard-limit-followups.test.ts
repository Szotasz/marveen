// Follow-ups to the usage-limit park, exercised through the REAL runner and
// the real state machine; only the process/tmux/DB/transcript edges are mocked
// (same harness as context-guard-resume-persist.test.ts).
//
//   1. The handoff request a limit refused is re-sent once the limit lifts,
//      worded like the original, and the timeout window restarts from there.
//   2. An agent with only the saturation net armed does not pay for a
//      transcript-tail read outside the handoff phases.
//   3. A restored resume obligation's restartedAtMs is clamped ONCE at restore,
//      so a clock behind the stamp cannot slide the park's TTL edge.
//
// CONTROLS, run against the first version of the park (without these
// follow-ups): four tests below fail there -- the re-send (none is sent), "saturation net only, idle phase" (the
// tail is read every sweep), the TTL-edge park (it outlives the restored edge,
// no resume at 30 min) and the persisted clamp. The remaining tests pass on
// both and pin what must not change.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Under HOME, not /tmp: other guards in this repo reject /tmp-rooted PROJECT_ROOTs.
const ROOT = mkdtempSync(join(homedir(), '.cgfollow-test-'))
const STORE = join(ROOT, 'store')
const PENDING = join(STORE, 'context-guard-pending-resume.json')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))

const h = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  tail: '' as string | null,
  contextTokens: null as number | null,
  transcriptMtime: null as number | null,
  pane: null as string | null,
  sessionReady: true,
  info: null as unknown as import('vitest').Mock<(...a: unknown[]) => void>,
  readTail: null as unknown as import('vitest').Mock<(...a: unknown[]) => string | null>,
  sendSystemDirective: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<string>>,
  restartAgentProcess: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<{ ok: boolean }>>,
}))

vi.mock('../logger.js', async () => {
  const { vi } = await import('vitest')
  h.info = vi.fn()
  return { logger: { info: (...a: unknown[]) => h.info(...a), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }
})

vi.mock('../web/context-guard-store.js', async () => {
  const { normalizeContextGuardConfig } = await import('../context-guard.js')
  return { readContextGuardConfig: () => normalizeContextGuardConfig(h.cfg) }
})

vi.mock('../web/agent-process.js', async () => {
  const { vi } = await import('vitest')
  h.restartAgentProcess = vi.fn(async () => ({ ok: true }))
  return {
    agentRunState: () => 'running',
    agentSessionName: (n: string) => `agent-${n}`,
    restartAgentProcess: (...a: unknown[]) => h.restartAgentProcess(...a),
    // No pane by default: the main agent reads as not running, and boni's pane
    // state is 'unknown' (neither idle nor busy), so nothing defers on it.
    // The idle-flush test gives boni an idle pane; the main agent never has one.
    capturePane: (session: string) => (session.startsWith('agent-') ? h.pane : null),
    isSessionReadyForPrompt: async () => h.sessionReady,
    noteSaturationBannerUntrusted: () => {},
    clearSaturationBannerOverride: () => {},
  }
})

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
vi.mock('../web/active-model.js', async () => {
  const { vi } = await import('vitest')
  h.readTail = vi.fn(() => h.tail)
  return {
    readContextTokensFromProjectDir: () => h.contextTokens,
    readActiveModelFromProjectDir: () => null,
    readTranscriptMtimeFromProjectDir: () => h.transcriptMtime,
    readTranscriptTailFromProjectDir: (...a: unknown[]) => h.readTail(...a),
  }
})
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({ createAgentMessage: () => ({ id: 1 }) }))

const MIN = 60_000
const T0 = 1_790_000_000_000
// Sweep times after boot: the initial timeout at 4.5 min, then the 5-minute
// interval (5, 10, 15, ...), both armed at boot.

// The measured CLI 2.1.280 refusal shape (see context-guard.test.ts), newest
// entry of the transcript: the session is usage-limited. Stamped just after T0,
// so in await-ready it is the NEW session's refusal (a refusal from before the
// restart would belong to the replaced session and park nothing).
const LIMITED_TAIL = JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: new Date(T0 + 1000).toISOString(),
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit · resets 6am (Europe/Budapest)" }] },
  quotaLimits: { status: 'rejected', resetsAt: Math.floor((T0 + 9 * 60 * MIN) / 1000), rateLimitType: 'seven_day' },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
}) + '\n'

type Runner = typeof import('../web/context-guard-runner.js')
let timers: NodeJS.Timeout[] = []

async function bootDashboard(): Promise<Runner> {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  timers.push(runner.startContextGuardRunner())
  return runner
}

/** Advance the fake clock to T0 + min minutes, running every sweep on the way. */
async function advanceTo(min: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(T0 + min * MIN - Date.now())
}

function readPending(): Record<string, { restartedAtMs: number }> {
  return existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, 'utf-8')) : {}
}

const handoffCalls = () => h.sendSystemDirective.mock.calls.filter((c) => String(c[2]).includes('A munkakontextusod'))
const resumeCalls = () => h.sendSystemDirective.mock.calls.filter((c) => String(c[2]).includes('Friss kontextussal indultál'))
const resendLogs = () => h.info.mock.calls.filter((c) => String(c[1]).includes('re-sending the refused handoff request'))

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.cfg = {}
  h.tail = ''
  h.contextTokens = null
  h.transcriptMtime = null
  h.pane = null
  h.sessionReady = true
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
  h.sendSystemDirective?.mockClear()
  h.restartAgentProcess?.mockClear()
  h.readTail?.mockClear()
  h.info?.mockClear()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('runner: the refused handoff request is re-sent once after the limit', () => {
  it('re-sends once with the original wording, logs it once, and times out from the re-send', async () => {
    // Act tier: 185k of an inferred 200k window = 93%, above actPct, below hardPct.
    h.cfg = { enabled: true }
    h.contextTokens = 185_000
    await bootDashboard()

    await advanceTo(4.5) // unlimited: the act-tier request goes out
    expect(handoffCalls()).toHaveLength(1)

    h.tail = LIMITED_TAIL
    await advanceTo(10) // two limited sweeps (5, 10): parked, deadline now 10 + 20 = 30
    expect(handoffCalls()).toHaveLength(1)

    h.tail = ''
    await advanceTo(15) // limit lifted, no HANDOFF.md: the re-send
    expect(handoffCalls()).toHaveLength(2)
    expect(handoffCalls()[1][2]).toBe(handoffCalls()[0][2])
    expect(resendLogs()).toHaveLength(1)

    await advanceTo(30) // the PARKED deadline: must not fire any more
    expect(h.restartAgentProcess).not.toHaveBeenCalled()
    expect(handoffCalls()).toHaveLength(2)

    await advanceTo(35) // 15 + 20: the fresh window ends
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(handoffCalls()).toHaveLength(2)
    expect(resendLogs()).toHaveLength(1)
  })

  it('no limited episode: no re-send, the timeout fires at the original deadline', async () => {
    h.cfg = { enabled: true }
    h.contextTokens = 185_000
    await bootDashboard()
    await advanceTo(4.5)
    expect(handoffCalls()).toHaveLength(1)
    await advanceTo(25) // 4.5 + 20 = 24.5 -> the 25-minute sweep restarts
    expect(handoffCalls()).toHaveLength(1)
    expect(resendLogs()).toHaveLength(0)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
  })
})

describe('runner: the re-send keeps the wording of a non-percentage tier', () => {
  it('idle-flush: the refused request is re-sent with the idle-flush wording, not the percentage prompt', async () => {
    // Idle-flush only: pct is never measured, so a re-send picked by the
    // re-send reason instead of the original one would fall through to the
    // percentage prompt and announce "~0% -- kritikus" to an idle session.
    h.cfg = { idleFlushEnabled: true, idleFlushTokens: 50_000, idleMinutes: 20 }
    h.contextTokens = 120_000
    h.transcriptMtime = T0 - 60 * MIN // quiet for an hour
    h.pane = [
      '  some prior assistant output',
      '',
      '─'.repeat(40),
      '❯ ',
      '─'.repeat(40),
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const handoffRequests = () => h.sendSystemDirective.mock.calls.filter((c) => String(c[2]).includes('írj HANDOFF.md-t'))
    await bootDashboard()

    await advanceTo(4.5) // unlimited: the idle-flush request goes out
    expect(handoffRequests()).toHaveLength(1)
    expect(String(handoffRequests()[0][2])).toContain('Rutin karbantartás')

    h.tail = LIMITED_TAIL
    await advanceTo(10) // limited: parked
    expect(handoffRequests()).toHaveLength(1)

    h.tail = ''
    await advanceTo(15) // limit lifted, no HANDOFF.md: the re-send
    expect(resendLogs()).toHaveLength(1)
    expect(handoffRequests()).toHaveLength(2)
    expect(String(handoffRequests()[1][2])).toContain('Rutin karbantartás')
    expect(String(handoffRequests()[1][2])).not.toContain('kritikus')
    expect(handoffRequests()[1][2]).toBe(handoffRequests()[0][2])
  })
})

describe('runner: transcript-tail read only where the verdict can matter', () => {
  it('saturation net only, idle phase: the tail is never read', async () => {
    h.cfg = {} // defaults: enabled/idle/daily off, net on
    await bootDashboard()
    await advanceTo(15)
    expect(h.readTail).not.toHaveBeenCalled()
  })

  it('any other tier armed: the tail is read', async () => {
    h.cfg = { idleFlushEnabled: true }
    await bootDashboard()
    await advanceTo(4.5)
    expect(h.readTail).toHaveBeenCalledTimes(1)
  })

  it('saturation net only, but await-ready: the tail is read (the resume park needs it)', async () => {
    h.sessionReady = false
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } }))
    const runner = await bootDashboard()
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    await advanceTo(4.5)
    expect(h.readTail).toHaveBeenCalledTimes(1)
  })
})

describe('runner: a restored restartedAtMs is clamped once', () => {
  it('a stamp ahead of the clock is clamped at restore; the park ends at that TTL edge', async () => {
    const { PENDING_RESUME_TTL_MS } = await import('../web/context-guard-resume-store.js')
    expect(PENDING_RESUME_TTL_MS).toBe(30 * MIN)
    // Stamped two hours ahead of the clock (a backwards step before this boot).
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0 + 120 * MIN, handoffStaleMinutes: null, reason: 'x' } }))
    h.tail = LIMITED_TAIL
    await bootDashboard()

    await advanceTo(29.99) // limited, within T0 + TTL: parked
    expect(resumeCalls()).toHaveLength(0)

    await advanceTo(30) // the edge: the park ends, ready session -> resume delivered
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
  })

  it('the clamped stamp is persisted, so a later restore cannot re-slide it', async () => {
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0 + 120 * MIN, handoffStaleMinutes: null, reason: 'x' } }))
    await bootDashboard()
    expect(readPending().boni.restartedAtMs).toBe(T0)
  })

  it('a stamp not ahead of the clock is left as recorded', async () => {
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0 - 5 * MIN, handoffStaleMinutes: null, reason: 'x' } }))
    h.sessionReady = false
    await bootDashboard()
    expect(readPending().boni.restartedAtMs).toBe(T0 - 5 * MIN)
  })
})

describe('runner: await-ready only counts the NEW session\'s refusals', () => {
  it('a refusal recorded before the restart (the replaced session) does not park the resume', async () => {
    // The fresh session has not written its own jsonl yet, so the newest file
    // is the old session's, ending in a refusal from before the restart.
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } }))
    h.tail = LIMITED_TAIL.replace(new Date(T0 + 1000).toISOString(), new Date(T0 - MIN).toISOString())
    await bootDashboard()
    await advanceTo(4.5) // first sweep: ready, not limited by an old refusal -> resume
    expect(resumeCalls()).toHaveLength(1)
    expect(readPending()).toEqual({})
  })

  it('the new session\'s own refusal does park it (control)', async () => {
    writeFileSync(PENDING, JSON.stringify({ boni: { restartedAtMs: T0, handoffStaleMinutes: null, reason: 'x' } }))
    h.tail = LIMITED_TAIL
    await bootDashboard()
    await advanceTo(4.5)
    expect(resumeCalls()).toHaveLength(0)
  })
})
