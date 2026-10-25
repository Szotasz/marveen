// Before a restart that a not-busy pane reading allowed, the runner asks the
// transcript whether the turn is still running. Between two tool calls of a
// running turn the pane can read idle; a restart decided on that reading cut
// two live tool calls on a live install (decided 80 ms after they were
// written; their results landed 40 ms after the decision). Same harness as
// context-guard-idle-flush-restart-notice.test.ts: the REAL runner and state
// machine, with the pane, the transcript and the restart mocked.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(homedir(), '.cgtq-test-'))
const STORE = join(ROOT, 'store')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))

const T0 = 1_790_000_000_000
const MIN = 60_000
const HELD = 'context-guard: pane read idle but the transcript shows a running turn -- restart held, decided again as busy'

// A healthy idle pane: input box and the bypass footer, no saturation banner.
const IDLE_PANE = ['  done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

const h = vi.hoisted(() => ({
  turnAgoMs: null as number | null,
  restarts: 0,
  warns: [] as string[],
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...a: unknown[]) => { h.warns.push(String(a[a.length - 1])) },
  },
}))
vi.mock('../web/context-guard-store.js', async () => {
  const { normalizeContextGuardConfig } = await import('../context-guard.js')
  // 600k tokens against a 500k limit: 120%, past hardPct.
  return { readContextGuardConfig: () => normalizeContextGuardConfig({ enabled: true, limitTokens: 500_000 }) }
})
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: async () => { h.restarts++; return { ok: true } },
  capturePane: (s: string) => (s.startsWith('agent-') ? IDLE_PANE : null),
  isSessionReadyForPrompt: async () => false,
  noteSaturationBannerUntrusted: () => {},
  clearSaturationBannerOverride: () => {},
}))
vi.mock('../web/system-directive.js', () => ({ sendSystemDirective: async () => 'sent' }))
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
  readAgentWorksourceChannel: () => false,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => 600_000,
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => T0 - 2 * MIN,
  readTranscriptTailFromProjectDir: () => null,
  readLastTurnActivityMs: () => (h.turnAgoMs === null ? null : Date.now() - h.turnAgoMs),
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({
  createAgentMessage: () => ({ id: 1 }),
  countRestartQueueState: () => ({ pending: 0, failed: 0 }),
}))

type Runner = typeof import('../web/context-guard-runner.js')
let timers: NodeJS.Timeout[] = []

async function boot(): Promise<Runner> {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  timers.push(runner.startContextGuardRunner())
  return runner
}

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(join(ROOT, 'agents', 'boni'), { recursive: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.turnAgoMs = null
  h.restarts = 0
  h.warns = []
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** The first sweep runs 4.5 minutes after the start, then every 5 minutes. */
const firstSweep = () => vi.advanceTimersByTimeAsync(4.5 * MIN)

describe('hard-threshold restart on an idle-looking pane, through the real runner', () => {
  it('a turn line 1 s old: the restart is held, and the log says why', async () => {
    h.turnAgoMs = 1_000
    const runner = await boot()
    await firstSweep()
    expect(h.restarts).toBe(0)
    expect(h.warns).toContain(HELD)
    expect(runner.getHardGuardPhase('boni')).not.toBe('await-ready')
  })

  it('the turn goes quiet: the next sweep restarts (a delay, not a block)', async () => {
    h.turnAgoMs = 1_000
    await boot()
    await firstSweep()
    expect(h.restarts).toBe(0)
    h.turnAgoMs = 2 * MIN
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(h.restarts).toBe(1)
  })

  it('a turn line older than the quiet window: restarts at once, as before', async () => {
    h.turnAgoMs = 2 * MIN
    const runner = await boot()
    await firstSweep()
    expect(h.restarts).toBe(1)
    expect(h.warns).not.toContain(HELD)
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
  })

  it('an unreadable transcript keeps the restart (a wedged pane must still get it)', async () => {
    h.turnAgoMs = null
    await boot()
    await firstSweep()
    expect(h.restarts).toBe(1)
    expect(h.warns).not.toContain(HELD)
  })
})
