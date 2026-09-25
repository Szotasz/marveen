// #1533 review: the redact must sit ON the path into the DB, not only in the
// helper. This drives collectTokenUsage over a transcript whose only turn is a
// Bash tool_use carrying a (made-up) secret, then reads token_usage back: if
// the parser ever stores the raw input (JSON.stringify(toolInput), redact
// bypassed) or drops the preview, this goes red.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'

// hoisted: the vi.mock factories below run before the module body, and the
// static db.js import pulls config.js in at that point
const { FIXTURE, HOME, PROJECT_ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const FIXTURE = mkdtempSync(join(tmpdir(), 'token-usage-redact-'))
  return { FIXTURE, HOME: join(FIXTURE, 'home'), PROJECT_ROOT: '/Users/x/marveen' }
})
const MAIN_DIR = join(HOME, '.claude', 'projects', '-Users-x-marveen')
const SECRET = 'fakeTokenValue123456'

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [] }))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDirForRead: () => null }))
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => [join(HOME, '.claude')] }))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(MAIN_DIR, { recursive: true })
  writeFileSync(join(MAIN_DIR, 'sess-redact.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-redact',
    timestamp: '2026-09-24T10:00:00Z',
    message: {
      id: 'msg_redact',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', name: 'Bash', id: 'tu_1', input: { command: `export VALAMI_TOKEN="${SECRET}" && ./run.sh` } }],
    },
  }) + '\n')
})

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true })
})

describe('token-usage preview wiring goes through the redact', () => {
  it('stores the Bash command with the secret redacted', async () => {
    const { collectTokenUsage } = await import('../web/token-usage.js')
    const { inserted } = await collectTokenUsage()
    expect(inserted).toBe(1)

    const row = getDb().prepare(`SELECT content_preview, tool_name FROM token_usage WHERE session_id = 'sess-redact'`).get() as
      { content_preview: string | null; tool_name: string }
    expect(row.tool_name).toBe('Bash')
    // the preview is there (the wiring did not drop it) ...
    expect(row.content_preview).toContain('./run.sh')
    expect(row.content_preview).toContain('VALAMI_TOKEN="[REDACTED]')
    // ... and the secret is not
    expect(row.content_preview).not.toContain(SECRET)
  })
})
