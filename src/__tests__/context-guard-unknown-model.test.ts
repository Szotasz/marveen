import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// CTXUNKNOWNMODEL1122: for a model id it does not know, the guard measures against the 200k fallback. That is now
// visible: isKnownContextModel says so, the runner logs one WARN per agent and model, and the dashboard status row
// carries assumedWindow so the badge can mark the pct. A pinned limitTokens is a decision, so it is not "assumed".

const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-unknown-model-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

let model = 'qwen3:14b'
let limitTokens: number | null = null
let agents: string[] = ['local']
const warn = vi.fn()

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } }))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
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
  listAgentNames: () => agents,
  listAllAgentNames: () => agents,
  agentDir: (n: string) => join(SANDBOX, 'agents', n),
  readAgentModel: () => model,
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/active-model.js', async (orig) => ({
  ...(await orig<typeof import('../web/active-model.js')>()),
  readContextTokensFromProjectDir: () => 50_000,
  readActiveModelFromProjectDir: () => model,
  readTranscriptMtimeFromProjectDir: () => null,
}))
vi.mock('../web/context-guard-store.js', async () => {
  const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
  return { readContextGuardConfig: () => ({ ...DEFAULT_CONTEXT_GUARD, enabled: true, limitTokens }) }
})

const { getContextGuardStatus, measurePct } = await import('../web/context-guard-runner.js')
const { contextLimitForModel, isKnownContextModel, contextWindowForModel } = await import('../context-guard.js')

const unknownWarns = () => warn.mock.calls.filter(c => String(c[1]).includes('unknown model'))
const row = (name: string) => getContextGuardStatus().find(r => r.agent === name)!

beforeEach(() => {
  warn.mockClear()
  limitTokens = null
})

describe('isKnownContextModel', () => {
  it.each([
    'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-opus-5', 'claude-fable-5-2',
    'claude-fable-5-1', 'claude-mythos-5', 'some-model[1m]', 'minimax-m3', 'deepseek/deepseek-v4.1-flash', 'deepseek-v4-pro',
  ])('%s is known', (id) => {
    expect(isKnownContextModel(id)).toBe(true)
  })

  it.each([null, undefined, '', 'qwen3:14b', 'llama3.1:8b', 'gpt-oss:20b', 'test-model'])('%s is not known', (id) => {
    expect(isKnownContextModel(id as string | null | undefined)).toBe(false)
  })

  it('one source: the limit is the same as contextLimitForModel, and every unknown id gets the 200k fallback', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'minimax-m3', 'qwen3:14b', 'x[1m]']) {
      expect(contextWindowForModel(id).limit).toBe(contextLimitForModel(id))
    }
    expect(contextWindowForModel('qwen3:14b')).toEqual({ limit: 200_000, known: false })
  })
})

describe('the runner on an unknown model', () => {
  it('logs one WARN per agent and model, with the agent, the model and the assumed 200k', () => {
    model = 'qwen3:14b'
    agents = ['local']
    measurePct('local', null)
    measurePct('local', null)
    measurePct('local', null)
    expect(unknownWarns()).toHaveLength(1)
    expect(unknownWarns()[0][0]).toEqual({ name: 'local', model: 'qwen3:14b', assumedLimit: 200_000 })
    model = 'llama3.1:8b'
    measurePct('local', null)
    expect(unknownWarns()).toHaveLength(2)
  })

  it('a known model never warns', () => {
    model = 'claude-sonnet-5'
    agents = ['known1']
    measurePct('known1', null)
    expect(unknownWarns()).toHaveLength(0)
  })

  it('a pinned limitTokens is a decision: no WARN, and the status row is not assumed', () => {
    model = 'gpt-oss:20b'
    agents = ['pinned']
    limitTokens = 64_000
    measurePct('pinned', limitTokens)
    expect(unknownWarns()).toHaveLength(0)
    expect(row('pinned').assumedWindow).toBeUndefined()
    expect(row('pinned').pct).toBeCloseTo(50_000 / 64_000)
  })

  it('the status row carries assumedWindow for an unknown model, and not for a known one', () => {
    model = 'qwen3:14b'
    agents = ['local2']
    expect(row('local2').assumedWindow).toBe(true)
    model = 'claude-opus-5'
    agents = ['known2']
    expect(row('known2').assumedWindow).toBeUndefined()
  })
})

describe('wiring: the dashboard badge reads assumedWindow', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
  it('loadAgents records the flag and the badge marks the pct with ~ and the assumed tooltip', () => {
    expect(app).toContain('if (g.assumedWindow === true) contextGuardAssumed[g.agent] = true')
    expect(app).toContain("const assumed = contextGuardAssumed[agentName] === true")
    expect(app).toContain("(assumed ? ' ' + t('agents.context_assumed_tip') : '')")
    expect(app).toContain("${assumed ? '~' : ''}${pctRound}%")
  })
})
