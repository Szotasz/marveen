// The restart notice for an idle-flush
// restart of a worksource agent says "the queue redelivers, do not resend".
//
// Review round 1 found it dead in production: the text was chosen from
// decision.reason, but at restart time that is "handoff written" -- the
// idle-flush origin only lives in the sequence state. So this goes through the
// REAL runner and state machine (same harness as
// context-guard-resume-persist.test.ts) and reads the text createAgentMessage
// actually receives: idle-flush request -> handoff written -> restart.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(homedir(), '.cgf3-test-'))
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
}))

vi.mock('../web/context-guard-store.js', async () => {
  const { normalizeContextGuardConfig } = await import('../context-guard.js')
  return { readContextGuardConfig: () => normalizeContextGuardConfig({ idleFlushEnabled: true, idleMinutes: 20 }) }
})
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: async () => ({ ok: true }),
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
  readAgentWorksourceChannel: () => h.worksource,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => 600_000, // past idleFlushTokens
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => T0 - 120 * MIN, // quiet for 2 h
  readTranscriptTailFromProjectDir: () => null,
  readLastTurnActivityMs: () => null,
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

/** Idle-flush request at the first sweep, the agent writes its handoff, the next sweep restarts. */
async function idleFlushToRestart(runner: Runner): Promise<void> {
  await vi.advanceTimersByTimeAsync(4.5 * MIN)
  expect(runner.getHardGuardPhase('boni')).toBe('await-handoff')
  writeFileSync(join(ROOT, 'agents', 'boni', 'HANDOFF.md'), '# handoff\n')
  await vi.advanceTimersByTimeAsync(5 * MIN)
}

describe('idle-flush restart notice, through the real runner', () => {
  it('a worksource agent is told the queue redelivers and not to resend', async () => {
    const runner = await boot()
    await idleFlushToRestart(runner)

    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toContain('NE kuldj ujra')
    expect(h.messages[0]).toContain('ujrakezbesulnek')
    expect(h.messages[0]).not.toContain('ELVESZHETTEK')
  })

  it('an agent NOT on worksource gets the queue counts', async () => {
    h.worksource = false
    const runner = await boot()
    await idleFlushToRestart(runner)

    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toContain('0 pending, 0 failed')
    expect(h.messages[0]).not.toContain('NE kuldj ujra')
  })
})
