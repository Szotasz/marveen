import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MXD_AGENT_SOCK_DEFAULT } from '../web/agent-extra-channels.js'
import {
  codexPhysicalPath,
  codexRelayDeniedReadRoots,
  codexRelayFilesystemEntries,
  codexRelayMxdRunDir,
  preflightCodexHome,
  renderCodexConfig,
  renderCodexOverrides,
  scaffoldCodexHome,
} from '../web/agent-engine.js'

let projectRoot: string | undefined
vi.mock('../config.js', async original => {
  const config = await original<typeof import('../config.js')>()
  return { ...config, get PROJECT_ROOT() { return projectRoot ?? config.PROJECT_ROOT } }
})

let root: string
let ws: string
let home: string
const opts = { profile: 'relay', agentName: 'relay-137876' } as const
const servers = { 'marveen-dashboard': { command: 'node' } }
const USER_HOME = '/marveen-137876-fixed/user-home'
const noneLine = (path: string) => `${JSON.stringify(path)} = "none"\n`

beforeEach(() => {
  vi.stubEnv('HOME', USER_HOME)
  root = mkdtempSync(join(tmpdir(), 'codex-137876-'))
  mkdirSync(join(root, '.git')) // Keep the project-config walk independent of host /tmp state.
  projectRoot = join(root, 'project')
  ws = join(projectRoot, 'ws')
  home = join(root, 'home')
  mkdirSync(ws, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  projectRoot = undefined
  rmSync(root, { recursive: true, force: true })
})

function validSeat(): string {
  scaffoldCodexHome(home, ws, servers, 'seat', opts)
  return readFileSync(join(home, 'config.toml'), 'utf8')
}

function checkSeat(content: string): void {
  writeFileSync(join(home, 'config.toml'), content)
  preflightCodexHome(home, ws, servers, 'seat', opts)
}

describe('relay Codex home, mxd and web/apps containment (#137876)', () => {
  it('T1 denies the home and mxd run dir after store roots, including a physical home', () => {
    expect(codexRelayMxdRunDir()).toBe(dirname(MXD_AGENT_SOCK_DEFAULT))
    const parent = join(root, 'physical')
    mkdirSync(parent)
    symlinkSync(parent, join(root, 'link'))
    projectRoot = join(root, 'link', 'project')
    ws = join(projectRoot, 'ws')
    mkdirSync(ws, { recursive: true })
    home = join(root, 'link', 'home', '..', 'home')
    const runDir = codexRelayMxdRunDir()
    const seen = new Set<string>()
    const expected = [
      ['/', 'read'], [ws, 'write'],
      ...codexRelayDeniedReadRoots().map(path => [path, 'none']),
      [resolve(home), 'none'], [codexPhysicalPath(home), 'none'],
      [runDir, 'none'], [codexPhysicalPath(runDir), 'none'],
      ...[join(projectRoot, '.env'), join(projectRoot, 'agents'),
        join(USER_HOME, '.claude', 'channels'), join(USER_HOME, '.gmail-mcp')]
        .flatMap(p => [[resolve(p), 'none'], [codexPhysicalPath(p), 'none']]),
    ].filter(([path]) => {
      if (seen.has(path)) return false
      seen.add(path)
      return true
    })
    expect(codexRelayFilesystemEntries(ws, home).slice(0, expected.length)).toEqual(expected)
  })

  it('T1 keeps the first entry when hidden roots overlap', () => {
    const store = codexRelayDeniedReadRoots()[0]
    const entries = codexRelayFilesystemEntries(ws, store)
    expect(entries.filter(([path]) => path === store)).toEqual([[store, 'none']])
    expect(() => codexRelayFilesystemEntries(ws, ws)).toThrow(/relay sandbox profile refuses workspace/)
    expect(codexRelayFilesystemEntries(ws, codexRelayMxdRunDir()).filter(([path]) => path === codexRelayMxdRunDir()))
      .toEqual([[codexRelayMxdRunDir(), 'none']])
  })

  it('T2 keeps entries stable when a missing home below a symlinked parent is created', () => {
    mkdirSync(join(root, 'physical'))
    symlinkSync(join(root, 'physical'), join(root, 'link'))
    home = join(root, 'link', 'nested', 'home')
    const before = codexRelayFilesystemEntries(ws, home)
    mkdirSync(home, { recursive: true })
    expect(codexRelayFilesystemEntries(ws, home)).toEqual(before)
  })

  it('T2 seat round trip: a home below a symlinked parent renders both paths and passes its own check', () => {
    mkdirSync(join(root, 'physical'))
    symlinkSync(join(root, 'physical'), join(root, 'link'))
    home = join(root, 'link', 'home')
    const content = validSeat()
    const physicalHome = join(realpathSync(join(root, 'physical')), 'home')
    expect(physicalHome).not.toBe(resolve(home))
    expect(content).toContain(noneLine(resolve(home)))
    expect(content).toContain(noneLine(physicalHome))
    expect(() => checkSeat(content)).not.toThrow()
    expect(() => checkSeat(content.replace(noneLine(physicalHome), ''))).toThrow(/codexSandbox=relay refuses/)
    expect(() => checkSeat(content.replace(noneLine(resolve(home)), ''))).toThrow(/codexSandbox=relay refuses/)
  })

  it.each([undefined, '', 'relative/home'])('T3 requires an absolute home in both relay renderers (%j)', codexHome => {
    const renderOpts = { ...opts, codexHome }
    const message = 'relay sandbox profile needs the absolute Codex home (codexConfigDir) to hide it from the sandbox'
    expect(() => renderCodexConfig(ws, {}, renderOpts)).toThrow(message)
    expect(() => renderCodexOverrides(ws, {}, renderOpts)).toThrow(message)
  })

  it('T3 preserves the full-access output without a home', () => {
    const config = [
      'sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
      '', '[notice]', 'hide_full_access_warning = true', '',
      `[projects.${JSON.stringify(ws)}]`, 'trust_level = "trusted"', '', '[mcp_servers]', '',
    ].join('\n')
    const overrides = [
      'sandbox_mode="danger-full-access"', 'approval_policy="never"',
      'notice.hide_full_access_warning=true', `projects.${ws}.trust_level="trusted"`,
    ]
    for (const renderOpts of [undefined, { profile: 'full-access' as const }]) {
      expect(renderCodexConfig(ws, {}, renderOpts)).toBe(config)
      expect(renderCodexOverrides(ws, {}, renderOpts)).toEqual(overrides)
    }
    expect(config).not.toMatch(/web_search|features/)
    expect(overrides.join('\n')).not.toMatch(/web_search|features/)
  })

  it('T4 disables web search once before tables and apps in their own table', () => {
    const lines = renderCodexConfig(ws, servers, { ...opts, codexHome: home }).split('\n')
    expect(lines.filter(line => line === 'web_search = "disabled"')).toHaveLength(1)
    expect(lines.indexOf('web_search = "disabled"')).toBeLessThan(lines.findIndex(line => line.startsWith('[')))
    expect(lines.join('\n')).toContain('[features]\napps = false\n')
  })

  it('T5 disables web search and apps once each in overrides', () => {
    const lines = renderCodexOverrides(ws, servers, { ...opts, codexHome: home })
    expect(lines.filter(line => line === 'web_search="disabled"')).toHaveLength(1)
    expect(lines.filter(line => line === 'features.apps=false')).toHaveLength(1)
  })

  it('T6 scaffolds the hidden paths and accepts subsequent scaffold and preflight', () => {
    const content = validSeat()
    expect(content).toContain(noneLine(resolve(home)))
    expect(content).toContain(noneLine(codexRelayMxdRunDir()))
    expect(() => scaffoldCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
    expect(() => preflightCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(content)
  })

  it('T6 seeds a missing home under a symlink and accepts it after creation', () => {
    mkdirSync(join(root, 'physical'))
    symlinkSync(join(root, 'physical'), join(root, 'link'))
    home = join(root, 'link', 'nested', 'home')
    const content = validSeat()
    expect(content).toContain(noneLine(home))
    expect(content).toContain(noneLine(realpathSync(home)))
    expect(() => scaffoldCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
    expect(() => preflightCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
  })

  it('T6 uses the entry point home even when opts names another home', () => {
    const renderOpts = { ...opts, codexHome: join(root, 'wrong-home') }
    scaffoldCodexHome(home, ws, servers, 'seat', renderOpts)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain(noneLine(home))
    expect(() => preflightCodexHome(home, ws, servers, 'seat', renderOpts)).not.toThrow()
    const sharedHome = join(root, 'shared')
    scaffoldCodexHome(sharedHome, ws, servers, 'overrides', renderOpts)
    expect(readFileSync(join(ws, '.codex-overrides'), 'utf8')).toContain(`${JSON.stringify(sharedHome)}="none"`)
    expect(() => preflightCodexHome(sharedHome, ws, servers, 'overrides', renderOpts)).not.toThrow()
  })

  it.each([
    ['missing web_search', (s: string) => s.replace('web_search = "disabled"\n', '')],
    ['live web_search', (s: string) => s.replace('web_search = "disabled"', 'web_search = "live"')],
    ['duplicate web_search', (s: string) => 'web_search = "disabled"\n' + s],
    ['web_search after a table', (s: string) => s.replace('web_search = "disabled"\n', '') + '\n[unrelated]\nweb_search = "disabled"\n'],
    ['tools web_search', (s: string) => s + '\n[tools]\nweb_search = true\n'],
    ['top-level features.apps', (s: string) => 'features.apps = true\n' + s],
    ['top-level profile', (s: string) => 'profile = "x"\n' + s],
    ['profiles table', (s: string) => s + '\n[profiles.x]\nweb_search = "live"\n'],
    ['quoted top-level profile', (s: string) => '"profile" = "x"\n' + s],
    ['quoted profiles table', (s: string) => s + '\n["profiles".x]\nmodel = "y"\n'],
    ['literal-quoted tools table', (s: string) => s + "\n['tools']\nx = 1\n"],
    ['quoted features dotted key', (s: string) => '"features".apps = true\n' + s],
    ['enabled apps', (s: string) => s.replace('[features]\napps = false', '[features]\napps = true')],
    ['extra features key', (s: string) => s.replace('[features]\napps = false', '[features]\napps = false\nweb_search_request = true')],
    ['missing features table', (s: string) => s.replace('[features]\napps = false\n', '')],
    ['missing home denial', (s: string) => s.replace(noneLine(resolve(home)), '')],
    ['missing mxd denial', (s: string) => s.replace(noneLine(codexRelayMxdRunDir()), '')],
    ['duplicate features table', (s: string) => s + '\n[features]\napps = false\n'],
    ['duplicate apps', (s: string) => s.replace('apps = false', 'apps = false\napps = false')],
  ] as const)('T7 refuses a seat with %s', (_name, mutate) => {
    const content = validSeat()
    const changed = mutate(content)
    expect(changed).not.toBe(content)
    expect(() => checkSeat(changed)).toThrow(/codexSandbox=relay refuses/)
  })

  it('T7 accepts the valid config and ignores web/apps words in quoted project paths and values', () => {
    const content = validSeat()
    expect(() => checkSeat(content)).not.toThrow()
    // Existing validation accepts extra trusted project tables.
    expect(() => checkSeat(content + '\n[projects."/tmp/features-tools-profile"]\ntrust_level = "trusted"\n')).not.toThrow()
    expect(() => checkSeat(content + "\n[projects.'/tmp/features.tools.profile']\ntrust_level = \"trusted\"\n")).not.toThrow()
    expect(() => checkSeat(content + '\n[projects."/srv/a.web_search.features/tools"]\ntrust_level = "trusted"\n')).not.toThrow()
    expect(() => checkSeat('model = "web_search features profile profiles tools"\n' + content)).not.toThrow()
  })

  it.each([
    'web_search = "live"\n',
    '[features]\napps = true\n',
    'profile = "x"\n',
    '[tools]\nweb_search = true\n',
    '[profiles.x]\nweb_search = "live"\n',
    'features.apps = false\n',
    '"web_search" = "live"\n',
    '["features"]\napps = true\n',
    '"profile" = "x"\n',
    '"tools" = { web_search = true }\n',
    "'profile' = 'x'\n",
    '["profiles".x]\nmodel = "y"\n',
  ])('T8 refuses shared config web/apps settings: %s', content => {
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), content)
    expect(() => preflightCodexHome(home, ws, servers, 'overrides', opts))
      .toThrow(/codexSandbox=relay refuses.*it sets Codex web search, ChatGPT apps, tools or a config profile.*could re-enable them over the relay overrides/)
  })

  it('T8 accepts unrelated settings in a shared home', () => {
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), 'model = "x"\n')
    expect(() => preflightCodexHome(home, ws, servers, 'overrides', opts)).not.toThrow()
  })

  it('R1 accepts its own seeded config when the home path holds "=" or checked words', () => {
    for (const leaf of ['seat.features=relay', 'a.profile=x.tools', 'codex-writable_roots', 'mcp_servers.default_permissions']) {
      home = join(root, leaf)
      const content = validSeat()
      expect(content).toContain(noneLine(resolve(home)))
      expect(() => scaffoldCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
      expect(() => preflightCodexHome(home, ws, servers, 'seat', opts)).not.toThrow()
    }
  })

  it('R1 still refuses non-rendered or duplicate filesystem lines with those words', () => {
    const content = validSeat()
    const header = '[permissions.marveen-relay.filesystem]\n'
    expect(content).toContain(header)
    for (const extra of ['"/x/writable_roots" = "none"\n', '"/x/mcp_servers" = "none"\n', noneLine(resolve(home))]) {
      expect(() => checkSeat(content.replace(header, header + extra))).toThrow(/codexSandbox=relay refuses/)
    }
  })

  it.each([
    'profile = "a=b"\n',
    '"profile" = "x=y"\n',
    "'web_search' = 'live=1'\n",
    '"tools" = { web_search = "a=b" }\n',
  ])('R1 still refuses a web/apps key whose value holds "=": %s', content => {
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), content)
    expect(() => preflightCodexHome(home, ws, servers, 'overrides', opts))
      .toThrow(/it sets Codex web search, ChatGPT apps, tools or a config profile/)
  })

  it('R1 accepts a quoted path key holding "=" and a checked word in a shared home', () => {
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), '[unrelated]\n"/srv/a.features=1" = "y"\n')
    expect(() => preflightCodexHome(home, ws, servers, 'overrides', opts)).not.toThrow()
  })

  it('D0480 refuses a workspace inside store/, lexically and through a symlink', () => {
    const store = codexRelayDeniedReadRoots()[0]
    const workspace = join(store, 'sub')
    mkdirSync(workspace, { recursive: true })
    expect(() => codexRelayFilesystemEntries(workspace, home))
      .toThrow(/relay sandbox profile refuses workspace .*: it is inside /)
    symlinkSync(workspace, join(root, 'ws-into-store'))
    expect(() => codexRelayFilesystemEntries(join(root, 'ws-into-store'), home)).toThrow(/it is inside /)
    expect(() => renderCodexOverrides(join(store, 'sub'), {}, { ...opts, codexHome: home }))
      .toThrow(/relay sandbox profile refuses workspace/)
  })

  it('D0480 refuses a workspace inside the Codex home and the mxd run dir', () => {
    expect(() => codexRelayFilesystemEntries(join(home, 'sub'), home)).toThrow(/it is inside /)
    expect(() => codexRelayFilesystemEntries(join(codexRelayMxdRunDir(), 'sub'), home)).toThrow(/it is inside /)
  })

  it('D0480 keeps prefix siblings and nested agent workspaces allowed', () => {
    const store = codexRelayDeniedReadRoots()[0]
    const workspace = store + '-other'
    mkdirSync(workspace, { recursive: true })
    expect(() => codexRelayFilesystemEntries(workspace, home)).not.toThrow()
    expect(codexRelayFilesystemEntries(workspace, home)).toContainEqual([workspace, 'write'])
    mkdirSync(home + '2', { recursive: true })
    expect(() => codexRelayFilesystemEntries(home + '2', home)).not.toThrow()
    const agentWorkspace = join(projectRoot!, 'agents', 'x')
    mkdirSync(agentWorkspace, { recursive: true })
    expect(() => codexRelayFilesystemEntries(agentWorkspace, home)).not.toThrow()
    expect(codexRelayFilesystemEntries(agentWorkspace, home)).toContainEqual([agentWorkspace, 'write'])
  })

  it('D0480 keeps an agent workspace allowed when agents/ is a symlink', () => {
    const realAgents = join(root, 'real-agents')
    mkdirSync(join(realAgents, 'y'), { recursive: true })
    symlinkSync(realAgents, join(projectRoot!, 'agents'))
    const agentWorkspace = join(projectRoot!, 'agents', 'y')
    expect(() => codexRelayFilesystemEntries(agentWorkspace, home)).not.toThrow()
    expect(codexRelayFilesystemEntries(agentWorkspace, home)).toContainEqual([agentWorkspace, 'write'])
  })

  it('D0480 refuses an agent workspace when agents/ is a symlink to the store root', () => {
    const store = codexRelayDeniedReadRoots()[0]
    mkdirSync(join(store, 'x'), { recursive: true })
    symlinkSync(store, join(projectRoot!, 'agents'))
    expect(() => codexRelayFilesystemEntries(join(projectRoot!, 'agents', 'x'), home))
      .toThrow(/relay sandbox profile refuses workspace .*: it is inside /)
  })

  it('D0480 refuses an agent workspace when agents/ is the Codex home, directly or through a symlink', () => {
    const agents = join(projectRoot!, 'agents')
    mkdirSync(join(agents, 'x'), { recursive: true })
    expect(() => codexRelayFilesystemEntries(join(agents, 'x'), agents)).toThrow(/it is inside /)
    rmSync(agents, { recursive: true })
    mkdirSync(join(home, 'y'), { recursive: true })
    symlinkSync(home, agents)
    expect(() => codexRelayFilesystemEntries(join(agents, 'y'), home)).toThrow(/it is inside /)
  })

  it('R1 refuses a workspace that is a hidden path, lexically or physically', () => {
    const runDir = codexRelayMxdRunDir()
    const store = codexRelayDeniedReadRoots()[0]
    mkdirSync(store, { recursive: true })
    symlinkSync(store, join(root, 'store-link'))
    for (const workspace of [runDir, store, join(root, 'store-link')]) {
      expect(() => codexRelayFilesystemEntries(workspace, home)).toThrow(/relay sandbox profile refuses workspace/)
      const overridesMessage = /^\/[A-Za-z0-9_\/-]+$/.test(workspace)
        ? /relay sandbox profile refuses workspace/
        : /codexIdentity=overrides needs an absolute workspace path/
      expect(() => renderCodexOverrides(workspace, {}, { ...opts, codexHome: home })).toThrow(overridesMessage)
    }
  })
})
