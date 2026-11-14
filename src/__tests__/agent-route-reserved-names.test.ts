// AGENTROUTERESERVED1114: the agents API serves a few FIXED first path segments itself
// (GET /api/agents/activity, GET /api/agents/status, POST /api/agents/model-suggest,
// GET /api/agents/export-all, POST /api/agents/import), and they are matched before the
// generic /api/agents/:name routes. An agent with one of those names could be created
// (the create route refused only the message layer's ids), and its own
// /api/agents/<name> address was then answered by the fixed handler instead.
//
// Three things are pinned here:
//   1. the create route refuses each of those names, before anything is created;
//   2. the reserved list and the source agree: every fixed first segment under
//      /api/agents/ in the server source is in AGENT_ROUTE_RESERVED_IDS, and nothing
//      else is (a sixth fixed route added later turns this red until it is listed);
//   3. which readers of the reserved list take the route names, and which one
//      deliberately does not (the voice channel id is a sender, not an API address).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Nothing is ever created by this file: the scaffold is replaced by a marker that
// throws, so "the request got as far as creating the agent" is observable and harmless.
const scaffoldAgentDir = vi.fn((name: string): never => { throw new Error(`SCAFFOLD_REACHED:${name}`) })
vi.mock('../web/agent-scaffold.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-scaffold.js')>()),
  scaffoldAgentDir: (name: string) => scaffoldAgentDir(name),
}))
// The create route probes the installed CLI before the name checks; no process is spawned here.
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async () => ({ version: null }),
}))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT, RESERVED_AGENT_IDS, resolveVoiceChannelId } = await import('../config.js')
const { AGENT_ROUTE_RESERVED_IDS, MESSAGE_LAYER_RESERVED_AGENT_IDS, FIXED_RESERVED_AGENT_IDS, sanitizeAgentName } = await import('../web/sanitize.js')

// Literal on purpose: the list this file was written against, independent of the constant.
const FIXED_SEGMENTS = ['activity', 'status', 'model-suggest', 'export-all', 'import']

async function createAgent(name: string): Promise<{ status: number; body: any; reachedScaffold: boolean }> {
  scaffoldAgentDir.mockClear()
  const req = Readable.from([Buffer.from(JSON.stringify({ name, description: 'x', model: 'claude-opus-5' }))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL('http://127.0.0.1:3420/api/agents')
  try {
    await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))
  } catch (err) {
    if (!String((err as Error)?.message).startsWith('SCAFFOLD_REACHED:')) throw err
  }
  return { status: out.status, body: out.body, reachedScaffold: scaffoldAgentDir.mock.calls.length > 0 }
}

describe('POST /api/agents refuses the fixed route names', () => {
  beforeEach(() => { scaffoldAgentDir.mockClear() })

  it('positive control: an ordinary new name gets as far as the scaffold', async () => {
    const name = 'test-route-reserved-control-zz'
    expect(existsSync(agentDir(name))).toBe(false)
    const r = await createAgent(name)
    expect(r.reachedScaffold).toBe(true)
    expect(scaffoldAgentDir.mock.calls[0][0]).toBe(name)
    expect(existsSync(agentDir(name))).toBe(false)
  })

  for (const name of FIXED_SEGMENTS) {
    it(`"${name}" is a 409, and nothing is created`, async () => {
      // Not already an agent here: the 409 below must come from the reservation, not from "already exists".
      expect(existsSync(agentDir(name))).toBe(false)
      const r = await createAgent(name)
      expect(r.reachedScaffold).toBe(false)
      expect(r.status).toBe(409)
      expect(r.body).toEqual({ error: 'Name is reserved by the system' })
    })
  }

  it('the spellings that sanitize to a fixed route name are refused too', async () => {
    for (const [typed, becomes] of [['Status', 'status'], ['  IMPORT ', 'import'], ['Export All', 'export-all'], ['model_suggest', 'modelsuggest'], ['Model Suggest', 'model-suggest']] as const) {
      expect(sanitizeAgentName(typed.trim())).toBe(becomes)
      const r = await createAgent(typed)
      if (FIXED_SEGMENTS.includes(becomes)) {
        expect([typed, r.status, r.reachedScaffold]).toEqual([typed, 409, false])
      } else {
        // "modelsuggest" is not a route: it is an ordinary name.
        expect([typed, r.reachedScaffold]).toEqual([typed, true])
      }
    }
  })
})

// Every non-test .ts file under src/, comments stripped line by line (a route named in a
// comment is not a route).
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) sourceFiles(p, acc)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}
function fixedFirstSegments(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  // 'path === "/api/agents/<seg>"' style literals (any quote), and '\/api\/agents\/<seg>' inside a regex literal.
  const literal = /['"`]\/api\/agents\/([A-Za-z0-9_-]+)(?=['"`/?])/g
  const inRegex = /\\\/api\\\/agents\\\/([A-Za-z0-9_-]+)/g
  for (const file of sourceFiles(join(PROJECT_ROOT, 'src'))) {
    const lines = readFileSync(file, 'utf-8').split('\n')
    lines.forEach((raw, i) => {
      const line = raw.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/\s.*$/, '')
      for (const rx of [literal, inRegex]) {
        for (const m of line.matchAll(rx)) {
          const where = `${file.slice(PROJECT_ROOT.length + 1)}:${i + 1}`
          found.set(m[1], [...(found.get(m[1]) ?? []), where])
        }
      }
    })
  }
  return found
}

describe('the reserved route names and the routes agree', () => {
  const found = fixedFirstSegments()

  it('the scan sees the five routes this file was written against', () => {
    for (const seg of FIXED_SEGMENTS) expect([seg, (found.get(seg) ?? []).length > 0]).toEqual([seg, true])
  })

  it('every fixed first segment under /api/agents/ is reserved, and nothing else is', () => {
    // Red with the file and line when a route is added without reserving its name.
    const unreserved = [...found].filter(([seg]) => !AGENT_ROUTE_RESERVED_IDS.includes(seg))
    expect(unreserved).toEqual([])
    expect([...AGENT_ROUTE_RESERVED_IDS].sort()).toEqual([...found.keys()].sort())
  })

  it('each reserved route name is a name the create route would otherwise accept', () => {
    for (const seg of AGENT_ROUTE_RESERVED_IDS) expect(sanitizeAgentName(seg)).toBe(seg)
  })
})

describe('who takes the route names', () => {
  it('the fixed list is the message layer ids followed by the route names, with no overlap', () => {
    expect([...FIXED_RESERVED_AGENT_IDS]).toEqual([...MESSAGE_LAYER_RESERVED_AGENT_IDS, ...AGENT_ROUTE_RESERVED_IDS])
    expect(new Set(FIXED_RESERVED_AGENT_IDS).size).toBe(FIXED_RESERVED_AGENT_IDS.length)
  })

  it('RESERVED_AGENT_IDS (create, bundle import, fleet import, main agent id) carries every route name', () => {
    for (const seg of FIXED_SEGMENTS) expect(RESERVED_AGENT_IDS).toContain(seg)
  })

  it('the voice channel id does NOT: it names a sender, and no /api/agents/<id> address exists for it', () => {
    const taken = { mainAgentId: 'marveen', ownerName: 'Owner', systemSenderIds: '', isSubAgent: () => false }
    // An install that already runs its voice lane under such an id keeps it.
    expect(resolveVoiceChannelId('status', taken)).toEqual({ id: 'status' })
    // The message layer's own ids stay refused, as before.
    expect(resolveVoiceChannelId('system', taken).id).not.toBe('system')
  })
})
