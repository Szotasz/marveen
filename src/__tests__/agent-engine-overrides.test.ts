// codexIdentity=overrides: the agent's Codex identity (workspace trust + MCP
// server) carried as runtime `-c` overrides instead of the seat's config.toml,
// so several engine agents can share one CODEX_HOME. Kept import-light on
// purpose: this file must run in a partial checkout that carries only
// agent-engine.ts and its dependency-free imports.
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  omitDefaultCodexIdentity,
  preflightCodexHome,
  renderCodexConfig,
  renderCodexOverrides,
  scaffoldCodexHome,
  validateAgentEngine,
} from '../web/agent-engine.js'

const launcher = resolve('scripts/codex-agent.sh')

// bash's %q, so the expected pane command stays exact whatever the temp dir path.
function shellQuote(value: string): string {
  return execFileSync('bash', ['-c', 'printf %q "$1"', 'quote', value], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeScript(path: string, body: string): string {
  writeFileSync(path, `${body}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

const stubDir = scratch('codex-stub-')
// A stand-in for `codex` that satisfies the launcher's version gate.
const codexStub = writeScript(join(stubDir, 'codex-stub.sh'), '#!/bin/sh\necho "codex-cli 0.163.0"')
// A stand-in for the launched binary: prints its argv, one per line.
const argvEcho = writeScript(join(stubDir, 'argv-echo.sh'), '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done')
afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

function compose(home: string, workspace: string, overrides?: string) {
  const args = overrides === undefined ? [home, workspace] : [home, workspace, overrides]
  return spawnSync('bash', [launcher, ...args], { encoding: 'utf-8', env: { ...process.env, MARVEEN_CODEX_BIN: codexStub } })
}

const WORKSPACE = '/srv/marveen/agents/pilot'
const SERVERS = {
  marveen: {
    command: '/usr/local/bin/marveen-mcp',
    args: ['--stdio', '--quiet'],
    cwd: '/srv/marveen',
    env: {
      MARVEEN_HOME: '${MARVEEN_HOME}',
      MARVEEN_AGENT_NAME: 'pilot',
      MARVEEN_AGENT_TOKEN_PATH: '/srv/fleet/tokens/pilot.token',
    },
  },
}

describe('renderCodexOverrides', () => {
  it.each([
    { profile: 'relay' as const, agentName: 'pilot', codexHome: '/opt/codex-home' },
    { profile: 'full-access' as const },
  ])('U2B5E disables startup updates exactly once in overrides ($profile)', opts => {
    const overrides = renderCodexOverrides(WORKSPACE, {}, opts)
    expect(overrides.filter(line => line === 'check_for_update_on_startup=false')).toHaveLength(1)
  })

  it('renders one key=value per -c override, in the config.toml order', () => {
    expect(renderCodexOverrides(WORKSPACE, SERVERS)).toEqual([
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
      'check_for_update_on_startup=false',
      'notice.hide_full_access_warning=true',
      'projects./srv/marveen/agents/pilot.trust_level="trusted"',
      'mcp_servers.marveen.command="/usr/local/bin/marveen-mcp"',
      'mcp_servers.marveen.args=["--stdio","--quiet"]',
      'mcp_servers.marveen.cwd="/srv/marveen"',
      'mcp_servers.marveen.env_vars=["MARVEEN_HOME"]',
      'mcp_servers.marveen.env.MARVEEN_AGENT_NAME="pilot"',
      'mcp_servers.marveen.env.MARVEEN_AGENT_TOKEN_PATH="/srv/fleet/tokens/pilot.token"',
    ])
  })

  it('carries the same settings renderCodexConfig writes into the seat', () => {
    // The reason this mode exists is sharing a seat, so the two renderers must
    // agree on every value; only the shape (TOML tables vs dotted keys) differs.
    // config.toml takes env values only by reference, so the literal entries are left out here.
    const refServers = { marveen: { ...SERVERS.marveen, env: { MARVEEN_HOME: '${MARVEEN_HOME}' } } }
    const config = renderCodexConfig(WORKSPACE, refServers)
    const overrides = renderCodexOverrides(WORKSPACE, refServers).join('\n')
    for (const [inConfig, inOverrides] of [
      ['sandbox_mode = "danger-full-access"', 'sandbox_mode="danger-full-access"'],
      ['approval_policy = "never"', 'approval_policy="never"'],
      ['hide_full_access_warning = true', 'notice.hide_full_access_warning=true'],
      ['trust_level = "trusted"', 'projects./srv/marveen/agents/pilot.trust_level="trusted"'],
      ['command = "/usr/local/bin/marveen-mcp"', 'mcp_servers.marveen.command="/usr/local/bin/marveen-mcp"'],
      ['args = ["--stdio","--quiet"]', 'mcp_servers.marveen.args=["--stdio","--quiet"]'],
      ['cwd = "/srv/marveen"', 'mcp_servers.marveen.cwd="/srv/marveen"'],
      ['env_vars = ["MARVEEN_HOME"]', 'mcp_servers.marveen.env_vars=["MARVEEN_HOME"]'],
    ]) {
      expect(config).toContain(inConfig)
      expect(overrides).toContain(inOverrides)
    }
  })

  it('is pure: literal values are never expanded, forwarded names stay names', () => {
    process.env.MARVEEN_TEST_VALUE = 'surprise'
    try {
      const lines = renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { A: '$MARVEEN_TEST_VALUE', B: '${B}' } } })
      expect(lines).toContain('mcp_servers.m.env.A="$MARVEEN_TEST_VALUE"')
      expect(lines).toContain('mcp_servers.m.env_vars=["B"]')
    } finally {
      delete process.env.MARVEEN_TEST_VALUE
    }
  })

  it('refuses a workspace that is not absolute', () => {
    expect(() => renderCodexOverrides('srv/agents/pilot', {})).toThrow(/absolute workspace path/)
  })

  it("refuses a workspace containing '.'", () => {
    expect(() => renderCodexOverrides('/srv/marveen.d/agents/pilot', {})).toThrow(/absolute workspace path/)
  })

  it('refuses a workspace containing a double quote', () => {
    expect(() => renderCodexOverrides('/srv/marveen"/agents', {})).toThrow(/absolute workspace path/)
  })

  it("refuses a workspace containing a single quote", () => {
    expect(() => renderCodexOverrides("/srv/marveen'/agents", {})).toThrow(/absolute workspace path/)
  })

  it('refuses a workspace containing whitespace', () => {
    expect(() => renderCodexOverrides('/srv/marveen agents/pilot', {})).toThrow(/absolute workspace path/)
  })

  it('refuses a workspace containing a newline', () => {
    expect(() => renderCodexOverrides('/srv/marveen\n/agents', {})).toThrow(/absolute workspace path/)
  })

  it("refuses a workspace containing '='", () => {
    expect(() => renderCodexOverrides('/srv/fleet=x/agents', {})).toThrow(/absolute workspace path/)
  })

  it('refuses a workspace character outside the allow-list', () => {
    for (const workspace of ['/srv/fleet:x', '/srv/fleet$x', '/srv/agents/pilot#1', '/srv/agents/pé', '/srv/agents/[x]']) {
      expect(() => renderCodexOverrides(workspace, {})).toThrow(/absolute workspace path/)
    }
  })

  it("accepts a workspace of letters, digits, '_', '-' and '/'", () => {
    expect(renderCodexOverrides('/srv/my_fleet-2/agents/Pilot9', {}))
      .toContain('projects./srv/my_fleet-2/agents/Pilot9.trust_level="trusted"')
  })

  it('refuses a server name outside [A-Za-z0-9_-]', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { 'mar.veen': { command: 'bin' } })).toThrow(/mar\.veen/)
    expect(() => renderCodexOverrides(WORKSPACE, { 'mar veen': { command: 'bin' } })).toThrow(/mar veen/)
  })

  it('refuses an env key outside [A-Za-z0-9_-]', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { 'BAD.KEY': 'v' } } })).toThrow(/BAD\.KEY/)
  })

  it("refuses a server without a string command, with today's message", () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { args: ['x'] } })).toThrow('Codex pilot requires inherited stdio MCP servers')
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 42 } })).toThrow('Codex pilot requires inherited stdio MCP servers')
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: '' } })).toThrow('Codex pilot requires inherited stdio MCP servers')
  })

  it('refuses a literal env value containing "${": an expanded value would land on argv', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { A: 'x${HOME}y' } } }))
      .toThrow(/MCP environment variable A cannot use/)
  })

  it('refuses a literal env value containing a newline', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { A: 'x\ny' } } }))
      .toThrow(/A must not contain a newline or NUL/)
  })

  it('refuses a literal env value containing a NUL', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { A: 'x\0y' } } }))
      .toThrow(/A must not contain a newline or NUL/)
  })

  it('withholds CLAUDE*/ANTHROPIC*/channel vars from env_vars names too', () => {
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_CODE_OAUTH_TOKEN}' } } }))
      .toThrow('MCP environment variable CLAUDE_CODE_OAUTH_TOKEN is withheld from Codex agents')
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' } } }))
      .toThrow('MCP environment variable ANTHROPIC_API_KEY is withheld from Codex agents')
    expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } } }))
      .toThrow('MCP environment variable SLACK_BOT_TOKEN is withheld from Codex agents')
  })

  it('withholds CLAUDE*/ANTHROPIC*/channel vars as literals too', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_BOT_TOKEN']) {
      expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { [key]: 'literal-value' } } }))
        .toThrow(`MCP environment variable ${key} is withheld from Codex agents`)
    }
  })

  it('refuses a credential-shaped literal name: it would land on argv', () => {
    for (const key of ['FOO_TOKEN', 'foo_token', 'DB_PASSWORD', 'DB_PASSWD', 'MY_API_KEY', 'MY_APIKEY', 'SERVICE_SECRET', 'AUTH_HEADER', 'SESSION_COOKIE', 'GH_CREDENTIALS', 'PRIVATE_PEM']) {
      expect(() => renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { [key]: 'literal-value' } } }))
        .toThrow(`MCP environment variable ${key} looks like a credential`)
    }
  })

  it('allows a credential-shaped literal name that carries a location (_PATH, _FILE, _DIR, _URL)', () => {
    const lines = renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: {
      MARVEEN_AGENT_TOKEN_PATH: '/p',
      SECRET_FILE: '/f',
      AUTH_DIR: '/d',
      TOKEN_URL: 'https://example.invalid/t',
    } } })
    expect(lines).toContain('mcp_servers.m.env.MARVEEN_AGENT_TOKEN_PATH="/p"')
    expect(lines).toContain('mcp_servers.m.env.SECRET_FILE="/f"')
    expect(lines).toContain('mcp_servers.m.env.AUTH_DIR="/d"')
    expect(lines).toContain('mcp_servers.m.env.TOKEN_URL="https://example.invalid/t"')
  })

  it('still forwards a credential-shaped name by name via env_vars', () => {
    const lines = renderCodexOverrides(WORKSPACE, { m: { command: 'bin', env: { FOO_TOKEN: '${FOO_TOKEN}' } } })
    expect(lines).toContain('mcp_servers.m.env_vars=["FOO_TOKEN"]')
    expect(lines.join('\n')).not.toContain('env.FOO_TOKEN')
  })
})

describe('validateAgentEngine codexIdentity', () => {
  const codex = { engine: 'codex', codexConfigDir: '/opt/codex-home' }

  it('accepts "overrides" and returns it in the resolved config', () => {
    expect(validateAgentEngine({ ...codex, codexIdentity: 'overrides' }))
      .toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'overrides', codexSandbox: 'relay' })
  })

  it('accepts "seat" and defaults an absent field to "seat" (claude included)', () => {
    expect(validateAgentEngine({ ...codex, codexIdentity: 'seat' })).toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'seat', codexSandbox: 'relay' })
    expect(validateAgentEngine(codex)).toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'seat', codexSandbox: 'relay' })
    expect(validateAgentEngine({ engine: 'claude' })).toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
  })

  it('rejects any other value, naming the field', () => {
    expect(() => validateAgentEngine({ ...codex, codexIdentity: 'xyz' })).toThrow(/codexIdentity/)
    expect(() => validateAgentEngine({ ...codex, codexIdentity: true })).toThrow(/codexIdentity/)
  })

  it('rejects codexIdentity on the claude engine', () => {
    expect(() => validateAgentEngine({ engine: 'claude', codexIdentity: 'overrides' })).toThrow(/codexIdentity/)
  })

  it('rejects an empty string, on both engines', () => {
    expect(() => validateAgentEngine({ ...codex, codexIdentity: '' })).toThrow(/codexIdentity/)
    expect(() => validateAgentEngine({ engine: 'claude', codexIdentity: '' })).toThrow(/codexIdentity/)
  })

  it("treats null as the cleared field: 'seat', on both engines", () => {
    expect(validateAgentEngine({ ...codex, codexIdentity: null })).toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'seat', codexSandbox: 'relay' })
    expect(validateAgentEngine({ engine: 'claude', codexIdentity: null })).toEqual({ engine: 'claude', codexConfigDir: null, codexIdentity: 'seat', codexSandbox: 'full-access' })
  })
})

describe('omitDefaultCodexIdentity', () => {
  it('keeps the persisted config free of the default, so a claude agent never carries a refused field', () => {
    // The create/PUT paths store the RESOLVED config; writing codexIdentity:"seat"
    // onto a claude agent would make its next start fail the check above.
    expect(omitDefaultCodexIdentity(validateAgentEngine({ engine: 'claude' }))).toEqual({ engine: 'claude', codexConfigDir: null })
    expect(omitDefaultCodexIdentity(validateAgentEngine({ engine: 'codex', codexConfigDir: '/opt/codex-home' })))
      .toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home' })
    expect(omitDefaultCodexIdentity(validateAgentEngine({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'overrides' })))
      .toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexIdentity: 'overrides' })
    // An explicit non-default value in the file being merged survives untouched.
    expect(omitDefaultCodexIdentity({ engine: 'codex', codexConfigDir: '/x', codexIdentity: 'seat', keep: 1 }))
      .toEqual({ engine: 'codex', codexConfigDir: '/x', keep: 1 })
    // codexSandbox: the codex default 'relay' is not written; an explicit 'full-access' is.
    expect(omitDefaultCodexIdentity(validateAgentEngine({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexSandbox: 'relay' })))
      .toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home' })
    expect(omitDefaultCodexIdentity(validateAgentEngine({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexSandbox: 'full-access' })))
      .toEqual({ engine: 'codex', codexConfigDir: '/opt/codex-home', codexSandbox: 'full-access' })
  })
})

describe('scripts/codex-agent.sh compose mode', () => {
  it("prints exactly today's command without a third argument", () => {
    const result = compose('/opt/codex-home', WORKSPACE)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      `export CODEX_HOME=${shellQuote('/opt/codex-home')} && cd ${shellQuote(WORKSPACE)}`
      + ` && exec bash ${shellQuote(launcher)} --run ${shellQuote(codexStub)}\n`)
  })

  it('appends the overrides path when the third argument is given', () => {
    const dir = scratch('codex-compose-')
    try {
      const overrides = join(dir, '.codex-overrides')
      writeFileSync(overrides, 'sandbox_mode="danger-full-access"\n')
      const result = compose('/opt/codex-home', WORKSPACE, overrides)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(
        `export CODEX_HOME=${shellQuote('/opt/codex-home')} && cd ${shellQuote(WORKSPACE)}`
        + ` && exec bash ${shellQuote(launcher)} --run ${shellQuote(codexStub)} ${shellQuote(overrides)}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a relative overrides path', () => {
    const result = compose('/opt/codex-home', WORKSPACE, '.codex-overrides')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^Codex launch error: overrides file /)
    expect(result.stderr).toContain('.codex-overrides')
    expect(result.stdout).toBe('')
  })

  it('refuses a missing overrides file', () => {
    const result = compose('/opt/codex-home', WORKSPACE, '/nonexistent/.codex-overrides')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^Codex launch error: overrides file /)
    expect(result.stderr).toContain('/nonexistent/.codex-overrides')
  })

  it('refuses an overrides file that is a symlink', () => {
    const dir = scratch('codex-compose-')
    try {
      const target = join(dir, 'real-overrides')
      const link = join(dir, '.codex-overrides')
      writeFileSync(target, 'sandbox_mode="danger-full-access"\n')
      symlinkSync(target, link)
      const result = compose('/opt/codex-home', WORKSPACE, link)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/^Codex launch error: overrides file /)
      expect(result.stderr).toContain(link)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scripts/codex-agent.sh --run', () => {
  it('turns each non-empty overrides line into one -c argument, in file order, and nothing else', () => {
    const dir = scratch('codex-run-')
    try {
      const overrides = join(dir, '.codex-overrides')
      writeFileSync(overrides, 'sandbox_mode="danger-full-access"\n\napproval_policy="never"\n\n\nmcp_servers.m.command="bin"\n')
      const result = spawnSync('bash', [launcher, '--run', argvEcho, overrides], { encoding: 'utf-8' })
      expect(result.status).toBe(0)
      expect(result.stdout.split('\n')).toEqual([
        '-c', 'sandbox_mode="danger-full-access"',
        '-c', 'approval_policy="never"',
        '-c', 'mcp_servers.m.command="bin"',
        '',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds no arguments of its own without an overrides file', () => {
    const result = spawnSync('bash', [launcher, '--run', argvEcho], { encoding: 'utf-8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('refuses a relative overrides path', () => {
    const dir = scratch('codex-run-')
    try {
      mkdirSync(join(dir, 'rel'))
      writeFileSync(join(dir, 'rel', '.codex-overrides'), 'approval_policy="never"\n')
      const result = spawnSync('bash', [launcher, '--run', argvEcho, 'rel/.codex-overrides'], { encoding: 'utf-8', cwd: dir })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('overrides file must be an absolute path to an existing regular file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a missing overrides file', () => {
    const dir = scratch('codex-run-')
    try {
      const result = spawnSync('bash', [launcher, '--run', argvEcho, join(dir, 'missing')], { encoding: 'utf-8', cwd: dir })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('overrides file must be an absolute path to an existing regular file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an overrides file that is a symlink', () => {
    const dir = scratch('codex-run-')
    try {
      writeFileSync(join(dir, 'real'), 'approval_policy="never"\n')
      symlinkSync(join(dir, 'real'), join(dir, 'link'))
      const result = spawnSync('bash', [launcher, '--run', argvEcho, join(dir, 'link')], { encoding: 'utf-8', cwd: dir })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('overrides file must be an absolute path to an existing regular file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a directory as the overrides file', () => {
    const dir = scratch('codex-run-')
    try {
      mkdirSync(join(dir, 'sub'))
      const result = spawnSync('bash', [launcher, '--run', argvEcho, join(dir, 'sub')], { encoding: 'utf-8', cwd: dir })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('overrides file must be an absolute path to an existing regular file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an empty overrides file: no bare launch without the identity', () => {
    const dir = scratch('codex-run-')
    try {
      writeFileSync(join(dir, 'empty'), '')
      writeFileSync(join(dir, 'blank'), '\n\n\n')
      for (const overrides of [join(dir, 'empty'), join(dir, 'blank')]) {
        const result = spawnSync('bash', [launcher, '--run', argvEcho, overrides], { encoding: 'utf-8', cwd: dir })
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('overrides file is empty')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("scaffoldCodexHome in 'overrides' mode", () => {
  it('leaves an existing seat config.toml byte-identical, with its mode and the home mode untouched', () => {
    const dir = scratch('codex-scaffold-')
    try {
      const home = join(dir, 'codex-home')
      const workspace = join(dir, 'agents', 'pilot')
      mkdirSync(home, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      const seatConfig = "# another agent's seat\nsandbox_mode = \"read-only\"\n"
      writeFileSync(join(home, 'config.toml'), seatConfig, { mode: 0o644 })
      chmodSync(join(home, 'config.toml'), 0o644)
      chmodSync(home, 0o755)

      scaffoldCodexHome(home, workspace, SERVERS, 'overrides')

      const configPath = join(home, 'config.toml')
      expect(readFileSync(configPath, 'utf-8')).toBe(seatConfig)
      expect(statSync(configPath).mode & 0o777).toBe(0o644)
      expect(statSync(home).mode & 0o777).toBe(0o755)
      const overridesPath = join(workspace, '.codex-overrides')
      expect(statSync(overridesPath).mode & 0o777).toBe(0o600)
      expect(readFileSync(overridesPath, 'utf-8')).toBe(`${renderCodexOverrides(workspace, SERVERS).join('\n')}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never creates a seat config.toml and does not touch a home that does not exist', () => {
    const dir = scratch('codex-scaffold-')
    try {
      const home = join(dir, 'shared-seat') // deliberately absent
      const workspace = join(dir, 'agents', 'pilot')
      mkdirSync(workspace, { recursive: true })
      scaffoldCodexHome(home, workspace, { m: { command: 'bin' } }, 'overrides')
      expect(existsSync(home)).toBe(false)
      expect(existsSync(join(home, 'config.toml'))).toBe(false)
      expect(readFileSync(join(workspace, '.codex-overrides'), 'utf-8')).toBe([
        'sandbox_mode="danger-full-access"',
        'approval_policy="never"',
        'check_for_update_on_startup=false',
        'notice.hide_full_access_warning=true',
        `projects.${workspace}.trust_level="trusted"`,
        'mcp_servers.m.command="bin"',
      ].join('\n') + '\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still syncs AGENTS.md from CLAUDE.md, as the seat path does', () => {
    const dir = scratch('codex-scaffold-')
    try {
      const workspace = join(dir, 'agents', 'pilot')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'CLAUDE.md'), '# Pilot\nDo the work.\n')
      scaffoldCodexHome(join(dir, 'seat'), workspace, {}, 'overrides')
      expect(readFileSync(join(workspace, 'AGENTS.md'), 'utf-8')).toBe('# Pilot\nDo the work.\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites the overrides file on every start, so a stale identity cannot survive', () => {
    const dir = scratch('codex-scaffold-')
    try {
      const workspace = join(dir, 'agents', 'pilot')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, '.codex-overrides'), 'sandbox_mode="read-only"\n', { mode: 0o644 })
      scaffoldCodexHome(join(dir, 'seat'), workspace, {}, 'overrides')
      expect(readFileSync(join(workspace, '.codex-overrides'), 'utf-8')).toBe([
        'sandbox_mode="danger-full-access"',
        'approval_policy="never"',
        'check_for_update_on_startup=false',
        'notice.hide_full_access_warning=true',
        `projects.${workspace}.trust_level="trusted"`,
      ].join('\n') + '\n')
      expect(statSync(join(workspace, '.codex-overrides')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("preflightCodexHome in 'overrides' mode", () => {
  it('validates without writing anything', () => {
    const dir = scratch('codex-preflight-')
    try {
      const home = join(dir, 'seat')
      const workspace = join(dir, 'agents', 'pilot')
      mkdirSync(home, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      preflightCodexHome(home, workspace, { m: { command: 'bin' } }, 'overrides')
      expect(existsSync(join(home, 'config.toml'))).toBe(false)
      expect(existsSync(join(workspace, '.codex-overrides'))).toBe(false)
      expect(() => preflightCodexHome(home, 'agents/pilot', {}, 'overrides')).toThrow(/absolute workspace path/)
      expect(() => preflightCodexHome(home, workspace, { 'bad.name': { command: 'bin' } }, 'overrides')).toThrow(/bad\.name/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
