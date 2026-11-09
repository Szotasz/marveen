import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveAgentEngine, scaffoldCodexHome, validateAgentEngine } from '../web/agent-engine.js'
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
