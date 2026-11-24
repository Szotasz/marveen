// AGENTCREATEPR2B-1119: the behaviour of POST /api/connectors/:name/assign as it is today, pinned before its lookup and
// its per-agent write move into functions the agent-create consumer can call (the route keeps the owner gate and
// calls them). Owner session, real .mcp.json files of test-named agents (removed afterwards); the connector names are
// test-only, so the install's own .mcp.json and ~/.claude.json (read, never written) cannot match them.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { initDatabase } = await import('../db.js')
const { tryHandleConnectors, findConnectorConfigWithSource } = await import('../web/routes/connectors.js')
const { agentDir } = await import('../web/agent-config.js')

const T = '__test-mcpchar-t'   // target
const S = '__test-mcpchar-s'   // holds the server config
const V = '__test-mcpchar-v'   // visible, not a target, has the server
const DIRS = [T, S, V].map((n) => agentDir(n))
const SRV = '__mcpchar-srv'
const CFG = { command: 'true', args: ['--x'], env: { K: 'v' } }

async function assign(name: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const path = `/api/connectors/${encodeURIComponent(name)}/assign`
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleConnectors({ req, res, path, method: 'POST', url, auth: { kind: 'session' } } as any)).toBe(true)
  return { status: out.status || 200, body: out.body }
}
const mcp = (n: string) => { const p = join(agentDir(n), '.mcp.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null }
const seed = (n: string, servers: object | null) => {
  mkdirSync(agentDir(n), { recursive: true })
  writeFileSync(join(agentDir(n), 'CLAUDE.md'), `# ${n}\n`)
  if (servers) writeFileSync(join(agentDir(n), '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2))
}

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true })
  seed(T, { keep: { command: 'keep' } })
  seed(S, { [SRV]: CFG })
  seed(V, { [SRV]: CFG, other: { command: 'o' } })
})
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })

describe('POST /api/connectors/:name/assign today', () => {
  it('copies the config found in another agent into each target, keeping the target\'s other servers', async () => {
    expect(await assign(SRV, { agents: [T] })).toEqual({ status: 200, body: { ok: true } })
    expect(mcp(T)).toEqual({ mcpServers: { keep: { command: 'keep' }, [SRV]: CFG } })
    expect(mcp(V).mcpServers[SRV]).toEqual(CFG) // no allAgents: nobody else is touched
  })
  it('a target without a .mcp.json gets one', async () => {
    rmSync(join(agentDir(T), '.mcp.json'))
    await assign(SRV, { agents: [T] })
    expect(mcp(T)).toEqual({ mcpServers: { [SRV]: CFG } })
  })
  it('allAgents: a visible agent that is not a target loses the server, its other servers stay', async () => {
    await assign(SRV, { agents: [T], allAgents: [T, V] })
    expect(mcp(V)).toEqual({ mcpServers: { other: { command: 'o' } } })
    expect(mcp(T).mcpServers[SRV]).toEqual(CFG)
  })
  it('unknown and path-like target names are dropped, never written', async () => {
    expect((await assign(SRV, { agents: ['__test-mcpchar-none', '../../tmp/evil', T] })).status).toBe(200)
    expect(existsSync(agentDir('__test-mcpchar-none'))).toBe(false)
    expect(mcp(T).mcpServers[SRV]).toEqual(CFG)
  })
  it('an unknown connector: 404, nothing written', async () => {
    const before = JSON.stringify(mcp(T))
    expect(await assign('__mcpchar-none', { agents: [T] })).toEqual({ status: 404, body: { error: 'Connector not found' } })
    expect(JSON.stringify(mcp(T))).toBe(before)
  })
  it('a plugin: connector is global: ok with a note, nothing written', async () => {
    const before = JSON.stringify(mcp(T))
    const r = await assign('plugin:x', { agents: [T] })
    expect(r).toEqual({ status: 200, body: { ok: true, note: 'plugin:* connectors are global to every agent -- nothing to assign.' } })
    expect(JSON.stringify(mcp(T))).toBe(before)
  })
})

// Dani #2940 n1: the agent-create spec shows where a server's config came from, and whether an agent can write that
// file (an agent's projects/<p> list is not behind the install-file gate; its own list is).
describe('findConnectorConfigWithSource', () => {
  const LIST = '.mcp.json'
  it('a server in an agent\'s own list: that file, not agent-writable', () => {
    expect(findConnectorConfigWithSource(SRV)).toEqual({ config: CFG, source: `agents/${S}/${LIST}`, agentWritable: false })
  })
  it('a server only in an agent\'s projects/<p> list: that file, agent-writable', () => {
    const P = '__mcpchar-projonly'
    mkdirSync(join(agentDir(S), 'projects', 'p1'), { recursive: true })
    writeFileSync(join(agentDir(S), 'projects', 'p1', LIST), JSON.stringify({ mcpServers: { [P]: { command: 'p' } } }))
    expect(findConnectorConfigWithSource(P)).toEqual({ config: { command: 'p' }, source: `agents/${S}/projects/p1/${LIST}`, agentWritable: true })
  })
  it('an unknown server: null', () => { expect(findConnectorConfigWithSource('__mcpchar-none')).toBeNull() })
})
