import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The main agent's model is read from its transcript, and a transcript carries the API id without the "[1m]" marker of
// the launch id. A main session launched as claude-fable-5-2[1m] was therefore sized as the bare id (200k) and handed
// off at a fifth of its window. The marker now comes back from the configured launch model, when it names the same model.
// Harness: the same mocks as context-guard-unknown-model.test.ts.

const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-main-launch-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

let transcriptModel: string | null = 'claude-fable-5-2'
let launched: string | (() => string) = 'claude-fable-5-2[1m]'
let subModel = 'claude-fable-5-2'
const TOKENS = 150_000

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
  readConfiguredMainModel: () => (typeof launched === 'function' ? launched() : launched),
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  clearFeedbackModalAndRecheck: () => false,
  agentRunState: () => 'stopped',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: vi.fn(),
  capturePane: () => null,
  sendPromptToSession: vi.fn(),
  isSessionReadyForPrompt: async () => false,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['sub'],
  listAllAgentNames: () => ['sub'],
  agentDir: (n: string) => join(SANDBOX, 'agents', n),
  readAgentModel: () => subModel,
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/active-model.js', async (orig) => ({
  ...(await orig<typeof import('../web/active-model.js')>()),
  readContextTokensFromProjectDir: () => TOKENS,
  readActiveModelFromProjectDir: () => transcriptModel,
  readTranscriptMtimeFromProjectDir: () => null,
}))
vi.mock('../web/context-guard-store.js', async () => {
  const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
  return { readContextGuardConfig: () => ({ ...DEFAULT_CONTEXT_GUARD, enabled: true }) }
})

const { measurePct } = await import('../web/context-guard-runner.js')
const { withLaunchWindowMarker, contextLimitForModel } = await import('../context-guard.js')

const pct = (name: string, limit: number | null = null) => measurePct(name, limit, { learn: false })

beforeEach(() => {
  transcriptModel = 'claude-fable-5-2'
  launched = 'claude-fable-5-2[1m]'
  subModel = 'claude-fable-5-2'
})

describe('withLaunchWindowMarker', () => {
  it.each([
    ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'claude-fable-5-2[1m]'],
    ['claude-fable-5-2', ' Claude-Fable-5-2[1M] ', 'Claude-Fable-5-2[1M]'],
    ['claude-fable-5-2', 'claude-fable-5-2', 'claude-fable-5-2'],          // launched without the marker: nothing to add
    ['claude-fable-5-2', 'claude-opus-5-5[1m]', 'claude-fable-5-2'],       // another model's marker is not this one's
    ['claude-fable-5-2', 'claude-fable-5-20[1m]', 'claude-fable-5-2'],     // a longer id is another model
    ['claude-fable-5-2', '[1m]', 'claude-fable-5-2'],
    ['claude-test-1m', ' CLAUDE-TEST-1M ', 'claude-test-1m'],              // "1m" inside an id is not the marker

    ['claude-fable-5-2', null, 'claude-fable-5-2'],
    ['claude-fable-5-2', undefined, 'claude-fable-5-2'],
    ['claude-fable-5-2[1m]', 'claude-fable-5-2[1m]', 'claude-fable-5-2[1m]'],
    [null, 'claude-fable-5-2[1m]', null],
    ['', 'claude-fable-5-2[1m]', ''],
  ])('transcript %j, launched %j -> %j', (measured, launch, want) => {
    expect(withLaunchWindowMarker(measured, launch)).toBe(want)
  })
})

describe('the runner sizes the main agent by its launch id', () => {
  it('the base windows this test rests on: 200k for the bare id, 1M with the marker', () => {
    expect(contextLimitForModel('claude-fable-5-2')).toBe(200_000)
    expect(contextLimitForModel('claude-fable-5-2[1m]')).toBe(1_000_000)
  })

  it('launched with [1m]: the same tokens are 15 percent, not 75', () => {
    expect(pct('marveen')).toBeCloseTo(TOKENS / 1_000_000)
  })

  it('launched without the marker: 200k, as before', () => {
    launched = 'claude-fable-5-2'
    expect(pct('marveen')).toBeCloseTo(TOKENS / 200_000)
  })

  it('launched as another model with [1m] (a /model switch the config does not show): the transcript id decides', () => {
    launched = 'claude-opus-5-5[1m]'
    expect(pct('marveen')).toBeCloseTo(TOKENS / 200_000)
  })

  it('an unreadable launch model does not break the measurement: the transcript id decides', () => {
    launched = () => { throw new Error('settings unreadable') }
    expect(pct('marveen')).toBeCloseTo(TOKENS / 200_000)
  })

  it('a sub-agent is sized by its own configured model, never by the main launch id', () => {
    expect(pct('sub')).toBeCloseTo(TOKENS / 200_000)
    subModel = 'claude-fable-5-2[1m]'
    expect(pct('sub')).toBeCloseTo(TOKENS / 1_000_000)
  })

  it('a pinned limitTokens still wins', () => {
    expect(pct('marveen', 500_000)).toBeCloseTo(TOKENS / 500_000)
  })
})
