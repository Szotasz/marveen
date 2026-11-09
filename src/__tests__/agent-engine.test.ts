import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHANNEL_TOKEN_UNSET, preflightCodexHome, renderCodexConfig, resolveAgentEngine, scaffoldCodexHome, validateAgentEngine } from '../web/agent-engine.js'
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
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(),
  PROJECT_ROOT: sandbox, STORE_DIR: join(sandbox, 'store'),
}))


function binary(version: string): string {
  const path = join(sandbox, `codex-${version.replaceAll('.', '-')}`)
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli ${version}'; else env; fi\n`, { mode: 0o700 })
  return path
}
function compose(bin: string): string {
  return execFileSync('bash', [script, home, workspace], {
    encoding: 'utf-8', env: { ...process.env, MARVEEN_CODEX_BIN: bin }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('per-agent engine pilot', () => {
  it('golden Claude default preserves the original composed command and env byte for byte', () => {
    expect(resolveAgentEngine(undefined)).toBe('claude')
    expect(resolveAgentEngine('')).toBe('claude')
    expect(validateAgentEngine({})).toEqual({ engine: 'claude', codexConfigDir: null })
    const source = readFileSync(join(root, 'src/web/agent-process.ts'), 'utf-8')
    const expression = source.split('\n').find(line => line.trim().startsWith('const buildLaunchCmd ='))!.split('=> ')[1]
    const golden = JSON.parse(readFileSync(join(root, 'src/__tests__/fixtures/agent-engine/claude-command.json'), 'utf-8')).expression
    // The captured pre-change expression includes every env component and flag.
    const names = ['umaskPrefix', 'venvPathPrefix', 'unsetTokens', 'stateFence', 'autoUpdaterEnv', 'byoUnsetEnv', 'promptSuggestionEnv', 'mcpEnv', 'channelSetup', 'apiKeyEnv', 'claudeConfigEnv', 'helperTokenEnvPiece', 'oauthTokenEnv', 'providerEnv', 'stateObserverEnv', 'launchCwd', 'claudeBin', 'continueFlag', 'skipFlag', 'model', 'shSingleQuote', 'channelFlag', 'worksourceFlags', 'bashSandboxFlag']
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
      .toEqual({ engine: 'claude', codexConfigDir: null })
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
    expect(wrapper).toContain('exec "${2:?Codex binary is required}"')
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
    scaffoldCodexHome(home, workspace, { dashboard: { command: 'node', args: ['dashboard-server.mjs'], env: { DASHBOARD_TOKEN_FILE: '/run/dashboard-token', DASHBOARD_SESSION: '${DASHBOARD_SESSION}' } } })
    const toml = readFileSync(join(home, 'config.toml'), 'utf-8')
    expect(toml).toContain('sandbox_mode = "danger-full-access"')
    expect(toml).toContain('approval_policy = "never"')
    expect(toml).toContain('[mcp_servers."dashboard"]')
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('env_vars = ["DASHBOARD_SESSION"]')
    expect(toml).toContain('"DASHBOARD_TOKEN_FILE" = "/run/dashboard-token"')
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

  it('T2 rejects missing literal environment variables before creating a fresh home', () => {
    const fresh = join(sandbox, 'missing-env-home')
    const previous = process.env.SOME_UNSET_VAR_FOR_TEST
    delete process.env.SOME_UNSET_VAR_FOR_TEST
    try {
      expect(() => scaffoldCodexHome(fresh, workspace, { dashboard: { command: 'node', env: { AUTH: '${SOME_UNSET_VAR_FOR_TEST}' } } }))
        .toThrow('Missing MCP environment variable: SOME_UNSET_VAR_FOR_TEST')
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

  it('T8 withholds sensitive literal expansions while preserving forwarded env_vars', () => {
    const previous = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN }
    process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-value'
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-channel-value'
    try {
      for (const env of [{ AUTH: 'Bearer ${ANTHROPIC_API_KEY}' }, { X: '${TELEGRAM_BOT_TOKEN}' }]) {
        expect(() => renderCodexConfig(workspace, { dashboard: { command: 'node', env } })).toThrow('withheld from Codex agents')
      }
      delete process.env.TELEGRAM_BOT_TOKEN
      expect(() => renderCodexConfig(workspace, { dashboard: { command: 'node', env: { X: '${TELEGRAM_BOT_TOKEN}' } } }))
        .toThrow('MCP environment variable TELEGRAM_BOT_TOKEN is withheld from Codex agents')
      const config = renderCodexConfig(workspace, { dashboard: { command: 'node', env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' } } })
      expect(config).toContain('env_vars = ["ANTHROPIC_API_KEY"]')
      expect(config).not.toContain('dummy-anthropic-value')
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
      expect(readAgentEngineConfig('agent-a')).toEqual({ engine: 'claude', codexConfigDir: null })
    }
    writeFileSync(path, '{"engine":"gpt"}')
    expect(() => readAgentEngineConfig('agent-a')).toThrow('engine must be claude or codex')
    expect(readAgentEngineConfigSafe('agent-a')).toEqual({ engine: 'claude', codexConfigDir: null })
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
