import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(process.cwd(), '.cgresume-drain-test-'))
const STORE = join(ROOT, 'store')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'main-agent',
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
  sendOutcome: 'sent' as 'sent' | 'aborted-busy' | 'skipped-locked',
  markMessageDelivered: vi.fn((_id: number) => true),
  sendSystemDirective: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<string>>,
  restartAgentProcess: null as unknown as import('vitest').Mock<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>,
}))

vi.mock('../web/agent-process.js', async () => {
  const { vi } = await import('vitest')
  h.restartAgentProcess = vi.fn(async () => ({ ok: true }))
  return {
    withTmuxBatch: (fn: () => unknown) => fn(),
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
  listAgentNames: () => ['agent-x'],
  listAllAgentNames: () => ['agent-x'],
  agentDir: (n: string) => join(ROOT, 'agents', n),
  readAgentModel: () => null,
  readAgentRemoteHost: () => null,
  isKnownAgent: () => false,
  readAgentChannelProvider: () => null,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => null,
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => null,
  readTranscriptTailFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'main-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({
  createAgentMessage: () => ({ id: 1 }),
  getPendingMessages: (name: string) => name === 'agent-x' ? [{
    id: 4201,
    from_agent: 'agent-y',
    to_agent: 'agent-x',
    content: 'PENDING-PEER-CONTENT',
    urgent: 0,
    stop_authorized: 0,
    created_at: Math.floor(Date.now() / 1000) - 60,
    origin_note: null,
  }] : [],
  markMessageDelivered: (id: number) => h.markMessageDelivered(id),
  countNewerMessagesFromSameSender: () => 0,
}))

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

function resumeCalls(): unknown[][] {
  return h.sendSystemDirective.mock.calls.filter((c) =>
    String(c[2]).includes('Friss kontextussal indultál'),
  )
}

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', '*')
  vi.stubEnv('ROUTER_BATCH_INJECT_MAX', '50')
  h.markMessageDelivered.mockClear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.pane = null
  h.sessionReady = true
  h.sendOutcome = 'sent'
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  h.sendSystemDirective?.mockClear()
  h.restartAgentProcess?.mockClear()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe.each(['immediate loop', 'sweep backstop'] as const)('%s resume drain', (site) => {
  it.each(['sent', 'aborted-busy'] as const)('attaches pending rows and marks them only on sent (%s)', async (outcome) => {
    h.sendOutcome = outcome
    h.pane = SATURATED_PANE
    const runner = await bootDashboard()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(h.restartAgentProcess).toHaveBeenCalledTimes(1)
    expect(runner.getHardGuardPhase('agent-x')).toBe('await-ready')
    expect(resumeCalls()).toHaveLength(0)
    h.pane = null

    if (site === 'sweep backstop') {
      // Stop the sleeping loop and re-arm only the runner's sweep timers.
      for (const t of timers) clearInterval(t)
      timers = []
      const now = Date.now()
      vi.clearAllTimers()
      vi.setSystemTime(now)
      timers.push(runner.startContextGuardRunner())
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
    } else {
      await vi.advanceTimersByTimeAsync(25_000)
    }

    const calls = resumeCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0]).toBe('agent-x')
      expect(call[4]).toMatchObject({ attachAfterDirective: expect.stringContaining('PENDING-PEER-CONTENT') })
      if (site === 'immediate loop') expect(call[4]).toMatchObject({ onBusyTimeout: 'abort' })
      else expect(call[4]).not.toHaveProperty('onBusyTimeout')
    }
    if (outcome === 'sent') {
      expect(calls).toHaveLength(1)
      expect(h.markMessageDelivered).toHaveBeenCalledExactlyOnceWith(4201)
    } else {
      expect(h.markMessageDelivered).not.toHaveBeenCalledWith(4201)
      expect(runner.getHardGuardPhase('agent-x')).toBe('await-ready')
    }
  })
})
