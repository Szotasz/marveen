// IDLEFLUSHVETO812, the BINDING: the runner must feed hasBackgroundWork(pane)
// into GuardInputs.paneBackgroundWork. The decision-level veto is pinned in
// idle-flush-background-veto.test.ts; this file proves the real runner (same
// harness as context-guard-idle-flush-restart-notice.test.ts) passes the
// captured pane through, so a session with a background shell is not flushed.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(homedir(), '.cgbgveto-test-'))
const STORE = join(ROOT, 'store')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const T0 = 1_790_000_000_000
const MIN = 60_000

// A healthy idle pane: input box and the bypass footer, no saturation banner.
const IDLE_PANE = ['  done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

const h = vi.hoisted(() => ({
  worksource: true,
  messages: [] as string[],
  pane: null as string | null,
}))

vi.mock('../web/context-guard-store.js', async () => {
  const { normalizeContextGuardConfig } = await import('../context-guard.js')
  return { readContextGuardConfig: () => normalizeContextGuardConfig({ idleFlushEnabled: true, idleMinutes: 20 }) }
})
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: async () => ({ ok: true }),
  capturePane: (s: string) => (s.startsWith('agent-') ? h.pane : null),
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
  readAgentWorksourceChannel: () => h.worksource,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => 600_000, // past idleFlushTokens
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => T0 - 120 * MIN, // quiet for 2 h
  readTranscriptTailFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({
  createAgentMessage: (_from: string, _to: string, content: string, tag?: string) => {
    if (tag === 'context-guard restart notice') h.messages.push(content)
    return { id: 1 }
  },
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
  rmSync(join(ROOT, 'agents', 'boni', 'HANDOFF.md'), { force: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.worksource = true
  h.messages = []
  h.pane = IDLE_PANE
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

// The live footer of a session whose Monitor and background shell still run
// (COMMATAIL1022 shape): idle-looking, so only the veto can hold the flush.
const BACKGROUND_PANE = ['  waiting on the build.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor'].join('\n')

describe('idle-flush veto, through the real runner', () => {
  it('a heavy, quiet, idle pane with no background work is asked for a handoff', async () => {
    const runner = await boot()
    await vi.advanceTimersByTimeAsync(4.5 * MIN)
    expect(runner.getHardGuardPhase('boni')).toBe('await-handoff')
  })

  it('the same session with a background shell and a Monitor is left alone', async () => {
    h.pane = BACKGROUND_PANE
    const runner = await boot()
    await vi.advanceTimersByTimeAsync(4.5 * MIN)
    expect(runner.getHardGuardPhase('boni')).toBe('idle')
    // ...and once the work ends the next sweep flushes, so the veto defers, it does not disarm.
    h.pane = IDLE_PANE
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(runner.getHardGuardPhase('boni')).toBe('await-handoff')
  })
})
