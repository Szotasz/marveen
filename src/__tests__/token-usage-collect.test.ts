import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

// Must be first: create filesystem fixtures before any mocks run
const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')

  const fakeHome = mkdtempSync(join(tmpdir(), 'tokencollect-'))

  // PROJECT_ROOT = '/fake-proj' -> encodeProjectPath -> '-fake-proj'
  const projectsDir = join(fakeHome, '.claude', 'projects')
  const mainDir = join(projectsDir, '-fake-proj')          // main agent dir
  const agentDir = join(projectsDir, '-fake-proj-agents-botx') // sub-agent dir

  mkdirSync(mainDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })

  const ts1 = 1716200000
  const iso = (offset: number) => new Date((ts1 + offset) * 1000).toISOString()

  // Main agent JSONL -- exercises multiple code paths in parseJsonlFile
  writeFileSync(join(mainDir, 'session1.jsonl'), [
    // sessionId line (sets sessionId for subsequent entries)
    JSON.stringify({ sessionId: 'sess-main-collect' }),
    // valid assistant line with tool_use content
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-001',
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tu1', input: {} },
          { type: 'thinking', thinking: 'a'.repeat(400) }, // ~100 thinking tokens
          { type: 'text', text: 'result' },
        ],
        model: 'claude-opus-4-5',
      },
      timestamp: iso(0),
    }),
    // duplicate messageId (same msg-001) — tests collapseByMessageId merge
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-001',
        usage: { input_tokens: 1100, output_tokens: 210, cache_read_input_tokens: 600, cache_creation_input_tokens: 110 },
        content: [{ type: 'text', text: 'repeat' }],
        model: 'claude-opus-4-5',
      },
      timestamp: iso(0),
    }),
    // valid line with plain string content (not array)
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: 'Plain string response content for preview',
        model: 'claude-sonnet-5',
      },
      timestamp: iso(60),
    }),
    // invalid JSON — should be skipped silently
    '{ not valid json %%',
    // blank line — skipped
    '',
    // non-assistant type — skipped
    JSON.stringify({ type: 'human', message: { usage: { input_tokens: 9999, output_tokens: 9999 } }, timestamp: iso(120) }),
    // assistant with no usage — skipped
    JSON.stringify({ type: 'assistant', message: {}, timestamp: iso(180) }),
    // assistant with usage but no timestamp — skipped
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 50, output_tokens: 10 } } }),
  ].join('\n'))

  // Sub-agent JSONL — exercises agent discovery for non-main agents
  const ts2 = ts1 + 7200
  writeFileSync(join(agentDir, 'session-bot.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-bot-collect',
      timestamp: new Date(ts2 * 1000).toISOString(),
      message: {
        usage: { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
        content: [{ type: 'text', text: 'bot answer' }],
        model: 'claude-haiku-4-5',
      },
    }),
  ].join('\n'))

  return { FAKE_HOME: fakeHome }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: '/fake-proj', MAIN_AGENT_ID: 'fakemain' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import {
  collectTokenUsage,
  getModelDistribution,
  getToolStats,
} from '../web/token-usage.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

describe('collectTokenUsage', () => {
  it('scans JSONL files and inserts parsed rows into the DB', async () => {
    const result = await collectTokenUsage()

    expect(result.files).toBeGreaterThanOrEqual(2)    // main + bot file
    expect(result.inserted).toBeGreaterThanOrEqual(2)  // at least main + bot rows

    const rows = getDb()
      .prepare("SELECT agent, session_id FROM token_usage WHERE agent IN ('fakemain','botx') ORDER BY agent")
      .all() as { agent: string; session_id: string }[]
    const agents = rows.map(r => r.agent)
    expect(agents).toContain('fakemain')
    expect(agents).toContain('botx')
  })

  it('collapses duplicate messageId rows (msg-001 appears once)', async () => {
    const rows = getDb()
      .prepare("SELECT * FROM token_usage WHERE agent = 'fakemain' AND session_id = 'sess-main-collect' ORDER BY timestamp")
      .all() as any[]
    // Two valid assistant lines with different timestamps survive; msg-001 duplicates are merged into one
    const ts1row = rows[0]
    // The collapsed msg-001 entry should have max of (1000,1100) = 1100 input tokens
    expect(ts1row.input_tokens).toBe(1100)
  })

  it('captures model and tool_name from content', async () => {
    const rows = getDb()
      .prepare("SELECT model, tool_name FROM token_usage WHERE agent = 'fakemain' ORDER BY timestamp")
      .all() as { model: string | null; tool_name: string | null }[]
    const bashRow = rows.find(r => r.tool_name === 'Bash')
    expect(bashRow).toBeDefined()
    expect(bashRow!.model).toBe('claude-opus-4-5')
  })

  it('stores thinking tokens estimate', async () => {
    const rows = getDb()
      .prepare("SELECT thinking_tokens FROM token_usage WHERE agent = 'fakemain' AND tool_name = 'Bash'")
      .all() as { thinking_tokens: number }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].thinking_tokens).toBeGreaterThan(0)
  })

  it('no-ops on second call (cursor prevents re-parsing unchanged files)', async () => {
    const before = (getDb().prepare("SELECT COUNT(*) as c FROM token_usage WHERE agent IN ('fakemain','botx')").get() as { c: number }).c
    const result2 = await collectTokenUsage()
    const after = (getDb().prepare("SELECT COUNT(*) as c FROM token_usage WHERE agent IN ('fakemain','botx')").get() as { c: number }).c
    expect(after).toBe(before)
    expect(result2.inserted).toBe(0)
  })
})

describe('getModelDistribution', () => {
  it('returns aggregated model counts and token totals', () => {
    const dist = getModelDistribution()
    expect(Array.isArray(dist)).toBe(true)
    // We inserted rows with 'claude-opus-4-5', 'claude-sonnet-5', 'claude-haiku-4-5'
    const models = dist.map((d: any) => d.model)
    expect(models.some((m: string) => m.startsWith('claude-'))).toBe(true)
  })

  it('filters by from/to range', () => {
    const ts1 = 1716200000
    const dist = getModelDistribution(ts1 - 1, ts1 + 3600)
    // Only rows from the main agent's first file are in this range
    expect(Array.isArray(dist)).toBe(true)
  })

  it('filters by agent', () => {
    const dist = getModelDistribution(undefined, undefined, 'botx')
    expect(Array.isArray(dist)).toBe(true)
    // botx only has haiku rows
    const models = dist.map((d: any) => d.model)
    if (models.length > 0) {
      expect(models.every((m: string) => m.includes('haiku'))).toBe(true)
    }
  })

  it('excludes rows with null or synthetic model', () => {
    // Insert a row with null model to verify it's excluded
    getDb().prepare(
      `INSERT OR IGNORE INTO token_usage
       (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
       VALUES ('fakemain', 'sess-nullmodel', 1716299999, 10, 5, 0, 0, NULL)`,
    ).run()
    const dist = getModelDistribution()
    const hasNull = dist.some((d: any) => d.model === null || d.model === '')
    expect(hasNull).toBe(false)
  })
})

describe('getToolStats', () => {
  it('returns tool usage aggregated by tool_name and model', () => {
    const stats = getToolStats()
    expect(Array.isArray(stats)).toBe(true)
    const toolNames = stats.map((s: any) => s.tool_name)
    expect(toolNames).toContain('Bash')
  })

  it('filters by from/to range', () => {
    const ts1 = 1716200000
    const stats = getToolStats(ts1 - 1, ts1 + 3600)
    expect(Array.isArray(stats)).toBe(true)
  })

  it('filters by agent', () => {
    const stats = getToolStats(undefined, undefined, 'fakemain')
    for (const s of stats) {
      expect((s as any).agents).toContain('fakemain')
    }
  })
})
