// TEAMTAGLINE1102: a short "what it does" line under each agent in the team graph.
//
// The owner asked (2026-11-02) to see at a glance what each agent does on the
// Overview team graph: the node showed only the name and leader/member, so with
// eight agents he kept a separate note to remember who "Aladár" is. The CLAUDE.md
// description is a full sentence and does not fit a node. The tagline is a
// top-level agent-config.json key (like displayName), edited on the agent's Team
// tab, returned by /api/team/graph, and shown in place of the role line.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const SANDBOX = mkdtempSync(join(tmpdir(), 'tagline-'))
const AGENTS = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { readAgentTagline, AGENT_TAGLINE_MAX } = await import('../web/agent-config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
type Ctx = Parameters<typeof tryHandleAgents>[0]

async function call(path: string, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) out.body = JSON.parse(chunk.toString()) as Record<string, unknown> },
  }
  const req = body === undefined
    ? { headers: {} }
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} })
  const url = new URL(`http://localhost:3420${path}`)
  // The owner's browser login: these routes need the owner (OWNERGATE2-1104); the gate itself is owner-gate-round2.test.ts.
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' } } as unknown as Ctx
  expect(await tryHandleAgents(ctx, join(SANDBOX, 'web'))).toBe(true)
  return out
}

const cfgPath = (name: string) => join(AGENTS, name, 'agent-config.json')
const readCfg = (name: string) => JSON.parse(readFileSync(cfgPath(name), 'utf-8')) as Record<string, unknown>

beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(join(AGENTS, 'aladar'), { recursive: true })
  mkdirSync(join(AGENTS, 'juli'), { recursive: true })
  writeFileSync(cfgPath('aladar'), JSON.stringify({ displayName: 'Aladár', tagline: '  P+R  ', team: { role: 'member', reportsTo: null } }))
  writeFileSync(cfgPath('juli'), JSON.stringify({ displayName: 'Juli', team: { role: 'member', reportsTo: null } }))
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('agent tagline', () => {
  it('reads trimmed, empty when unset', () => {
    expect(readAgentTagline('aladar')).toBe('P+R')
    expect(readAgentTagline('juli')).toBe('')
  })

  it('the team graph carries it per node', async () => {
    const { status, body } = await call('/api/team/graph', 'GET')
    expect(status).toBe(200)
    const nodes = (body!.nodes as Array<{ id: string; tagline?: string }>)
    expect(nodes.find((n) => n.id === 'aladar')?.tagline).toBe('P+R')
    expect(nodes.find((n) => n.id === 'juli')?.tagline).toBe('')
  })

  it('PUT team writes it beside the team block, without touching other keys', async () => {
    const { status, body } = await call('/api/agents/juli/team', 'PUT', { role: 'member', tagline: 'JIRA ügyintéző' })
    expect(status).toBe(200)
    expect(body!.tagline).toBe('JIRA ügyintéző')
    const cfg = readCfg('juli')
    expect(cfg.tagline).toBe('JIRA ügyintéző')
    expect(cfg.displayName).toBe('Juli')
    const got = await call('/api/agents/juli/team', 'GET')
    expect(got.body!.tagline).toBe('JIRA ügyintéző')
  })

  it('an empty string removes it; a PUT without the key leaves it alone', async () => {
    await call('/api/agents/aladar/team', 'PUT', { role: 'member' })
    expect(readCfg('aladar').tagline).toBe('  P+R  ')
    await call('/api/agents/aladar/team', 'PUT', { role: 'member', tagline: '   ' })
    expect('tagline' in readCfg('aladar')).toBe(false)
  })

  it('is capped, so a pasted paragraph cannot blow up the node', async () => {
    await call('/api/agents/juli/team', 'PUT', { role: 'member', tagline: 'x'.repeat(500) })
    expect(readAgentTagline('juli')).toHaveLength(AGENT_TAGLINE_MAX)
  })

  it('the graph node renders the tagline in place of the role line', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
    expect(app).toContain("${escapeHtml(tagline || roleLabel)}")
    expect(app).toContain("getElementById('editTeamTagline')")
    const html = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf-8')
    expect(html).toContain('id="editTeamTagline"')
  })
})
