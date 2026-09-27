import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// getContextGuardStatus (behind the dashboard's status route) measured every
// agent through measurePct, which persists a new per-agent high-water mark
// whenever the live reading beats the stored one. The mark only moves up and
// widens the denominator for good, so a status read taken at a high reading
// changed the thing it reports on, outside the guard's own sweep. The status
// path now reads the mark without writing it; the sweep is the only writer.

const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-status-readonly-'))
mkdirSync(join(SANDBOX, 'store'), { recursive: true })
const HIGHWATER = join(SANDBOX, 'store', 'context-guard-highwater.json')

let tokensNow = 0
let agents: string[] = []

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
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
  readAgentModel: () => 'test-model',
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/active-model.js', async (orig) => ({
  ...(await orig<typeof import('../web/active-model.js')>()),
  readContextTokensFromProjectDir: () => tokensNow,
  readActiveModelFromProjectDir: () => 'test-model',
  readTranscriptMtimeFromProjectDir: () => null,
}))
vi.mock('../web/context-guard-store.js', async () => {
  const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
  return { readContextGuardConfig: () => ({ ...DEFAULT_CONTEXT_GUARD, enabled: true }) }
})

const { getContextGuardStatus, measurePct } = await import('../web/context-guard-runner.js')
const { calibrateLimit, contextLimitForModel } = await import('../context-guard.js')

const BASE = contextLimitForModel('test-model')
const HIGH = 3 * BASE // far beyond the base window: calibrates to a wider tier
const LOW = Math.floor(BASE / 2)

function statusPct(name: string): number | null {
  agents = [name]
  const row = getContextGuardStatus().find(r => r.agent === name)
  expect(row).toBeDefined()
  return row!.pct
}

function storedMark(name: string): number | undefined {
  if (!existsSync(HIGHWATER)) return undefined
  return JSON.parse(readFileSync(HIGHWATER, 'utf-8'))[name]?.tokens
}

describe('context-guard status route reads the high-water mark without learning it', () => {
  it('a status read at a high reading does not persist a new mark', () => {
    tokensNow = HIGH
    statusPct('samu')
    expect(storedMark('samu')).toBeUndefined()
  })

  it('so the next guard measurement still uses the base window', () => {
    tokensNow = HIGH
    statusPct('laci')
    tokensNow = LOW
    expect(measurePct('laci', null)).toBe(LOW / BASE)
  })

  it('reports the same pct the guard would compute at that moment', () => {
    for (const t of [LOW, BASE, HIGH]) {
      const name = `parity-${t}`
      tokensNow = t
      const shown = statusPct(name)
      expect(shown).toBe(t / calibrateLimit(t, BASE))
      expect(measurePct(name, null)).toBe(shown)
    }
  })

  it('reads a mark the guard already stored', () => {
    tokensNow = HIGH
    measurePct('vera', null) // the guard's own sweep learns the wider window
    tokensNow = LOW
    expect(statusPct('vera')).toBe(LOW / calibrateLimit(HIGH, BASE))
  })

  it('positive control: the guard measurement itself still persists the mark', () => {
    tokensNow = HIGH
    measurePct('agent-x', null)
    expect(storedMark('agent-x')).toBe(HIGH)
    tokensNow = LOW
    expect(measurePct('agent-x', null)).toBe(LOW / calibrateLimit(HIGH, BASE))
    // A lower reading never lowers the stored mark.
    expect(storedMark('agent-x')).toBe(HIGH)
  })
})
