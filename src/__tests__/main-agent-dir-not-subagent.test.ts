// MAINGHOST1024: a directory named after the main agent is not a sub-agent.
//
// The owner reported (Slack, 2026-10-24) that the dashboard's team graph had
// shown Marveen as a stopped member for weeks. Measured on the live host:
// GET /api/team/graph returned TWO 'marveen' nodes, the main one (role main,
// running) and a member (running false) coming from agents/marveen, a folder of
// old drafts. listAgentNames() took the folder for an agent, and the graph's
// byId kept the later, false node. The same listing fed /api/agents (a
// 'marveen' draft row) and every other consumer, and DELETE /api/agents/marveen
// would have removed the folder and stripped the main agent from every team.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'mainghost-'))
const AGENTS = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { listAgentNames, listAllAgentNames } = await import('../web/agent-config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
type Ctx = Parameters<typeof tryHandleAgents>[0]

async function call(path: string, method: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) out.body = JSON.parse(chunk.toString()) as Record<string, unknown> },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} }, res, path: url.pathname, method, url } as unknown as Ctx
  expect(await tryHandleAgents(ctx, join(SANDBOX, 'web'))).toBe(true)
  return out
}

beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true })
  // The live shape: the stray main-named folder holds an old owner-decision note.
  mkdirSync(join(AGENTS, 'marveen', 'drafts'), { recursive: true })
  writeFileSync(join(AGENTS, 'marveen', 'SZABI-DONTESEK.md'), 'old notes\n')
  mkdirSync(join(AGENTS, 'samu'), { recursive: true })
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('agents/<MAIN_AGENT_ID> is not a sub-agent', () => {
  it('neither listing returns it', () => {
    expect(listAgentNames()).toEqual(['samu'])
    expect(listAllAgentNames()).toEqual(['samu'])
  })

  it('the team graph has one main node, running', async () => {
    const { status, body } = await call('/api/team/graph', 'GET')
    expect(status).toBe(200)
    const nodes = body?.nodes as Array<{ id: string; role: string; running?: boolean }>
    const main = nodes.filter((n) => n.id === 'marveen')
    expect(main).toEqual([expect.objectContaining({ role: 'main', running: true })])
    // Positive control: the real sub-agent beside it is still listed.
    expect(nodes.map((n) => n.id)).toContain('samu')
  })

  it('DELETE refuses the main agent and keeps the folder', async () => {
    const { status } = await call('/api/agents/marveen', 'DELETE')
    expect(status).toBe(400)
    expect(existsSync(join(AGENTS, 'marveen', 'SZABI-DONTESEK.md'))).toBe(true)
  })
})
