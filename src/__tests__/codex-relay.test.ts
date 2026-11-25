import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexRelayDir, codexRelayFilesystemEntries, renderCodexConfig, renderCodexOverrides, scaffoldCodexHome } from '../web/agent-engine.js'
import { readAgentEngineConfig, AGENTS_BASE_DIR } from '../web/agent-config.js'

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const MCP_SHIM_MJS = fileURLToPath(new URL('../../scripts/codex-relay/mcp-shim.mjs', import.meta.url))
const SHIM_PATH_SUFFIX = join('scripts', 'codex-relay', 'mcp-shim.mjs')

// The inherited dashboard MCP server as it arrives from .mcp.json: the seat
// form carries the token as a literal, the overrides form forwards it through
// env_vars (a literal credential-shaped name is refused on argv).
const dashboardServerSeat = {
  command: 'node',
  args: ['dist/dashboard-mcp.js'],
  env: {
    MARVEEN_DASHBOARD_TOKEN: '/store/agent-tokens/relay-agent.token',
    MARVEEN_DASHBOARD_URL: 'http://localhost:3420',
  },
}

const dashboardServerOverrides = {
  command: 'node',
  args: ['dist/dashboard-mcp.js'],
  env: {
    MARVEEN_DASHBOARD_TOKEN: '${MARVEEN_DASHBOARD_TOKEN}',
    MARVEEN_DASHBOARD_URL: '${MARVEEN_DASHBOARD_URL}',
  },
}

// A workspace path both renderers accept (overrides mode allows no '.').
const WORKSPACE = '/tmp/marveen-relay-ws'
const CODEX_HOME = '/tmp/marveen-relay-home'

describe('renderCodexConfig relay profile', () => {
  it('B3 renders the external spool and restricted sandbox with the shim', () => {
    const out = renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerSeat }, { profile: 'relay', codexHome: CODEX_HOME, agentName: 'relay-agent' })
    expect(out.startsWith([
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      'default_permissions = "marveen-relay"',
      'web_search = "disabled"',
      '',
      '[sandbox_workspace_write]',
      'network_access = false',
      'exclude_slash_tmp = true',
      'exclude_tmpdir_env_var = true',
      '',
      '[permissions.marveen-relay.filesystem]',
      ...codexRelayFilesystemEntries(WORKSPACE, CODEX_HOME).map(([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`),
      '',
      '[features]', 'apps = false', '',
      `[projects.${JSON.stringify(WORKSPACE)}]`,
      'trust_level = "trusted"',
      '',
      '[mcp_servers]',
    ].join('\n') + '\n')).toBe(true)
    expect(out).not.toContain('danger-full-access')
    expect(out).not.toContain('hide_full_access_warning')
    expect(out).not.toContain('writable_roots')
    // The shim entry: node + the mcp-shim script, nothing else in env.
    expect(out).toContain('command = "node"')
    expect(out).toMatch(new RegExp(`args = \\[.*${SHIM_PATH_SUFFIX.replaceAll('/', '\\/')}"\\]`))
    expect(out).toContain(`"MARVEEN_AGENT_NAME" = "relay-agent"`)
    expect(out).toContain(`"MARVEEN_RELAY_DIR" = ${JSON.stringify(codexRelayDir('relay-agent'))}`)
    // No token path and no dashboard URL anywhere in the rendered config.
    expect(out).not.toContain('MARVEEN_DASHBOARD_TOKEN')
    expect(out).not.toContain('MARVEEN_DASHBOARD_URL')
    expect(out).not.toContain('/store/agent-tokens')
    expect(out).not.toContain('localhost:3420')
  })

  it('replaces the forwarded-env dashboard entry too', () => {
    const out = renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerOverrides }, { profile: 'relay', codexHome: CODEX_HOME, agentName: 'relay-agent' })
    expect(out).toContain('"MARVEEN_AGENT_NAME" = "relay-agent"')
    expect(out).not.toContain('MARVEEN_DASHBOARD_TOKEN')
    expect(out).not.toContain('env_vars')
  })

  it('drops every other server entry', () => {
    const servers = {
      'marveen-dashboard': dashboardServerSeat,
      'other-server': { command: 'uvx', args: ['mcp-server-fetch'], env: { FETCH_TIMEOUT: '${FETCH_TIMEOUT}' } },
    }
    const out = renderCodexConfig(WORKSPACE, servers, { profile: 'relay', codexHome: CODEX_HOME, agentName: 'relay-agent' })
    expect(out).not.toContain('other-server')
    expect(out).not.toContain('uvx')
    expect(out).not.toContain('FETCH_TIMEOUT')
    expect(out).toContain('"MARVEEN_AGENT_NAME" = "relay-agent"')
    const overrides = renderCodexOverrides(WORKSPACE, servers, { profile: 'relay', codexHome: CODEX_HOME, agentName: 'relay-agent' })
    expect(overrides.some(line => line.includes('other-server'))).toBe(false)
  })
})

describe('renderCodexOverrides relay profile', () => {
  it('B3 renders the external spool and restricted sandbox as overrides', () => {
    // The seat-style entry (literal token path) would be REFUSED under the
    // existing validator in full-access mode; under relay it is replaced first,
    // so the rendering succeeds and no credential reaches argv.
    const overrides = renderCodexOverrides(WORKSPACE, { 'marveen-dashboard': dashboardServerSeat }, { profile: 'relay', codexHome: CODEX_HOME, agentName: 'relay-agent' })
    expect(overrides.slice(0, 10)).toEqual([
      'sandbox_mode="workspace-write"',
      'approval_policy="on-request"',
      'default_permissions="marveen-relay"',
      'web_search="disabled"',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      `permissions.marveen-relay.filesystem={${codexRelayFilesystemEntries(WORKSPACE, CODEX_HOME).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',')}}`,
      'features.apps=false',
      `projects.${WORKSPACE}.trust_level="trusted"`,
    ])
    expect(overrides.some(line => line.startsWith('notice.'))).toBe(false)
    expect(overrides.join('\n')).not.toContain('writable_roots')
    expect(overrides).toContain('mcp_servers.marveen-dashboard.command="node"')
    expect(overrides.some(line => line.startsWith('mcp_servers.marveen-dashboard.args=[') && line.includes(SHIM_PATH_SUFFIX))).toBe(true)
    expect(overrides).toContain('mcp_servers.marveen-dashboard.env.MARVEEN_AGENT_NAME="relay-agent"')
    expect(overrides).toContain(`mcp_servers.marveen-dashboard.env.MARVEEN_RELAY_DIR="${codexRelayDir('relay-agent')}"`)
    expect(overrides.some(line => line.includes('MARVEEN_DASHBOARD_TOKEN'))).toBe(false)
    expect(overrides.some(line => line.includes('MARVEEN_DASHBOARD_URL'))).toBe(false)
    expect(overrides.some(line => line.includes('notice.hide'))).toBe(false)
  })
})

describe('default rendering unchanged', () => {
  it('keeps full-access output byte-identical to f8893083 for both renderers', () => {
    // Golden strings from the full-access branches at f8893083.
    const servers = { 'marveen-dashboard': dashboardServerOverrides }
    const config = [
      'sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
      '', '[notice]', 'hide_full_access_warning = true', '',
      '[projects."/tmp/marveen-relay-ws"]', 'trust_level = "trusted"', '', '[mcp_servers]',
      '', '[mcp_servers."marveen-dashboard"]', 'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      'env_vars = ["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]', '',
    ].join('\n')
    const overrides = [
      'sandbox_mode="danger-full-access"', 'approval_policy="never"',
      'notice.hide_full_access_warning=true', 'projects./tmp/marveen-relay-ws.trust_level="trusted"',
      'mcp_servers.marveen-dashboard.command="node"',
      'mcp_servers.marveen-dashboard.args=["dist/dashboard-mcp.js"]',
      'mcp_servers.marveen-dashboard.env_vars=["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]',
    ]
    for (const opts of [undefined, { profile: 'full-access' as const, agentName: 'relay-agent' }]) {
      expect(renderCodexConfig(WORKSPACE, servers, opts)).toBe(config)
      expect(renderCodexOverrides(WORKSPACE, servers, opts)).toEqual(overrides)
    }
  })

  it('keeps today\'s seat output and does not replace the dashboard entry', () => {
    expect(() => renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerSeat }))
      .toThrow(/MARVEEN_DASHBOARD_TOKEN of server marveen-dashboard would be written into config.toml as a literal value/)
    const out = renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerOverrides })
    expect(out.startsWith('sandbox_mode = "danger-full-access"\napproval_policy = "never"\n')).toBe(true)
    expect(out).toContain('[notice]')
    expect(out).toContain('hide_full_access_warning = true')
    expect(out).toContain('env_vars = ["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]')
    expect(out).not.toContain('MARVEEN_AGENT_NAME')
  })

  it('keeps today\'s overrides output and does not replace the dashboard entry', () => {
    const overrides = renderCodexOverrides(WORKSPACE, { 'marveen-dashboard': dashboardServerOverrides })
    expect(overrides[0]).toBe('sandbox_mode="danger-full-access"')
    expect(overrides[1]).toBe('approval_policy="never"')
    expect(overrides).toContain('notice.hide_full_access_warning=true')
    expect(overrides).toContain('mcp_servers.marveen-dashboard.env_vars=["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]')
    expect(overrides.some(line => line.includes('MARVEEN_AGENT_NAME'))).toBe(false)
  })

  it('keeps the real dashboard entry under an explicit full-access profile too', () => {
    // Mutant guard (qwen round, card 2436459e): relayServers early-returns on
    // any non-relay profile, not only on omitted opts. An explicitly passed
    // { profile: 'full-access' } is what agent-scaffold feeds every default
    // codex agent, and it must not swap the dashboard entry for the shim.
    const opts = { profile: 'full-access' as const, agentName: 'some-agent' }
    expect(() => renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerSeat }, opts)).toThrow(/literal value/)
    const out = renderCodexConfig(WORKSPACE, { 'marveen-dashboard': dashboardServerOverrides }, opts)
    expect(out).toContain('env_vars = ["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]')
    expect(out).not.toContain('MARVEEN_AGENT_NAME')
    const overrides = renderCodexOverrides(WORKSPACE, { 'marveen-dashboard': dashboardServerOverrides }, opts)
    expect(overrides).toContain('mcp_servers.marveen-dashboard.env_vars=["MARVEEN_DASHBOARD_TOKEN","MARVEEN_DASHBOARD_URL"]')
    expect(overrides.some(line => line.includes('MARVEEN_AGENT_NAME'))).toBe(false)
  })
})

describe('relay profile requires the agent name', () => {
  const message = 'relay sandbox profile needs the agent name for the MCP shim entry'
  it('renderCodexConfig throws without an agentName', () => {
    expect(() => renderCodexConfig(WORKSPACE, {}, { profile: 'relay', codexHome: CODEX_HOME })).toThrow(message)
    expect(() => renderCodexConfig(WORKSPACE, {}, { profile: 'relay', codexHome: CODEX_HOME, agentName: '' })).toThrow(message)
  })
  it('renderCodexOverrides throws without an agentName', () => {
    expect(() => renderCodexOverrides(WORKSPACE, {}, { profile: 'relay', codexHome: CODEX_HOME })).toThrow(message)
    expect(() => renderCodexOverrides(WORKSPACE, {}, { profile: 'relay', codexHome: CODEX_HOME, agentName: '' })).toThrow(message)
  })
})

describe('B1 relay directory validation', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\0b'])('refuses agent name %j', agentName => {
    expect(codexRelayDir).toBeTypeOf('function')
    expect(() => codexRelayDir(agentName)).toThrow()
  })

})

// Spec §2 last bullet: scaffoldCodexHome accepts the same opts and passes them
// through -- this is the path the agent-scaffold call-site feeds, so a relay
// agent's seeded config/overrides must carry the sandbox and the shim entry,
// never the inherited dashboard token.
describe('scaffoldCodexHome relay profile', () => {
  it('seeds both identity forms with the relay sandbox and the shim entry', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scaffold-relay-'))
    mkdirSync(join(tmp, '.git')) // project root here: host /tmp state must not reach the relay project-config check
    const home = join(tmp, 'codex-home')
    const workspace = join(tmp, 'ws')
    mkdirSync(workspace)
    try {
      scaffoldCodexHome(home, workspace, { 'marveen-dashboard': dashboardServerSeat }, 'seat', { profile: 'relay', agentName: 'relay-agent' })
      const config = readFileSync(join(home, 'config.toml'), 'utf-8')
      expect(config).toContain('sandbox_mode = "workspace-write"')
      expect(config).toContain('network_access = false')
      expect(config).toContain('"MARVEEN_AGENT_NAME" = "relay-agent"')
      expect(config.includes('MARVEEN_DASHBOARD_TOKEN')).toBe(false)

      // Overrides rides on a shared seat, never on the seat-mode home rendered above (F4 refuses its permissions table).
      const sharedSeat = join(tmp, 'shared-seat')
      scaffoldCodexHome(sharedSeat, workspace, { 'marveen-dashboard': dashboardServerOverrides }, 'overrides', { profile: 'relay', agentName: 'relay-agent' })
      expect(existsSync(join(sharedSeat, 'config.toml'))).toBe(false)
      const overrides = readFileSync(join(workspace, '.codex-overrides'), 'utf-8')
      expect(overrides).toContain('sandbox_mode="workspace-write"')
      expect(overrides).toContain('sandbox_workspace_write.network_access=false')
      expect(overrides).toContain('mcp_servers.marveen-dashboard.env.MARVEEN_AGENT_NAME="relay-agent"')
      expect(overrides.includes('MARVEEN_DASHBOARD_TOKEN')).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---- helpers ----------------------------------------------------------------

// Resolves only once the probe returns a TRUTHY value: boolean probes built
// on existsSync return false while waiting, which is not a result.
async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function allFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allFilesUnder(path))
    else out.push(path)
  }
  return out
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

// ---- relay.mjs ---------------------------------------------------------------

describe('relay.mjs integration', () => {
  it('services valid requests, rejects invalid ones, keeps the token out of the relay dir, exits 0 on SIGTERM', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-test-'))
    const relayDir = join(work, 'relay')
    const tokenFile = join(work, 'agent.token') // lives OUTSIDE the relay dir
    const token = `tok-${randomBytes(16).toString('hex')}`
    writeFileSync(tokenFile, `${token}\n`)

    const received: Array<{ authorization?: string; method?: string; url?: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        received.push({ authorization: req.headers.authorization, method: req.method, url: req.url, body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, echo: req.url }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/` // trailing '/' on purpose

    const child = spawn(process.execPath, [RELAY_MJS,
      '--agent', 'relay-agent',
      '--relay-dir', relayDir,
      '--token-file', tokenFile,
      '--dashboard-url', dashboardUrl,
      '--audit-log', join(work, 'audit.log'), // outside the relay dir, like the host's store path
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let daemonOutput = ''
    child.stdout.on('data', chunk => { daemonOutput += chunk })
    child.stderr.on('data', chunk => { daemonOutput += chunk })

    try {
      await waitFor(() => existsSync(join(relayDir, 'relay.ready')))
      const requestsDir = join(relayDir, 'requests')
      const responsesDir = join(relayDir, 'responses')

      // Valid GET.
      writeFileSync(join(requestsDir, 'req-1.json'), JSON.stringify({ id: 'req-1', method: 'GET', path: '/api/kanban' }))
      const first = await waitFor(() => (existsSync(join(responsesDir, 'req-1.json')) ? readJson(join(responsesDir, 'req-1.json')) : null)) as { id: string; status: number; body: { ok: boolean; echo: string } }
      expect(first.id).toBe('req-1')
      expect(first.status).toBe(200)
      // The relay builds the upstream URL itself: the list is narrowed to the agent's own cards.
      expect(first.body).toEqual({ ok: true, echo: '/api/kanban?assignee=relay-agent' })
      expect(existsSync(join(requestsDir, 'req-1.json'))).toBe(false)
      expect(received[0].authorization).toBe(`Bearer ${token}`)
      expect(received[0].method).toBe('GET')
      expect(received[0].url).toBe('/api/kanban?assignee=relay-agent')

      // Valid POST with a body.
      writeFileSync(join(requestsDir, 'req-2.json'), JSON.stringify({ id: 'req-2', method: 'POST', path: '/api/memories', body: { agent_id: 'relay-agent', content: 'hello' } }))
      const second = await waitFor(() => (existsSync(join(responsesDir, 'req-2.json')) ? readJson(join(responsesDir, 'req-2.json')) : null)) as { status: number }
      expect(second.status).toBe(200)
      expect(existsSync(join(requestsDir, 'req-2.json'))).toBe(false)
      expect(received[received.length - 1].body).toBe(JSON.stringify({ agent_id: 'relay-agent', content: 'hello' }))

      // Invalid: path outside /api/.
      writeFileSync(join(requestsDir, 'bad-1.json'), JSON.stringify({ id: 'bad-1', method: 'GET', path: '/etc/passwd' }))
      const bad1 = await waitFor(() => (existsSync(join(responsesDir, 'bad-1.json')) ? readJson(join(responsesDir, 'bad-1.json')) : null)) as { id: string; status: number; error: string }
      expect(bad1).toEqual({ id: 'bad-1', status: 400, error: 'invalid request' })
      expect(existsSync(join(requestsDir, 'bad-1.json'))).toBe(false)

      // Invalid: '..' in the path.
      writeFileSync(join(requestsDir, 'bad-2.json'), JSON.stringify({ id: 'bad-2', method: 'GET', path: '/api/../store/secrets' }))
      const bad2 = await waitFor(() => (existsSync(join(responsesDir, 'bad-2.json')) ? readJson(join(responsesDir, 'bad-2.json')) : null)) as { id: string; status: number }
      expect(bad2.status).toBe(400)
      expect(bad2.id).toBe('bad-2')
      expect(existsSync(join(requestsDir, 'bad-2.json'))).toBe(false)

      // The token content must not leak into any file the sandbox can see,
      // nor into the daemon's stdout/stderr.
      for (const file of allFilesUnder(relayDir)) {
        expect(readFileSync(file, 'utf-8')).not.toContain(token)
      }
      expect(daemonOutput).not.toContain(token)
    } finally {
      child.kill('SIGTERM')
      const code = await exited(child)
      expect(code).toBe(0)
      expect(existsSync(join(relayDir, 'relay.ready'))).toBe(false)
      server.close()
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  it('exits 2 with usage on missing or unknown argv', async () => {
    for (const argv of [[], ['--agent', 'a'], ['--bogus', 'x']]) {
      const child = spawn(process.execPath, [RELAY_MJS, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      const code = await exited(child)
      expect(code).toBe(2)
      expect(stderr).toContain('usage:')
    }
  }, 15_000)
})

// ---- mcp-shim.mjs ------------------------------------------------------------

describe('mcp-shim.mjs integration', () => {
  it('lists the 8 tools and bridges a call through the relay files', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-shim-test-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const responsesDir = join(relayDir, 'responses')
    mkdirSync(requestsDir, { recursive: true })
    mkdirSync(responsesDir, { recursive: true })

    const child = spawn(process.execPath, [MCP_SHIM_MJS], {
      env: { MARVEEN_AGENT_NAME: 'shim-agent', MARVEEN_RELAY_DIR: relayDir },
    })
    let stdoutBuffer = ''
    const queue: unknown[] = []
    const waiters: Array<(message: unknown) => void> = []
    const drain = () => {
      while (queue.length && waiters.length) waiters.shift()!(queue.shift())
    }
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) {
          queue.push(JSON.parse(line))
          drain()
        }
      }
    })
    const nextMessage = () => new Promise<Record<string, unknown>>(resolve => {
      waiters.push(resolve as (message: unknown) => void)
      drain()
    })
    const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }

    try {
      const init = await (async () => {
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        return nextMessage()
      })()
      expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('marveen-dashboard-relay-shim')

      // A notification gets no response; the next frame must be id 2's answer.
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const listed = await nextMessage()
      expect((listed as { id: number }).id).toBe(2)
      const tools = (listed as { result: { tools: Array<{ name: string }> } }).result.tools
      expect(tools.map(tool => tool.name).sort()).toEqual([
        'marveen_daily_log_append',
        'marveen_inter_agent_message',
        'marveen_kanban_comment_post',
        'marveen_kanban_move',
        'marveen_kanban_query',
        'marveen_memory_retract',
        'marveen_memory_save',
        'marveen_memory_search',
      ])

      // Unknown tool -> -32601.
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'marveen_nope', arguments: {} } })
      const unknown = await nextMessage()
      expect((unknown as { error: { code: number; message: string } }).error.code).toBe(-32601)
      expect((unknown as { error: { code: number; message: string } }).error.message).toContain('Unknown tool')

      // A real call: the shim must drop a GET /api/kanban request file.
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'marveen_kanban_query', arguments: {} } })
      const requestFile = await waitFor(() => {
        const files = existsSync(requestsDir) ? readdirSync(requestsDir).filter(file => file.endsWith('.json')) : []
        return files.length ? join(requestsDir, files[0]) : null
      })
      const request = readJson(requestFile) as { id: string; method: string; path: string }
      expect(request.method).toBe('GET')
      expect(request.path).toBe('/api/kanban')
      expect(request.id).toMatch(/^shim-/)

      // Answer it the way the relay daemon would.
      writeFileSync(join(responsesDir, `${request.id}.json`), JSON.stringify({ id: request.id, status: 200, body: { ok: true } }))
      const callResult = await nextMessage()
      expect((callResult as { id: number }).id).toBe(4)
      const result = (callResult as { result: { content: Array<{ type: string; text: string }> } }).result
      expect(result.content[0].text).toContain('"ok":true')
      // The shim consumes the response file.
      expect(existsSync(join(responsesDir, `${request.id}.json`))).toBe(false)
    } finally {
      child.kill()
      await exited(child)
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)

  it('forwards allow_duplicate only when explicitly true (memory save)', async () => {
    // Mutant guard (qwen round 4, card 2436459e): the memory-save handler's
    // allowlist guard `if (a.allow_duplicate === true) body.allow_duplicate = true`
    // had no test. A flipped or dropped guard would silently send
    // allow_duplicate:true for callers who never asked (disabling the server's
    // duplicate protection) or drop it for callers who explicitly set it
    // (their genuinely-new memory gets refused as a duplicate again).
    const work = mkdtempSync(join(tmpdir(), 'marveen-shim-allowdup-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const responsesDir = join(relayDir, 'responses')
    mkdirSync(requestsDir, { recursive: true })
    mkdirSync(responsesDir, { recursive: true })

    const child = spawn(process.execPath, [MCP_SHIM_MJS], {
      env: { MARVEEN_AGENT_NAME: 'shim-agent', MARVEEN_RELAY_DIR: relayDir },
    })
    let stdoutBuffer = ''
    const queue: unknown[] = []
    const waiters: Array<(message: unknown) => void> = []
    const drain = () => {
      while (queue.length && waiters.length) waiters.shift()!(queue.shift())
    }
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) {
          queue.push(JSON.parse(line))
          drain()
        }
      }
    })
    const nextMessage = () => new Promise<Record<string, unknown>>(resolve => {
      waiters.push(resolve as (message: unknown) => void)
      drain()
    })
    const send = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }

    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      const init = await nextMessage()
      expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('marveen-dashboard-relay-shim')

      // The shim never removes its own request files (the daemon does), so
      // every round must wait for a file no earlier round has consumed.
      const seen = new Set<string>()
      const requestIds: string[] = []
      const memorySaveRound = async (callId: number, args: Record<string, unknown>) => {
        send({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: 'marveen_memory_save', arguments: args } })
        const requestFile = await waitFor(() => {
          const files = existsSync(requestsDir) ? readdirSync(requestsDir).filter(file => file.endsWith('.json')) : []
          const fresh = files.map(file => join(requestsDir, file)).find(path => !seen.has(path))
          return fresh ?? null
        })
        seen.add(requestFile)
        const request = readJson(requestFile) as { id: string; method: string; path: string; body: Record<string, unknown> }
        expect(request.method).toBe('POST')
        expect(request.path).toBe('/api/memories')
        expect(request.id).toMatch(/^shim-/)
        requestIds.push(request.id)
        // Answer it the way the relay daemon would.
        writeFileSync(join(responsesDir, `${request.id}.json`), JSON.stringify({ id: request.id, status: 200, body: { ok: true } }))
        const callResult = await nextMessage()
        expect((callResult as { id: number }).id).toBe(callId)
        const result = (callResult as { result: { content: Array<{ type: string; text: string }> } }).result
        expect(result.content[0].text).toContain('"ok":true')
        expect(existsSync(join(responsesDir, `${request.id}.json`))).toBe(false)
        return request.body
      }

      // Omitted allow_duplicate -> nothing beyond the forced identity in the body.
      const first = await memorySaveRound(2, { content: 'allowdup-guard-probe-1' })
      expect(first).toEqual({ agent_id: 'shim-agent', content: 'allowdup-guard-probe-1' })

      // Explicit false is not explicit true -> still no allow_duplicate key.
      const second = await memorySaveRound(3, { content: 'allowdup-guard-probe-2', allow_duplicate: false })
      expect(second).not.toHaveProperty('allow_duplicate')

      // Explicit true -> forwarded as true.
      const third = await memorySaveRound(4, { content: 'allowdup-guard-probe-3', allow_duplicate: true })
      expect(third).toEqual({ agent_id: 'shim-agent', content: 'allowdup-guard-probe-3', allow_duplicate: true })

      // Request ids are unique per call, so every round dropped its own file.
      expect(new Set(requestIds).size).toBe(3)
    } finally {
      child.kill()
      await exited(child)
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)
})

// ---- agent-config ------------------------------------------------------------

describe('readAgentEngineConfig codexSandbox', () => {
  const name = `relay-cfg-${process.pid}-${randomBytes(4).toString('hex')}`
  const dir = join(AGENTS_BASE_DIR, name)
  const homes: string[] = []

  const writeConfig = (config: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
  }
  const newCodexHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'marveen-codex-home-'))
    homes.push(home)
    return home
  }

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const home of homes) rmSync(home, { recursive: true, force: true })
    // Drop the agents/ root too when this run created it (ENOTEMPTY = a real
    // install already had agents; leave those alone).
    try { rmdirSync(AGENTS_BASE_DIR) } catch { /* not empty or absent */ }
  })

  it("parses 'relay' for a codex agent", () => {
    writeConfig({ engine: 'codex', codexConfigDir: newCodexHome(), codexSandbox: 'relay' })
    expect(readAgentEngineConfig(name).codexSandbox).toBe('relay')
  })

  it("defaults to 'relay' when the field is absent", () => {
    writeConfig({ engine: 'codex', codexConfigDir: newCodexHome() })
    expect(readAgentEngineConfig(name).codexSandbox).toBe('relay')
  })

  it("throws on any other value, naming the agent", () => {
    writeConfig({ engine: 'codex', codexConfigDir: newCodexHome(), codexSandbox: 'banana' })
    expect(() => readAgentEngineConfig(name)).toThrow(`agent ${name}: codexSandbox must be 'full-access' or 'relay'`)
  })

  it("throws when 'relay' is set on a claude agent", () => {
    writeConfig({ codexSandbox: 'relay' })
    expect(() => readAgentEngineConfig(name)).toThrow(`agent ${name}: codexSandbox requires engine 'codex'`)
  })
})
