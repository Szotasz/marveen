import { afterAll, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHANNEL_TOKEN_UNSET, preflightCodexHome, relayShimPath, renderCodexConfig, resolveAgentEngine, scaffoldCodexHome, validateAgentEngine } from '../web/agent-engine.js'
import { autoRestartSupportsEngine } from '../auto-restart.js'
import { contextGuardSupportsEngine } from '../context-guard.js'
import { detectPaneState, idleConsideringDimGhost } from '../pane-state.js'

const root = resolve('.')
const sandbox = mkdtempSync(join(root, '.engine-test-'))
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))
const home = join(sandbox, 'home')
const workspace = join(sandbox, 'workspace')
mkdirSync(workspace)
const script = join(root, 'scripts/codex-agent.sh')

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: vi.fn(fs.existsSync) }
})
// Getters, not values: agent-engine.ts now imports config.js statically, so
// this factory runs before the module body initializes `sandbox` above --
// evaluating it lazily keeps the consumers reading it at call time.
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(),
  get PROJECT_ROOT() { return sandbox }, get STORE_DIR() { return join(sandbox, 'store') },
}))


function binary(version: string): string {
  const path = join(sandbox, `codex-${version.replaceAll('.', '-')}`)
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli ${version}'; else env; fi\n`, { mode: 0o700 })
  return path
}
function compose(bin: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [script, home, workspace], {
    encoding: 'utf-8', env: { ...process.env, MARVEEN_CODEX_SANDBOX: undefined, MARVEEN_CODEX_BIN: bin, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('per-agent engine pilot', () => {
  it('B4-version refuses relay before 0.163.0 with the found version', () => {
    let message = ''
    try { compose(binary('0.162.9'), { MARVEEN_CODEX_SANDBOX: 'relay' }) } catch (err) { message = (err as Error).message }
    expect(message).toContain('Codex launch error: codexSandbox=relay requires codex >= 0.163.0 (found codex-cli 0.162.9)')
  })

  it.each([
    ['relay', '0.163.0'], ['relay', '1.0.0'], ['full-access', '0.150.0'], [undefined, '0.150.0'], ['', '0.150.0'],
  ])('B4-version composes sandbox=%s version=%s', (profile, version) => {
    const bin = binary(version!)
    expect(compose(bin, { MARVEEN_CODEX_SANDBOX: profile })).toContain(bin)
  })

  it('B4-version refuses an unknown sandbox value', () => {
    expect(() => compose(binary('0.163.0'), { MARVEEN_CODEX_SANDBOX: 'bogus' }))
      .toThrow('Codex launch error: unknown MARVEEN_CODEX_SANDBOX value: bogus')
  })

  it('golden Claude default preserves the original composed command and env byte for byte', () => {
    expect(resolveAgentEngine(undefined)).toBe('claude')
    expect(resolveAgentEngine('')).toBe('claude')
    expect(validateAgentEngine({})).toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
    const source = readFileSync(join(root, 'src/web/agent-process.ts'), 'utf-8')
    const expression = source.split('\n').find(line => line.trim().startsWith('const buildLaunchCmd ='))!.split('=> ')[1]
    const golden = JSON.parse(readFileSync(join(root, 'src/__tests__/fixtures/agent-engine/claude-command.json'), 'utf-8')).expression
    // The captured pre-change expression includes every env component and flag.
    const names = ['umaskPrefix', 'venvPathPrefix', 'unsetTokens', 'stateFence', 'autoUpdaterEnv', 'byoUnsetEnv', 'promptSuggestionEnv', 'mcpEnv', 'channelSetup', 'apiKeyEnv', 'claudeConfigEnv', 'helperTokenEnvPiece', 'agentEgressEnv', 'oauthTokenEnv', 'providerEnv', 'stateObserverEnv', 'codeModeEnv', 'launchCwd', 'claudeBin', 'continueFlag', 'skipFlag', 'model', 'shSingleQuote', 'channelFlag', 'worksourceFlags', 'bashSandboxFlag']
    const values = names.map(name => name === 'claudeBin' ? () => '/bin/claude' : name === 'shSingleQuote' ? (s: string) => `'${s}'` : `<${name}>`)
    const composeExpression = (expr: string) => new Function(...names, `return ${expr}`)(...values)
    expect(composeExpression(expression)).toBe(composeExpression(golden))
    expect(expression).toBe(golden)
    // The shell entry point is for the channel owner; it must stay untouched.
    expect(source.indexOf("engineConfig.engine === 'codex'")).toBeLessThan(source.indexOf('const ownOauth = decideOwnOauthToken'))
  })

  it('U1 accepts clearing the Codex config directory on a Claude agent', () => {
    expect(() => validateAgentEngine({ engine: 'claude', codexConfigDir: '' })).not.toThrow()
    expect(validateAgentEngine({ engine: 'claude', codexConfigDir: '' }))
      .toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
  })

  it('U2 restricts Codex to the local dashboard user while allowing Claude execution settings', () => {
    const error = new Error('Codex pilot agents must run locally as the dashboard user')
    expect.soft(() => validateAgentEngine({ engine: 'codex', codexConfigDir: home, runAsUser: 'svc-user' })).toThrow(error)
    expect.soft(() => validateAgentEngine({ engine: 'codex', codexConfigDir: home, remoteHost: 'h1' })).toThrow(error)
    expect(() => validateAgentEngine({ engine: 'codex', codexConfigDir: home })).not.toThrow()
    expect(validateAgentEngine({ engine: 'codex', codexConfigDir: home }).engine).toBe('codex')
    expect(() => validateAgentEngine({ engine: 'claude', runAsUser: 'svc-user', remoteHost: 'h1' })).not.toThrow()
  })

  it('accepts Codex with an absolute config directory', () => {
    expect(validateAgentEngine({ engine: 'codex', codexConfigDir: home }).engine).toBe('codex')
    expect(validateAgentEngine({ engine: 'claude' }).engine).toBe('claude')
  })
  it.each([
    { engine: 'gpt' }, { engine: null }, { engine: 'codex' },
    { engine: 'codex', codexConfigDir: 'relative/home' },
    { engine: 'codex', codexConfigDir: '/safe/../other' },
    { engine: 'codex', codexConfigDir: '/unsafe home' },
    ...['channel', 'channelProvider', 'telegram', 'teams', 'slack', 'extraChannels'].map(key => ({ engine: 'codex', codexConfigDir: home, [key]: 'bound' })),
  ])('rejects invalid engine configuration %j', config => {
    expect(() => validateAgentEngine(config)).toThrow()
  })
  it('rejects existing token-file channel ownership when changing engines', () => {
    expect(() => validateAgentEngine({ engine: 'codex', codexConfigDir: home }, true)).toThrow('channel')
  })

  it('composes a Codex command without Claude auth and delegates environment cleanup', () => {
    const bin = binary('0.150.0')
    const command = compose(bin)
    expect(command).toContain(`CODEX_HOME=${home}`)
    expect(command).toContain(bin)
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) expect(command).not.toContain(key)
    const wrapper = readFileSync(script, 'utf-8')
    expect(command).toContain('--run')
    expect(wrapper).toContain('CLAUDE*|ANTHROPIC*) unset "$key"')
    expect(wrapper).toContain('codex_bin=${2:?Codex binary is required}')
    expect(wrapper).toContain('exec "$codex_bin"')
    expect(command).not.toContain('--sandbox')
  })
  it.each(['0.149.0', 'invalid'])('refuses old or malformed binary version %s', version => {
    expect(() => compose(binary(version))).toThrow('0.150')
  })
  it('refuses a missing binary before creating a session', () => {
    expect(() => compose(join(sandbox, 'missing-codex'))).toThrow('Codex launch error')
  })
  it('accepts a later major binary version', () => {
    expect(compose(binary('1.0.0'))).toContain('codex-1-0-0')
  })

  it('scaffolds private CODEX_HOME, inherited dashboard MCP and an independent AGENTS.md', () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), '# Pilot instructions\n')
    // config.toml takes env values only by reference (#2652 B3): both entries are forwarded, none is written as a value.
    scaffoldCodexHome(home, workspace, { dashboard: { command: 'node', args: ['dashboard-server.mjs'], env: { DASHBOARD_TOKEN_FILE: '${DASHBOARD_TOKEN_FILE}', DASHBOARD_SESSION: '${DASHBOARD_SESSION}' } } })
    const toml = readFileSync(join(home, 'config.toml'), 'utf-8')
    expect(toml).toContain('sandbox_mode = "danger-full-access"')
    expect(toml).toContain('approval_policy = "never"')
    expect(toml).toContain('[mcp_servers."dashboard"]')
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('env_vars = ["DASHBOARD_TOKEN_FILE","DASHBOARD_SESSION"]')
    expect(toml).not.toContain('.env]')
    expect(statSync(home).mode & 0o077).toBe(0)
    expect(statSync(join(home, 'config.toml')).mode & 0o077).toBe(0)
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(true)
    expect(lstatSync(join(workspace, 'AGENTS.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf-8')).toBe('# Pilot instructions\n')
    writeFileSync(join(home, 'config.toml'), '# operator config\n')
    scaffoldCodexHome(home, workspace, {})
    expect(readFileSync(join(home, 'config.toml'), 'utf-8')).toBe('# operator config\n')
  })
  it('skips both kinds of Claude supervision for Codex', () => {
    expect(autoRestartSupportsEngine('codex')).toBe(false)
    expect(contextGuardSupportsEngine('codex')).toBe(false)
    expect(autoRestartSupportsEngine('claude')).toBe(true)
    expect(contextGuardSupportsEngine('claude')).toBe(true)
  })
  it('uses shared prompt readiness for terminal chevrons', () => {
    const idle = '› \n\n  default · 100% context left'
    const typing = '› Draft a response\n\n  default · 100% context left'
    expect(detectPaneState(idle)).toBe('idle')
    expect(detectPaneState(typing)).toBe('typing')
    expect(detectPaneState('• Working (esc to interrupt)\n' + idle)).toBe('busy')
    expect(idleConsideringDimGhost(typing, idle)).toBe(true)
    expect(detectPaneState('› quoted text without a live footer')).toBe('unknown')
  })
})

describe('Codex review regressions', () => {
  it('T1 rejects non-stdio MCP before creating a fresh home', () => {
    const fresh = join(sandbox, 'non-stdio-home')
    expect(() => scaffoldCodexHome(fresh, workspace, { dashboard: { url: 'http://127.0.0.1:9/mcp' } }))
      .toThrow('Codex pilot requires inherited stdio MCP servers')
    expect(existsSync(fresh)).toBe(false)
  })

  it('T2 rejects a value that is not a same-name reference before creating a fresh home', () => {
    const fresh = join(sandbox, 'missing-env-home')
    const previous = process.env.SOME_UNSET_VAR_FOR_TEST
    delete process.env.SOME_UNSET_VAR_FOR_TEST
    try {
      // No ${...} expansion any more (#2652 B3): any value other than ${KEY} for the same KEY is refused as a literal.
      expect(() => scaffoldCodexHome(fresh, workspace, { dashboard: { command: 'node', env: { AUTH: '${SOME_UNSET_VAR_FOR_TEST}' } } }))
        .toThrow('MCP environment variable AUTH of server dashboard would be written into config.toml as a literal value')
      expect(existsSync(fresh)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.SOME_UNSET_VAR_FOR_TEST
      else process.env.SOME_UNSET_VAR_FOR_TEST = previous
    }
  })

  it('T3 preserves a config that appears before the exclusive create', async () => {
    const fresh = join(sandbox, 'racing-home')
    mkdirSync(fresh)
    const configPath = join(fresh, 'config.toml')
    const known = '# operator wins\n'
    writeFileSync(configPath, known)
    const realExists = (await vi.importActual<typeof import('node:fs')>('node:fs')).existsSync
    const spy = vi.spyOn(fs, 'existsSync').mockImplementation(path => path === configPath ? false : realExists(path))
    try {
      expect(() => scaffoldCodexHome(fresh, workspace, {})).not.toThrow()
      expect(readFileSync(configPath, 'utf-8')).toBe(known)
    } finally {
      spy.mockRestore()
    }
  })

  it('T4 preflights without creating or changing anything and skips existing configs', () => {
    const fresh = join(sandbox, 'preflight-home')
    const servers = { dashboard: { url: 'http://127.0.0.1:9/mcp' } }
    expect(() => preflightCodexHome(fresh, workspace, servers)).toThrow('stdio')
    expect(existsSync(fresh)).toBe(false)
    mkdirSync(fresh, { mode: 0o755 })
    const configPath = join(fresh, 'config.toml')
    writeFileSync(configPath, '# existing\n', { mode: 0o644 })
    const before = [statSync(fresh), statSync(configPath)]
    expect(() => preflightCodexHome(fresh, workspace, servers)).not.toThrow()
    expect(fs.readdirSync(fresh)).toEqual(['config.toml'])
    expect(readFileSync(configPath, 'utf-8')).toBe('# existing\n')
    for (const [i, path] of [fresh, configPath].entries()) {
      expect(statSync(path).mode).toBe(before[i].mode)
      expect(statSync(path).mtimeMs).toBe(before[i].mtimeMs)
    }
    const validFresh = join(sandbox, 'valid-preflight-home')
    expect(() => preflightCodexHome(validFresh, workspace, {})).not.toThrow()
    expect(existsSync(validFresh)).toBe(false)
  })

  it('T6 preserves the exact channel scrub command', () => {
    expect(CHANNEL_TOKEN_UNSET).toBe('unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR')
  })

  it('T8 never writes a sensitive value: no expansion, withheld names refused even forwarded, plain forwarding kept', () => {
    const previous = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN }
    process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-value'
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-channel-value'
    try {
      // #2652 B3: a ${...} inside another value is a literal now, refused before anything is read from the environment.
      for (const env of [{ AUTH: 'Bearer ${ANTHROPIC_API_KEY}' }, { X: '${TELEGRAM_BOT_TOKEN}' }]) {
        let message = ''
        try { renderCodexConfig(workspace, { dashboard: { command: 'node', env } }) } catch (err) { message = (err as Error).message }
        expect(message).toContain('would be written into config.toml as a literal value')
        expect(message).not.toContain('dummy-')
      }
      // A withheld name is refused even as a same-name reference, as in the -c form.
      for (const key of ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
        expect(() => renderCodexConfig(workspace, { dashboard: { command: 'node', env: { [key]: '${' + key + '}' } } }))
          .toThrow(`MCP environment variable ${key} is withheld from Codex agents`)
      }
      const config = renderCodexConfig(workspace, { dashboard: { command: 'node', env: { DASHBOARD_SESSION: '${DASHBOARD_SESSION}' } } })
      expect(config).toContain('env_vars = ["DASHBOARD_SESSION"]')
      expect(config).not.toContain('dummy-')
      expect(config.endsWith('\n')).toBe(true)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('T9 defaults malformed and non-object JSON but keeps unknown engines strict and safe reads tolerant', async () => {
    const { agentDir, readAgentEngineConfig, readAgentEngineConfigSafe } = await import('../web/agent-config.js')
    const dir = agentDir('agent-a')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'agent-config.json')
    for (const content of ['{not json', 'null', '[]', '"codex"', '42', 'true']) {
      writeFileSync(path, content)
      expect(readAgentEngineConfig('agent-a')).toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
    }
    writeFileSync(path, '{"engine":"gpt"}')
    expect(() => readAgentEngineConfig('agent-a')).toThrow('engine must be claude or codex')
    expect(readAgentEngineConfigSafe('agent-a')).toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
  })

  it('T11 keeps context guard status available with an invalid agent engine', async () => {
    const { agentDir } = await import('../web/agent-config.js')
    for (const [name, config] of [['agent-a', '{"engine":"gpt"}'], ['agent-b', '{}']]) {
      const dir = agentDir(name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'agent-config.json'), config)
    }
    const { getContextGuardStatus } = await import('../web/context-guard-runner.js')
    expect(() => getContextGuardStatus()).not.toThrow()
    expect(getContextGuardStatus().map(status => status.agent)).toContain('agent-b')
  })
})

// R1 review (card 2436459e): a seat config.toml left over from an agent's
// earlier full-access life must REFUSE a switch to codexSandbox=relay instead
// of silently keeping danger-full-access and the token-carrying dashboard MCP
// entry. The workspace below only ever feeds the PURE renderers, so a literal
// path is fine (overrides mode rejects '.' in it).
describe('relay profile refuses an incompatible existing seat config', () => {
  // Its own project root (a .git entry) so a stray .git/.codex in the host's /tmp cannot reach the relay
  // project-config check; under tmpdir() because the overrides identity refuses a '.' in the path.
  const relayRoot = mkdtempSync(join(tmpdir(), 'relayseat-'))
  mkdirSync(join(relayRoot, '.git'))
  afterAll(() => rmSync(relayRoot, { recursive: true, force: true }))
  const relayWorkspace = join(relayRoot, 'relay-seat-workspace')
  const relayOpts = { profile: 'relay' as const, agentName: 'relay-agent' }

  const seatHomeWith = (name: string, configToml: string, identity: 'seat' | 'overrides' = 'seat'): string => {
    const home = mkdtempSync(join(sandbox, name))
    mkdirSync(home, { recursive: true })
    // Shim-only fixtures need the same valid sandbox/profile prefix as a fresh seat. Under overrides
    // the shared seat's file may carry no permissions table (F4), so the prefix stops before it there.
    const rendered = renderCodexConfig(relayWorkspace, {}, relayOpts).split('[mcp_servers]')[0]
    const prefix = identity === 'overrides' ? rendered.split('[permissions.')[0] : rendered
    writeFileSync(join(home, 'config.toml'), (configToml.startsWith('[mcp_servers') ? prefix : '') + configToml)
    return home
  }

  it('throws on a stale danger-full-access config for the seat identity, and only for the relay profile', () => {
    const stale = seatHomeWith('relay-stale-home', 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n')
    expect(() => preflightCodexHome(stale, relayWorkspace, {}, 'seat', relayOpts)).toThrow('codexSandbox=relay')
    expect(() => scaffoldCodexHome(stale, relayWorkspace, {}, 'seat', relayOpts)).toThrow('codexSandbox=relay')
    // The same file is none of the default profile's business: omitted or
    // explicit 'full-access' must behave exactly as before.
    expect(() => preflightCodexHome(stale, relayWorkspace, {}, 'seat')).not.toThrow()
    expect(() => preflightCodexHome(stale, relayWorkspace, {}, 'seat', { profile: 'full-access' })).not.toThrow()
  })

  it('throws on a non-shim marveen-dashboard entry for BOTH identities, and passes the shim form', () => {
    // A full-access-era dashboard entry: real command, token as an env literal,
    // no mcp-shim.mjs anywhere in the section.
    const nonShim = [
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-nonsm-${identity}-`, nonShim, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
    // The relay shim form the renderer itself seeds: no throw.
    const shim = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      `args = ${JSON.stringify([relayShimPath()])}`,
      '[mcp_servers."marveen-dashboard".env]',
      '"MARVEEN_AGENT_NAME" = "relay-agent"',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-shim-home-${identity}-`, shim, identity), relayWorkspace, {}, identity, relayOpts)).not.toThrow()
      const wrongPath = shim.replace(JSON.stringify([relayShimPath()]), JSON.stringify(['/repo/scripts/codex-relay/mcp-shim.mjs']))
      expect(wrongPath).not.toBe(shim)
      expect(() => preflightCodexHome(seatHomeWith(`relay-shim-path-${identity}-`, wrongPath, identity), relayWorkspace, {}, identity, relayOpts)).toThrow('codexSandbox=relay')
    }
  })

  it('lets overrides identity keep a danger-full-access seat config as long as no non-shim dashboard entry rides in it', () => {
    // Under overrides the agent's own sandbox profile travels as -c overrides,
    // so a danger-full-access seat config is the shared seat's business, not a
    // containment break -- until the dashboard MCP entry carries the token in.
    const plain = seatHomeWith('relay-ovr-home-', 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n')
    expect(() => preflightCodexHome(plain, relayWorkspace, {}, 'overrides', relayOpts)).not.toThrow()
    const withDashboard = seatHomeWith('relay-ovr-dash-home-', [
      'sandbox_mode = "danger-full-access"',
      '',
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\n'))
    expect(() => preflightCodexHome(withDashboard, relayWorkspace, {}, 'overrides', relayOpts)).toThrow('codexSandbox=relay')
  })

  // R2-1 (fix 7): the refusal must see BOTH header spellings of the dashboard
  // entry -- the renderer's quoted key and a hand-written bare key -- while
  // counting only ASSIGNMENT lines: a shim path mentioned in a comment (full
  // line or trailing) is prose, not configuration.
  it('refuses a bare-key [mcp_servers.marveen-dashboard] section for both identities', () => {
    // Hand-written TOML spells the key without quotes; before R2-1 the scan
    // only looked for the quoted marker and this section slipped through.
    const bareKey = [
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.marveen-dashboard]',
      'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-bare-${identity}-`, bareKey, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
  })

  it('refuses the bare-key spelling unless its lines are the exact shim entry', () => {
    const bareShim = [
      '[mcp_servers.marveen-dashboard]',
      'command = "node /repo/scripts/codex-relay/mcp-shim.mjs"',
      '',
    ].join('\n')
    const exactBareShim = [
      '[mcp_servers.marveen-dashboard]',
      'command = "node"',
      `args = ${JSON.stringify([relayShimPath()])}`,
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-bareshim-${identity}-`, bareShim, identity), relayWorkspace, {}, identity, relayOpts)).toThrow('codexSandbox=relay')
      expect(() => preflightCodexHome(seatHomeWith(`relay-exactbare-${identity}-`, exactBareShim, identity), relayWorkspace, {}, identity, relayOpts)).not.toThrow()
    }
  })

  it('refuses a section whose only mcp-shim.mjs mention is a comment, full-line or trailing', () => {
    const commentOnly = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      '# TODO: migrate to mcp-shim.mjs',
      '',
    ].join('\n')
    const trailingComment = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node" # uses mcp-shim.mjs later',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-cmt-line-${identity}-`, commentOnly, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
      expect(() => preflightCodexHome(seatHomeWith(`relay-cmt-trail-${identity}-`, trailingComment, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
  })

  it('still accepts a quoted-marker section with a real shim assignment alongside an unrelated comment', () => {
    const shimWithComment = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      `args = ${JSON.stringify([relayShimPath()])}`,
      '# mirrors the polling of scripts/codex-relay/relay.mjs',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-shimcmt-${identity}-`, shimWithComment, identity), relayWorkspace, {}, identity, relayOpts)).not.toThrow()
    }
  })

  // R2-2 (P1): the header check spans the whole remainder of the header line,
  // not a fixed 8-character window -- a header closing with many spaces before
  // ']' is still this entry's table, not a longer key to skip past.
  it('refuses a non-shim section whose header closes with eight spaces before the bracket', () => {
    // Eight spaces pushed ']' outside the old lookahead window, so the
    // occurrence was skipped as "not an entry header" and this token-carrying
    // entry rode through preflight unrefused.
    const spacedHeader = [
      '[mcp_servers."marveen-dashboard"        ]',
      'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-spaced-${identity}-`, spacedHeader, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
  })

  // TOML permits quoted assignment keys, but relay accepts only the rendered spelling.
  it('refuses a shim section whose assignment uses a quoted key (only the rendered spelling is accepted)', () => {
    const quotedKeyShim = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      `"args" = ${JSON.stringify([relayShimPath()])}`,
      '',
    ].join('\n')
    expect(() => preflightCodexHome(seatHomeWith('relay-qkey-shim-', quotedKeyShim), relayWorkspace, {}, 'seat', relayOpts)).toThrow('codexSandbox=relay')
  })

  // R2-2 (P1, CRLF): a config written with Windows line endings is the same
  // entry -- the header check must accept the carriage return that precedes
  // the closing bracket, not skip the section as "not an entry header".
  it('refuses a non-shim section in a CRLF config with a clean quoted header', () => {
    const crlfNonShim = [
      '[mcp_servers."marveen-dashboard"]',
      'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\r\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-crlf-${identity}-`, crlfNonShim, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
  })

  // R2-2 (P1, mixed whitespace): a header whose pre-bracket whitespace mixes
  // spaces and a carriage return and runs past any fixed window is still this
  // entry's table; pinning the \r member of the character class separately
  // from the eight-space case above.
  it('refuses a non-shim section whose header mixes spaces and a carriage return', () => {
    const mixedHeader = [
      '[mcp_servers."marveen-dashboard"   \r     ]',
      'command = "node"',
      'args = ["dist/dashboard-mcp.js"]',
      '"MARVEEN_DASHBOARD_TOKEN" = "/store/agent-tokens/relay-agent.token"',
      '',
    ].join('\n')
    for (const identity of ['seat', 'overrides'] as const) {
      expect(() => preflightCodexHome(seatHomeWith(`relay-mixed-${identity}-`, mixedHeader, identity), relayWorkspace, {}, identity, relayOpts))
        .toThrow('codexSandbox=relay')
    }
  })
})
