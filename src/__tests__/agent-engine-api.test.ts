import { afterAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const sandbox = mkdtempSync(join(resolve('.'), '.engine-api-'))
mkdirSync(join(sandbox, 'store'))
// Keep the relay's project walk inside this fixture, away from the host's .codex.
mkdirSync(join(sandbox, '.git'))
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(), PROJECT_ROOT: sandbox, STORE_DIR: join(sandbox, 'store'),
}))
vi.mock('../web/mcp-inheritance.js', async original => ({
  ...await original<typeof import('../web/mcp-inheritance.js')>(),
  readInheritableMcpServerNames: () => new Set(['dashboard']),
}))
// No dashboard login in this sandbox: the shared token is the first-run owner of the create gate (T17).
vi.mock('../db.js', async original => ({
  ...await original<typeof import('../db.js')>(), countDashboardUsers: () => 0,
}))
vi.mock('../web/agent-process.js', async original => ({
  ...await original<typeof import('../web/agent-process.js')>(),
  isAgentRunning: () => false, agentHasChannel: () => false,
}))
vi.mock('../web/agent-scaffold.js', async original => ({
  ...await original<typeof import('../web/agent-scaffold.js')>(),
  generateClaudeMd: async () => '# T generated\n',
  generateSoulMd: async () => '# soul\n',
}))
// Exercise both model gates without probing the host's Claude CLI.
vi.mock('../web/claude-cli-version.js', async original => ({
  ...await original<typeof import('../web/claude-cli-version.js')>(),
  measureClaudeCliVersion: async () => ({ version: null, measuredAt: 0, error: 'not probed in tests', source: 'probe' as const }),
}))
const { tryHandleAgents, listAgentSummaries } = await import('../web/routes/agents.js')
const { agentDir, readAgentEngineConfig } = await import('../web/agent-config.js')
const { scaffoldAgentDir } = await import('../web/agent-scaffold.js')
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

async function request(path: string, method: string, body: unknown, auth: RouteContext['auth'] = { kind: 'session' } as RouteContext['auth']): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  Object.assign(req, { headers: {}, url: path })
  const result = { status: 0, body: null as any }
  const res = {
    writeHead(status: number) { result.status = status; return res },
    end(chunk?: string) { if (chunk) result.body = JSON.parse(chunk) }, setHeader() {},
  }
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  await tryHandleAgents({ req, res, path, method, url: new URL(path, 'http://localhost'), auth } as unknown as RouteContext, sandbox)
  return result
}

it('T13 rejects inherited non-stdio MCP before creating an agent or CODEX_HOME', async () => {
  const rootMcp = join(sandbox, '.mcp.json')
  const before = existsSync(rootMcp) ? readFileSync(rootMcp) : undefined
  const home = join(sandbox, 'create-preflight-home')
  try {
    writeFileSync(rootMcp, JSON.stringify({ mcpServers: { dashboard: { url: 'http://127.0.0.1:9/mcp' } } }))
    // Explicit full-access: under the relay default an inherited server other than the dashboard is dropped, not rendered.
    const response = await request('/api/agents', 'POST', { name: 'pilot', description: 'x', engine: 'codex', codexConfigDir: home, codexSandbox: 'full-access' })
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('stdio')
    expect(existsSync(agentDir('pilot'))).toBe(false)
    expect(existsSync(home)).toBe(false)
  } finally {
    if (before === undefined) rmSync(rootMcp, { force: true })
    else writeFileSync(rootMcp, before)
  }
})

describe('engine API and scaffold wiring', () => {
  it('rejects invalid engines and channel bindings on creation before probing Claude', async () => {
    for (const config of [{ engine: 'gpt' }, { engine: 'codex' }, { engine: 'codex', codexConfigDir: join(sandbox, 'home'), slack: 'bound' }]) {
      const response = await request('/api/agents', 'POST', { name: 'pilot', description: 'Disposable pilot', ...config })
      expect(response.status).toBe(400)
      expect(existsSync(agentDir('pilot'))).toBe(false)
    }
  })
  it('accepts and persists Codex through PUT, scaffolds config and copies instructions', async () => {
    const dir = agentDir('pilot')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Disposable pilot\n')
    writeFileSync(join(sandbox, '.mcp.json'), JSON.stringify({ mcpServers: { dashboard: { command: 'node', args: ['dashboard.mjs'] } } }))
    const home = join(sandbox, 'codex-home')
    const response = await request('/api/agents/pilot', 'PUT', { engine: 'codex', codexConfigDir: home })
    expect(response.status).toBe(200)
    expect(readAgentEngineConfig('pilot')).toEqual({ engine: 'codex', codexConfigDir: home, codexIdentity: 'seat', codexSandbox: 'relay' })
    // relay is the default and is not persisted; the inherited non-dashboard server is not rendered.
    expect(JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'))).not.toHaveProperty('codexSandbox')
    const toml = readFileSync(join(home, 'config.toml'), 'utf-8')
    expect(toml).toContain('sandbox_mode = "workspace-write"')
    expect(toml).not.toContain('danger-full-access')
    expect(toml).not.toContain('[mcp_servers."dashboard"]')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# Disposable pilot\n')
  })
  it('rejects channel assignment on an existing Codex agent', async () => {
    const response = await request('/api/agents/pilot/channels/telegram', 'POST', {})
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('channel bindings')
  })
  it('rejects a binding stored under a provider other than the install default', async () => {
    const dir = agentDir('bound-pilot')
    const channelDir = join(dir, '.claude', 'channels', 'teams')
    mkdirSync(channelDir, { recursive: true })
    writeFileSync(join(channelDir, '.env'), 'TEAMS_BOT_APP_ID=fixture\n')
    const response = await request('/api/agents/bound-pilot', 'PUT', { engine: 'codex', codexConfigDir: join(sandbox, 'bound-home') })
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('channel bindings')
    expect(existsSync(join(dir, 'agent-config.json'))).toBe(false)
  })
  it('rejects invalid updates before writing instructions', async () => {
    const response = await request('/api/agents/pilot', 'PUT', { engine: 'gpt', claudeMd: 'overwrite' })
    expect(response.status).toBe(400)
    expect(readFileSync(join(agentDir('pilot'), 'CLAUDE.md'), 'utf-8')).toBe('# Disposable pilot\n')
  })
  it('keeps an imported engine visible while its machine-specific home needs configuration', () => {
    const dir = agentDir('imported-pilot')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ engine: 'codex' }))
    expect(readAgentEngineConfig('imported-pilot')).toEqual({ engine: 'codex', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'relay' })
  })
  it('leaves the scaffold unchanged for agents without engine configuration', () => {
    scaffoldAgentDir('legacy')
    expect(readAgentEngineConfig('legacy').engine).toBe('claude')
    expect(existsSync(join(agentDir('legacy'), '.claude', 'skills'))).toBe(true)
    expect(existsSync(join(agentDir('legacy'), 'AGENTS.md'))).toBe(false)
  })
})

it('T5 refuses invalid MCP before persisting any PUT fields or creating CODEX_HOME', async () => {
  const dir = agentDir('agent-a')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'agent-config.json')
  // The stored full-access opt-in is what makes the non-stdio server a refusal; under relay it would be dropped.
  const before = '{ "engine": "claude", "memoryIsolation": false, "codexSandbox": "full-access" }\n'
  writeFileSync(configPath, before)
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { dashboard: { url: 'http://127.0.0.1:9/mcp' } } }))
  const home = join(sandbox, 'preflight-home')
  const response = await request('/api/agents/agent-a', 'PUT', { engine: 'codex', codexConfigDir: home, memoryIsolation: true })
  expect(response.status).toBe(400)
  expect(response.body.error).toContain('stdio')
  expect(readFileSync(configPath, 'utf-8')).toBe(before)
  expect(existsSync(home)).toBe(false)
})

it('T10 lists both agents when one has an unknown engine', () => {
  for (const [name, config] of [['agent-a', '{"engine":"gpt"}'], ['agent-b', '{}']]) {
    const dir = agentDir(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), config)
  }
  expect(() => listAgentSummaries()).not.toThrow()
  const summaries = listAgentSummaries()
  expect(summaries.map(agent => agent.name)).toEqual(expect.arrayContaining(['agent-a', 'agent-b']))
  expect(summaries.find(agent => agent.name === 'agent-a')?.engine).toBe('claude')
})

it('T14 preflights inherited MCP when the existing agent has no MCP file', async () => {
  const dir = agentDir('agent-b')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'agent-config.json')
  // The stored full-access opt-in is what makes the non-stdio server a refusal; under relay it would be dropped.
  writeFileSync(configPath, '{ "engine": "claude", "memoryIsolation": false, "codexSandbox": "full-access" }\n')
  scaffoldAgentDir('agent-b')
  rmSync(join(dir, '.mcp.json'))
  const before = readFileSync(configPath)
  const rootMcp = join(sandbox, '.mcp.json')
  const rootBefore = existsSync(rootMcp) ? readFileSync(rootMcp) : undefined
  const home = join(sandbox, 'missing-mcp-preflight-home')
  try {
    writeFileSync(rootMcp, JSON.stringify({ mcpServers: { dashboard: { url: 'http://127.0.0.1:9/mcp' } } }))
    const response = await request('/api/agents/agent-b', 'PUT', { engine: 'codex', codexConfigDir: home })
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('stdio')
    expect(readFileSync(configPath)).toEqual(before)
    expect(existsSync(home)).toBe(false)
  } finally {
    if (rootBefore === undefined) rmSync(rootMcp, { force: true })
    else writeFileSync(rootMcp, rootBefore)
  }
})

it('T15 refuses remote hosts for Codex while allowing clearing and Claude remote hosts', async () => {
  const dir = agentDir('agent-a')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'agent-config.json')
  writeFileSync(configPath, JSON.stringify({ engine: 'codex', codexConfigDir: join(sandbox, 'remote-codex-home') }))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
  scaffoldAgentDir('agent-a')
  const before = readFileSync(configPath)
  const response = await request('/api/agents/agent-a/remote', 'PUT', { host: 'h1', workdir: '/w' })
  expect(response.status).toBe(400)
  expect(response.body.error).toBe('Codex pilot agents must run locally as the dashboard user')
  expect(readFileSync(configPath)).toEqual(before)
  expect((await request('/api/agents/agent-a/remote', 'PUT', { host: '', workdir: '' })).status).toBe(200)

  const claudeDir = agentDir('agent-b')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'agent-config.json'), '{ "engine": "claude" }\n')
  scaffoldAgentDir('agent-b')
  const claudeResponse = await request('/api/agents/agent-b/remote', 'PUT', { host: 'h1', workdir: '/w' })
  expect(claudeResponse.status).toBe(200)
})

it.each([
  { name: 'agent-a', config: { engine: 'claude', runAsUser: 'svc-user' } },
  { name: 'agent-b', config: { engine: 'claude', remoteHost: 'h1' } },
])('T16 refuses switching $name with existing execution settings to Codex before writing', async ({ name, config }) => {
  const dir = agentDir(name)
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'agent-config.json')
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
  const before = readFileSync(configPath)
  const home = join(sandbox, 't16-codex-home')
  rmSync(home, { recursive: true, force: true })
  const response = await request(`/api/agents/${name}`, 'PUT', { engine: 'codex', codexConfigDir: home })
  expect.soft(response.status).toBe(400)
  expect.soft(response.body.error).toBe('Codex pilot agents must run locally as the dashboard user')
  expect.soft(readFileSync(configPath)).toEqual(before)
  expect.soft(existsSync(home)).toBe(false)
})

it('T17 a Codex agent with codexSandbox full-access is created by the owner only; the relay default is not gated', async () => {
  const home = join(sandbox, 't17-codex-home')
  rmSync(home, { recursive: true, force: true })
  const token = { kind: 'token' } as RouteContext['auth']
  // The token passes the first-run create gate (no dashboard login in this sandbox), but not the full-access opt-in.
  const refused = await request('/api/agents', 'POST', { name: 't17-full', description: 'x', engine: 'codex', codexConfigDir: home, codexSandbox: 'full-access' }, token)
  expect(refused.status).toBe(403)
  expect(refused.body.code).toBe('owner_session_required')
  expect(refused.body.fields).toEqual(['codexSandbox'])
  expect(refused.body.error).toContain('removes the Codex sandbox')
  expect(refused.body.error).toContain('never asks for approval')
  expect(existsSync(agentDir('t17-full'))).toBe(false)
  expect(existsSync(home)).toBe(false)
  // Control: the same token without the opt-in reaches the next refusal (the empty name), so the gate above is the
  // full-access check and not the create gate.
  const relayDefault = await request('/api/agents', 'POST', { name: '', description: 'x', engine: 'codex', codexConfigDir: home }, token)
  expect(relayDefault.status).toBe(400)
  expect(relayDefault.body.fields).toBeUndefined()
  // The owner session passes the full-access check and reaches the same next refusal.
  const owner = await request('/api/agents', 'POST', { name: '', description: 'x', engine: 'codex', codexConfigDir: home, codexSandbox: 'full-access' })
  expect(owner.status).toBe(400)
  expect(owner.body.fields).toBeUndefined()
  expect(existsSync(home)).toBe(false)
})

it('T18 creates a Codex agent with persisted engine config and synchronized instructions', async () => {
  const dir = agentDir('t18-codex')
  const home = join(sandbox, 't18-codex-home')
  try {
    const response = await request('/api/agents', 'POST', { name: 't18-codex', description: 'x', engine: 'codex', codexConfigDir: home })
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    const configPath = join(dir, 'agent-config.json')
    expect(existsSync(configPath)).toBe(true)
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).engine).toBe('codex')
    expect(readAgentEngineConfig('t18-codex').engine).toBe('codex')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true)
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toBe('# T generated\n')
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(claudeMd)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

it('T19 creates a plain Claude agent without engine config or Codex instructions', async () => {
  const dir = agentDir('t19-claude')
  try {
    const response = await request('/api/agents', 'POST', { name: 't19-claude', description: 'x' })
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
    const configPath = join(dir, 'agent-config.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(Object.prototype.hasOwnProperty.call(config, 'engine')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(config, 'codexConfigDir')).toBe(false)
    expect(readAgentEngineConfig('t19-claude').engine).toBe('claude')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
