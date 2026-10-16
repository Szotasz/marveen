import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SHAREDENVCOPY: the binding. The agent card reads /api/agents, so the
// summary row must carry what sharedEnvAuthKeysCopiedTo says for THAT agent.
let SANDBOX = ''
const h = vi.hoisted(() => ({ asked: [] as string[] }))
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name), listAgentNames: () => ['ag1', 'ag2'] }
})
vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    capturePane: () => null,
    sharedEnvAuthKeysCopiedTo: (name: string) => { h.asked.push(name); return name === 'ag1' ? ['ANTHROPIC_BASE_URL'] : [] },
  }
})

const { listAgentSummaries } = await import('../web/routes/agents.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sharedenvsum-'))
  mkdirSync(join(SANDBOX, 'agents', 'ag1'), { recursive: true })
  mkdirSync(join(SANDBOX, 'agents', 'ag2'), { recursive: true })
  h.asked.length = 0
})
afterEach(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

it('each summary row carries its own agent\'s shared-env auth key names', () => {
  const rows = listAgentSummaries()
  expect(rows.map((r) => [r.name, r.sharedEnvAuthKeys])).toEqual([['ag1', ['ANTHROPIC_BASE_URL']], ['ag2', []]])
  expect(h.asked).toEqual(['ag1', 'ag2'])
})
