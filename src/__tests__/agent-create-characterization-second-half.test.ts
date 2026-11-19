// AGENTCREATEPR2-1119: characterization of POST /api/agents AFTER the base writes, as it stands before the
// owner-session branch is lifted into createAgentFromSpec. agent-create-characterization.test.ts pins the refusals and
// the base writes; this file pins the rest, through the route: the personality generation (success, the template
// fallback with its sentinel, a file changed while it ran), the notice to the main agent about a skipped file, the
// fleet announcement (and that its failure costs nothing), and the response bodies.
//
// Behaviour only, so the same tests hold wherever the handler's body lives. The base writes are recorders, the agent
// directory is a temp folder, the LLM generators are controlled here, and the persona files are written for real into
// that folder (persona-write-guard and atomic-write are the real modules).
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  agentsRoot: '',
  generate: null as null | ((kind: 'claude' | 'soul', name: string) => Promise<string>),
  messages: [] as Array<[string, string, string]>,
  messageThrows: false,
  agents: [] as string[],
  running: new Set<string>(),
}))
h.agentsRoot = mkdtempSync(join(tmpdir(), 'agent-create-char2-'))
afterAll(() => { rmSync(h.agentsRoot, { recursive: true, force: true }) })

vi.mock('../web/agent-scaffold.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-scaffold.js')>()),
  scaffoldAgentDir: (name: string) => { mkdirSync(join(h.agentsRoot, name), { recursive: true }) },
  writeAgentSettingsFromProfile: () => {},
  generateClaudeMd: (name: string) => h.generate!('claude', name),
  generateSoulMd: (name: string) => h.generate!('soul', name),
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  agentDir: (name: string) => join(h.agentsRoot, name),
  writeAgentModel: () => {},
  writeAgentCustomProvider: () => {},
  writeAgentSecurityProfile: () => {},
  writeAgentDisplayName: () => {},
  listAgentNames: () => [...h.agents],
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: (name: string) => h.running.has(name),
}))
vi.mock('../web/context-guard-store.js', async (orig) => ({
  ...(await orig<typeof import('../web/context-guard-store.js')>()),
  seedContextGuardForNewAgent: () => {},
}))
vi.mock('../web/profiles.js', async (orig) => ({
  ...(await orig<typeof import('../web/profiles.js')>()),
  loadProfileTemplate: (id: string) => ({ loadedProfile: id }),
}))
vi.mock('../web/default-model-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/default-model-guard.js')>()),
  launchableInstallDefault: async () => 'claude-sonnet-5',
}))
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))
vi.mock('../db.js', async (orig) => ({
  ...(await orig<typeof import('../db.js')>()),
  createAgentMessage: (from: string, to: string, text: string) => {
    if (h.messageThrows) throw new Error('db busy')
    h.messages.push([from, to, text])
  },
}))

const { tryHandleAgents, PERSONALITY_PENDING_SENTINEL } = await import('../web/routes/agents.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')

let n = 0
const fresh = () => `charagent${n++}`
async function post(data: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify(data))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL('http://127.0.0.1:3420/api/agents')
  await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))
  return out
}
const file = (name: string, f: string) => join(h.agentsRoot, name, f)
const read = (name: string, f: string) => readFileSync(file(name, f), 'utf-8')
const announce = (name: string, description: string) => `Uj csapattag erkezett: ${name}. Leirasa: ${description}. Udv neki ha legkozelebb beszeltek!`

beforeEach(() => {
  h.generate = async (kind, name) => `GENERATED ${kind} ${name}`
  h.messages.length = 0
  h.messageThrows = false
  h.agents = []
  h.running = new Set()
})

describe('POST /api/agents after the base writes: the personality', () => {
  it('generation succeeds: both files hold the generated text, no sentinel, 200 { ok, name }', async () => {
    const name = fresh()
    const r = await post({ name, description: 'egy leírás', model: 'claude-sonnet-5' })
    expect(r).toEqual({ status: 200, body: { ok: true, name } })
    expect(read(name, 'CLAUDE.md')).toBe(`GENERATED claude ${name}`)
    expect(read(name, 'SOUL.md')).toBe(`GENERATED soul ${name}`)
    expect(existsSync(file(name, PERSONALITY_PENDING_SENTINEL))).toBe(false)
  })

  it('generation fails: the template lands, the sentinel holds the error, 200 with personalityPending, warning and detail', async () => {
    const name = fresh()
    h.generate = async () => { throw new Error('llm timeout') }
    const r = await post({ name, description: 'leírás X', model: 'claude-sonnet-5' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true, name, personalityPending: true,
      warning: 'Agent created with a template personality because generation failed. Edit CLAUDE.md and SOUL.md to replace it.',
      detail: 'llm timeout',
    })
    expect(read(name, 'CLAUDE.md')).toContain('leírás X')
    expect(read(name, 'CLAUDE.md')).toContain(`# ${name}`)
    expect(existsSync(file(name, 'SOUL.md'))).toBe(true)
    expect(read(name, PERSONALITY_PENDING_SENTINEL)).toMatch(/\nllm timeout\n$/)
  })

  it('a file changed while generation ran is left alone: the generated text goes to a sidecar, the main agent hears it, 200 with personalitySkipped', async () => {
    const name = fresh()
    h.generate = async (kind, nm) => {
      if (kind === 'claude') writeFileSync(file(nm, 'CLAUDE.md'), 'KÉZI TARTALOM')
      return `GENERATED ${kind} ${nm}`
    }
    const r = await post({ name, description: 'd', model: 'claude-sonnet-5' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.name).toBe(name)
    expect(r.body.personalitySkipped).toHaveLength(1)
    expect(r.body.personalitySkipped[0].file).toBe('CLAUDE.md')
    const sidecar = r.body.personalitySkipped[0].generatedPath as string
    expect(readFileSync(sidecar, 'utf-8')).toBe(`GENERATED claude ${name}`)
    expect(read(name, 'CLAUDE.md')).toBe('KÉZI TARTALOM')
    expect(read(name, 'SOUL.md')).toBe(`GENERATED soul ${name}`)
    const notice = h.messages.filter(([, to, text]) => to === MAIN_AGENT_ID && text.includes('NEM írta felül'))
    expect(notice).toHaveLength(1)
    expect(notice[0][0]).toBe('system')
    expect(notice[0][2]).toContain(`Az új ügynök (${name})`)
    expect(notice[0][2]).toContain(`CLAUDE.md (a generált változat: ${sidecar})`)
  })
})

describe('POST /api/agents after the base writes: the fleet announcement', () => {
  it('goes from system to the main agent and every running agent except the new one, in that order', async () => {
    const name = fresh()
    h.agents = ['alfa', name, 'beta', 'gamma']
    h.running = new Set(['alfa', name, 'gamma'])
    await post({ name, description: 'leírás', model: 'claude-sonnet-5' })
    expect(h.messages).toEqual([
      ['system', MAIN_AGENT_ID, announce(name, 'leírás')],
      ['system', 'alfa', announce(name, 'leírás')],
      ['system', 'gamma', announce(name, 'leírás')],
    ])
  })

  it('also on the template path, with the same text', async () => {
    const name = fresh()
    h.generate = async () => { throw new Error('x') }
    await post({ name, description: 'd2', model: 'claude-sonnet-5' })
    expect(h.messages).toEqual([['system', MAIN_AGENT_ID, announce(name, 'd2')]])
  })

  it('a failed announcement costs nothing: the agent stays, the answer is still 200 { ok, name }', async () => {
    const name = fresh()
    h.messageThrows = true
    const r = await post({ name, description: 'd', model: 'claude-sonnet-5' })
    expect(r).toEqual({ status: 200, body: { ok: true, name } })
    expect(read(name, 'CLAUDE.md')).toBe(`GENERATED claude ${name}`)
  })
})
