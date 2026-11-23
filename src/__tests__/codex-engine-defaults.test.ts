import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCodexSeatConfigCompatible,
  codexRelayDir,
  CODEX_RELAY_PERMISSION_PROFILE,
  codexRelayDeniedReadRoots,
  codexRelayFilesystemEntries,
  codexRelayMxdRunDir,
  codexRelaySecretReadRoots,
  omitDefaultCodexIdentity,
  relayShimPath,
  relayDroppedMcpServers,
  renderCodexConfig,
  renderCodexOverrides,
  resolveCodexSandbox,
  scaffoldCodexHome,
  validateAgentEngine,
  type CodexIdentity,
  type CodexRenderOptions,
} from '../web/agent-engine.js'
import { logger } from '../logger.js'

let projectRoot: string | undefined
vi.mock('../config.js', async original => {
  const config = await original<typeof import('../config.js')>()
  return { ...config, get PROJECT_ROOT() { return projectRoot ?? config.PROJECT_ROOT } }
})

const dirs: string[] = []
const USER_HOME = '/marveen-cxdef-fixed/user-home'
beforeEach(() => {
  vi.stubEnv('HOME', USER_HOME)
})

function tmp(): string {
  let d = mkdtempSync(join(tmpdir(), 'cxdef-'))
  d = realpathSync(d) // macOS temp dirs live behind symlinks (/tmp, /var): use the physical path so lexical == physical
  mkdirSync(join(d, '.git')) // project root here: host /tmp state must not reach the relay project-config check
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  projectRoot = undefined
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const WS = '/tmp/cxdef-ws'
const RELAY = { profile: 'relay' as const, agentName: 'a', codexHome: '/marveen-cxdef-fixed/home' }
const dash = { command: 'node', env: { X: '${X}' } }
const plain = { command: 'uvx' }
// Overrides seats must not supply relay permissions or web/apps settings, even matching ones.
const withoutPermissionsTable = (content: string) => content.replace(/\n\[permissions\.marveen-relay\.filesystem\][\s\S]*?(?=\n\[|$)/, '')
  .replace('web_search = "disabled"\n', '').replace('[features]\napps = false\n', '')

describe('startup update configuration', () => {
  it.each([RELAY, { profile: 'full-access' as const }])('U2B5E disables startup updates once before any table ($profile)', opts => {
    const lines = renderCodexConfig(WS, {}, opts).split('\n')
    const setting = 'check_for_update_on_startup = false'
    expect(lines.filter(line => line === setting)).toHaveLength(1)
    expect(lines.indexOf(setting)).toBeLessThan(lines.findIndex(line => line.startsWith('[')))
  })
})

describe('relay default', () => {
  it('resolveCodexSandbox', () => {
    expect(resolveCodexSandbox(undefined, 'codex')).toBe('relay')
    expect(resolveCodexSandbox(null, 'codex')).toBe('relay')
    expect(resolveCodexSandbox(undefined, 'claude')).toBe('full-access')
    expect(resolveCodexSandbox('full-access', 'codex')).toBe('full-access')
    expect(() => resolveCodexSandbox('relay', 'claude')).toThrow("codexSandbox requires engine 'codex'")
  })

  it('validateAgentEngine defaults codex to relay', () => {
    expect(validateAgentEngine({ engine: 'codex', codexConfigDir: tmp() }).codexSandbox).toBe('relay')
  })

  it('persistence', () => {
    expect('codexSandbox' in omitDefaultCodexIdentity({ engine: 'codex', codexSandbox: 'relay' })).toBe(false)
    expect(omitDefaultCodexIdentity({ engine: 'codex', codexSandbox: 'full-access' }).codexSandbox).toBe('full-access')
    expect('codexSandbox' in omitDefaultCodexIdentity({ engine: 'claude', codexSandbox: 'full-access' })).toBe(false)
  })
})

describe('relay drops other servers', () => {
  it('relayDroppedMcpServers', () => {
    const servers = { 'marveen-dashboard': dash, zeta: plain, alpha: plain }
    expect(relayDroppedMcpServers(servers, RELAY)).toEqual(['alpha', 'zeta'])
    expect(relayDroppedMcpServers(servers, { profile: 'full-access' })).toEqual([])
    expect(relayDroppedMcpServers(servers)).toEqual([])
  })

  it('renders nothing without a dashboard entry', () => {
    const out = renderCodexConfig(WS, { fetch: plain }, RELAY)
    expect(out).not.toContain('[mcp_servers."')
    expect(out).not.toContain('uvx')
    expect(renderCodexOverrides(WS, { fetch: plain }, RELAY).some(l => l.startsWith('mcp_servers.'))).toBe(false)
  })
})

describe('config.toml env by reference', () => {
  for (const opts of [undefined, { profile: 'full-access' as const }]) {
    it(`literal refusal (${opts ? 'full-access' : 'no profile'})`, () => {
      expect(() => renderCodexConfig(WS, { s: { command: 'x', env: { PLAIN: 'value' } } }, opts))
        .toThrow(/PLAIN of server s would be written into config\.toml as a literal value/)
      process.env.OTHER_CXDEF = 'sekret-cxdef'
      try {
        let msg = ''
        try { renderCodexConfig(WS, { s: { command: 'x', env: { B: '${OTHER_CXDEF}' } } }, opts) } catch (e) { msg = (e as Error).message }
        expect(msg).toMatch(/B of server s would be written into config\.toml as a literal value/)
        expect(msg).not.toContain('sekret-cxdef')
      } finally {
        delete process.env.OTHER_CXDEF
      }
      const ok = renderCodexConfig(WS, { s: { command: 'x', env: { C: '${C}' } } }, opts)
      expect(ok).toContain('env_vars = ["C"]')
      expect(ok).not.toContain('.env]')
      expect(() => renderCodexConfig(WS, { s: { command: 'x', env: { TELEGRAM_BOT_TOKEN: '${TELEGRAM_BOT_TOKEN}' } } }, opts))
        .toThrow('MCP environment variable TELEGRAM_BOT_TOKEN is withheld from Codex agents')
    })
  }

  it('shim exception is narrow', () => {
    const out = renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY)
    expect(out).toContain('"MARVEEN_AGENT_NAME" = "a"')
    expect(out).toContain('"MARVEEN_RELAY_DIR" = ')
    expect(() => renderCodexConfig(WS, { 'marveen-dashboard': { command: 'node', env: { MARVEEN_AGENT_NAME: 'a' } } }, { profile: 'full-access' }))
      .toThrow(/literal value/)
  })
})

describe('existing config.toml under relay', () => {
  for (const identity of ['seat', 'overrides'] as CodexIdentity[]) {
    describe(identity, () => {
      const fixture = (content: string) => identity === 'overrides' ? withoutPermissionsTable(content) : content
      let withDash: string
      let without: string
      let header: string
      beforeEach(() => {
        withDash = fixture(renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY))
        without = fixture(renderCodexConfig(WS, {}, RELAY))
        header = without.slice(0, without.indexOf('[mcp_servers]'))
      })
      const check = (content: string) => {
        const home = tmp()
        writeFileSync(join(home, 'config.toml'), content.replaceAll(JSON.stringify(RELAY.codexHome), JSON.stringify(home)))
        assertCodexSeatConfigCompatible(home, WS, identity, RELAY)
      }

      it('refuses other servers', () => {
        const cases = [
          withDash + '\n[mcp_servers."fetch"]\ncommand = "uvx"\n',
          withDash.replace('[mcp_servers]', 'mcp_servers.fetch.command = "uvx"\n[mcp_servers]'),
          header + '[mcp_servers]\nfetch = { command = "uvx" }\n',
          // A dotted key directly under [mcp_servers] defines the server without an inline table.
          header + '[mcp_servers]\nfetch.command = "uvx"\n',
          header + '[mcp_servers]\n"fetch" . command = "uvx"\n',
          header + '[mcp_servers]\n\n[mcp_servers . marveen-dashboard]\ncommand = "uvx"\n',
          header + '[mcp_servers]\n\n[mcp_servers."marveen- dashboard"]\ncommand = "uvx"\n',
          withDash + '\n[[mcp_servers.fetch]]\n',
          // A quoted or escaped key names the same table; the scan refuses what it cannot normalize.
          withDash + '\n["mcp_servers".fetch]\ncommand = "uvx"\n',
          withDash + "\n['mcp_servers'.\"fetch\"]\ncommand = \"uvx\"\n",
          withDash + '\n["mcp\\u005Fservers".fetch]\ncommand = "uvx"\n',
          withDash.replace('[mcp_servers]', '"mcp\\u005Fservers".fetch.command = "uvx"\n[mcp_servers]'),
        ]
        for (const c of cases) {
          expect(() => check(c)).toThrow(identity === 'overrides' && c.includes('\\')
            ? /backslash/
            : /defines an MCP server other than marveen-dashboard/)
        }
      })

      it('refuses a dashboard entry that is not the exact shim entry', () => {
        const argsLine = 'args = ' + JSON.stringify([relayShimPath()])
        expect(withDash.trimEnd().split('\n').at(-1)).toMatch(/MARVEEN_RELAY_DIR/)
        const cases = [
          withDash.replace(argsLine, 'args = ' + JSON.stringify(['/tmp/x.js', relayShimPath()])),
          withDash.replace('command = "node"', 'command = "sh"'),
          withDash.replace('command = "node"', 'command = "node"\ncwd = "/tmp"'),
          withDash.replace('command = "node"', 'command = "node"\nenv_vars = ["X_TOKEN"]'),
          withDash + '"X_TOKEN" = "x"\n',
          // command removed: the args line still names mcp-shim.mjs, so only the exact-entry rule refuses it.
          withDash.replace('command = "node"\n', ''),
          withDash.replace(argsLine, 'args = ' + JSON.stringify(['/repo/scripts/codex-relay/mcp-shim.mjs'])),
        ]
        for (const c of cases) {
          expect(c).not.toBe(withDash)
          expect(() => check(c)).toThrow(/is not the relay shim entry/)
        }
        // args removed: no line names mcp-shim.mjs any more, so the earlier marker check refuses it first.
        const noArgs = withDash.replace(argsLine + '\n', '')
        expect(noArgs).not.toBe(withDash)
        expect(() => check(noArgs)).toThrow(/codexSandbox=relay refuses/)
      })

      it('refuses an env value that opens a multi-line construct', () => {
        const relayLine = withDash.trimEnd().split('\n').at(-1)!
        expect(relayLine).toMatch(/^"MARVEEN_RELAY_DIR" = "/)
        const cases = [
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = """\n[unrelated]\n"""\n"NODE_OPTIONS" = "--require=/tmp/p.cjs"'),
          withDash.replace(relayLine, "\"MARVEEN_RELAY_DIR\" = '''\n[unrelated]\n'''\n\"NODE_OPTIONS\" = \"x\""),
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = [\n[1],\n]\n"NODE_OPTIONS" = "x"'),
          withDash.replace(relayLine, '"MARVEEN_RELAY_DIR" = "/r\\u0022"'),
        ]
        for (const c of cases) {
          expect(c).not.toBe(withDash)
          expect(() => check(c)).toThrow(identity === 'overrides' && c.includes('\\')
            ? /backslash/
            : /is not the relay shim entry/)
        }
      })

      it('an escaped value in the seat config', () => {
        const escaped = without.replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-\\u0066ull-access"')
        expect(escaped).not.toBe(without)
        expect(() => check(escaped)).toThrow(/backslash/)
      })

      it('U2B5E accepts a fresh relay fixture with startup updates disabled', () => {
        expect(withDash.split('\n')).toContain('check_for_update_on_startup = false')
        expect(without.split('\n')).toContain('check_for_update_on_startup = false')
        expect(() => check(withDash)).not.toThrow()
        expect(() => check(without)).not.toThrow()
      })

      it('accepts the relay fixture for this identity', () => {
        expect(() => check(withDash)).not.toThrow()
        expect(() => check(without)).not.toThrow()
        expect(() => check(withDash + '\n# [mcp_servers."fetch"]\n')).not.toThrow()
        const bare = withDash.replace('[mcp_servers."marveen-dashboard"]', '[mcp_servers.marveen-dashboard]')
        expect(bare).not.toBe(withDash)
        expect(() => check(bare)).not.toThrow()
      })
    })
  }
})

describe('B3 relay seat sandbox compatibility', () => {
  const fresh = () => renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY)
  const check = (content: string, opts: CodexRenderOptions = RELAY, identity: CodexIdentity = 'seat') => {
    const home = tmp()
    writeFileSync(join(home, 'config.toml'), content.replaceAll(JSON.stringify(RELAY.codexHome), JSON.stringify(home)))
    assertCodexSeatConfigCompatible(home, WS, identity, opts)
  }

  it('B4 accepts a fresh render for the same workspace and agent', () => {
    const content = fresh()
    expect(content).toContain('exclude_slash_tmp = true\nexclude_tmpdir_env_var = true\n')
    expect(content).toContain('default_permissions = "marveen-relay"')
    expect(() => check(content)).not.toThrow()
  })

  it.each([
    ['old workspace spool', (s: string) => s.replace(JSON.stringify(codexRelayDir('a')), JSON.stringify(join(WS, '.dashboard-relay')))],
    ['missing exclude_slash_tmp', (s: string) => s.replace('exclude_slash_tmp = true\n', '')],
    ['false exclude_slash_tmp', (s: string) => s.replace('exclude_slash_tmp = true', 'exclude_slash_tmp = false')],
    ['writable_roots inside the table', (s: string) => s.replace('network_access = false', 'network_access = false\nwritable_roots = []')],
    ['writable_roots outside the table', (s: string) => 'writable_roots = ["/tmp"]\n' + s],
    ['dotted sandbox key', (s: string) => 'sandbox_workspace_write.exclude_slash_tmp = false\n' + s],
    ['duplicate sandbox table', (s: string) => s + '\n[sandbox_workspace_write]\n'],
    ['duplicate sandbox setting', (s: string) => s.replace('network_access = false', 'network_access = false\nnetwork_access = false')],
    ['foreign agent name', (s: string) => s.replace('"MARVEEN_AGENT_NAME" = "a"', '"MARVEEN_AGENT_NAME" = "other"')],
  ] as const)('refuses %s', (_name, mutate) => {
    const content = fresh()
    const stale = mutate(content)
    expect(stale).not.toBe(content)
    expect(() => check(stale)).toThrow(/codexSandbox=relay refuses the existing .*Delete the file and start the agent so it is re-rendered/)
  })

  it('requires the agent name for seat identity', () => {
    expect(() => check(fresh(), { profile: 'relay' })).toThrow(/codexSandbox=relay refuses/)
  })

  it('keeps sandbox and shim env checks unchanged for overrides identity', () => {
    const stale = withoutPermissionsTable(fresh()).replace('exclude_slash_tmp = true\n', '')
      .replace(JSON.stringify(codexRelayDir('a')), '"/old/relay"')
    expect(() => check(stale, RELAY, 'overrides')).not.toThrow()
  })
})

describe('B4-overrides relay seat permissions compatibility', () => {
  const check = (content?: string, opts: CodexRenderOptions = RELAY) => {
    const home = tmp()
    if (content !== undefined) writeFileSync(join(home, 'config.toml'), content.replaceAll(JSON.stringify(RELAY.codexHome), JSON.stringify(home)))
    assertCodexSeatConfigCompatible(home, WS, 'overrides', opts)
  }

  it.each([
    ['extra filesystem write entry', '[permissions.marveen-relay.filesystem]\n"/home" = "write"\n'],
    ['dotted permissions key', 'permissions.marveen-relay.filesystem."/x" = "write"\n'],
    ['inline permissions', 'permissions = { x = 1 }\n'],
    ['profile default_permissions', '[profiles.p]\ndefault_permissions = "x"\n'],
    ['quoted permissions header', '["permissions"."marveen-relay".filesystem]\n'],
    ['dotted profile default_permissions', 'profiles.p.default_permissions = "x"\n'],
    ['default_permissions after a table header', '[projects."/w"]\ndefault_permissions = "other"\n'],
    ['permissions in a value', 'model = "permissions"\n'],
  ])('B4-overrides refuses %s', (_label, content) => {
    const refusal = _label === 'profile default_permissions'
      ? /codexSandbox=relay refuses the existing .*config\.toml: it sets Codex web search, ChatGPT apps, tools or a config profile \(\[profiles\.p\]\), which could re-enable them over the relay overrides/
      : /codexSandbox=relay refuses the existing .*config\.toml: .*relay profile table would be merged with this file's permissions settings\./
    expect(() => check(content)).toThrow(refusal)
  })

  it.each([
    ['escaped permissions key', '"permi\\u0073sions" = { x = 1 }\n'],
    ['escaped value', 'model = "x\\u0079"\n'],
    ['backslash in a comment', '# \\ forbidden even in comments\n'],
  ])('B4-overrides refuses %s', (_label, content) => {
    expect(() => check(content)).toThrow(/codexSandbox=relay refuses the existing .*config\.toml: .*backslash.*relay profile table would be merged with this file's permissions settings/)
  })

  it.each([
    ['a missing file', undefined],
    ['unrelated settings', 'model = "x"\n[projects."/w"]\ntrust_level = "trusted"\n'],
    ['top-level default_permissions', '  default_permissions \t= "other" # permissions overridden\n[projects."/w"]\n'],
    ['permissions only in comments', '# [permissions.marveen-relay.filesystem]\nmodel = "x" # permissions = {}\n'],
    ['a hash inside a quoted value followed by a comment', 'model = "x#y" # permissions = {}\n'],
  ])('B4-overrides accepts %s', (_label, content) => {
    expect(() => check(content)).not.toThrow()
  })

  it('B4-overrides asks to edit the shared seat file, never to delete it', () => {
    expect(() => check('permissions = { x = 1 }\n')).toThrow(/Remove those settings from it: under codexIdentity=overrides the dashboard never re-renders this shared seat file/)
    expect(() => check('permissions = { x = 1 }\n')).not.toThrow(/Delete the file/)
  })

  it('B4-overrides leaves full-access configs unchanged', () => {
    expect(() => check('permissions = { x = 1 }\n# \\\n', { profile: 'full-access' })).not.toThrow()
  })
})

describe('B4 named relay permissions', () => {
  const fresh = () => renderCodexConfig(WS, { 'marveen-dashboard': dash }, RELAY)
  const storeLine = () => `${JSON.stringify(join(projectRoot!, 'store'))} = "none"`
  const check = (content: string, identity: CodexIdentity = 'seat') => {
    const home = tmp()
    writeFileSync(join(home, 'config.toml'), content.replaceAll(JSON.stringify(RELAY.codexHome), JSON.stringify(home)))
    assertCodexSeatConfigCompatible(home, WS, identity, RELAY)
  }

  it('B4 renders the exact profile and overrides for a fixed workspace', () => {
    projectRoot = '/marveen-b4-fixed-root'
    expect(CODEX_RELAY_PERMISSION_PROFILE).toBe('marveen-relay')
    expect(renderCodexConfig(WS, {}, RELAY)).toBe([
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      'default_permissions = "marveen-relay"',
      'web_search = "disabled"',
      'check_for_update_on_startup = false',
      '', '[sandbox_workspace_write]',
      'network_access = false',
      'exclude_slash_tmp = true',
      'exclude_tmpdir_env_var = true',
      '', '[permissions.marveen-relay.filesystem]',
      '"/" = "read"',
      '"/tmp/cxdef-ws" = "write"',
      '"/marveen-b4-fixed-root/store" = "none"',
      `${JSON.stringify(RELAY.codexHome)} = "none"`,
      `${JSON.stringify(codexRelayMxdRunDir())} = "none"`,
      '"/marveen-b4-fixed-root/.env" = "none"',
      '"/marveen-b4-fixed-root/agents" = "none"',
      '"/marveen-cxdef-fixed/user-home/.claude/channels" = "none"',
      '"/marveen-cxdef-fixed/user-home/.gmail-mcp" = "none"',
      '', '[features]', 'apps = false',
      '', '[projects."/tmp/cxdef-ws"]',
      'trust_level = "trusted"', '', '[mcp_servers]', '',
    ].join('\n'))
    expect(renderCodexOverrides(WS, {}, RELAY)).toEqual([
      'sandbox_mode="workspace-write"',
      'approval_policy="on-request"',
      'default_permissions="marveen-relay"',
      'web_search="disabled"',
      'check_for_update_on_startup=false',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      `permissions.marveen-relay.filesystem={"/"="read","/tmp/cxdef-ws"="write","/marveen-b4-fixed-root/store"="none",${JSON.stringify(RELAY.codexHome)}="none",${JSON.stringify(codexRelayMxdRunDir())}="none","/marveen-b4-fixed-root/.env"="none","/marveen-b4-fixed-root/agents"="none","/marveen-cxdef-fixed/user-home/.claude/channels"="none","/marveen-cxdef-fixed/user-home/.gmail-mcp"="none"}`,
      'features.apps=false',
      'projects./tmp/cxdef-ws.trust_level="trusted"',
    ])
  })

  it('B4 denies the lexical and physical store roots, resolving PROJECT_ROOT at call time', () => {
    projectRoot = tmp()
    const lexical = join(projectRoot, 'store')
    expect(codexRelayDeniedReadRoots()).toEqual([lexical]) // ENOENT
    mkdirSync(lexical)
    expect(codexRelayDeniedReadRoots()).toEqual([lexical])
    rmSync(lexical, { recursive: true })
    const target = tmp()
    symlinkSync(target, lexical)
    expect(codexRelayDeniedReadRoots()).toEqual([lexical, target])
    expect(codexRelayFilesystemEntries(WS, RELAY.codexHome)).toEqual([
      ['/', 'read'], [WS, 'write'], [lexical, 'none'], [target, 'none'],
      [RELAY.codexHome, 'none'], [codexRelayMxdRunDir(), 'none'],
      [join(projectRoot, '.env'), 'none'], [join(projectRoot, 'agents'), 'none'],
      [join(USER_HOME, '.claude', 'channels'), 'none'], [join(USER_HOME, '.gmail-mcp'), 'none'],
    ])
    const out = fresh()
    expect(out).toContain(`${JSON.stringify(target)} = "none"`)
    expect(() => check(out)).not.toThrow()
    expect(() => check(out.replace(`${JSON.stringify(target)} = "none"\n`, ''))).toThrow(/codexSandbox=relay refuses/)
    projectRoot = tmp()
    expect(codexRelayDeniedReadRoots()).toEqual([join(projectRoot, 'store')])
  })

  it('B4 fails closed for realpath errors other than ENOENT', () => {
    projectRoot = tmp()
    symlinkSync('store', join(projectRoot, 'store')) // ELOOP, independent of user privileges
    expect(() => codexRelayDeniedReadRoots()).toThrow(/ELOOP/)
    expect(() => fresh()).toThrow(/ELOOP/)
    expect(() => renderCodexOverrides(WS, {}, RELAY)).toThrow(/ELOOP/)
  })

  it.each(['gmail-mcp', 'agents'])('T4 refuses a rendered seat missing the %s denial', secret => {
    projectRoot = tmp()
    const content = fresh()
    expect(() => check(content)).not.toThrow()
    const path = secret === 'agents' ? join(projectRoot, 'agents') : join(USER_HOME, '.gmail-mcp')
    const changed = content.replace(`${JSON.stringify(path)} = "none"\n`, '')
    expect(changed).not.toBe(content)
    expect(() => check(changed)).toThrow(/codexSandbox=relay refuses .*the relay filesystem table must contain exactly the rendered filesystem entries for this workspace/)
  })

  it.each(['\n', '\0'])('B4 refuses filesystem override paths containing %j', bad => {
    projectRoot = `/marveen${bad}root`
    expect(() => renderCodexOverrides(WS, {}, RELAY)).toThrow()
  })

  it('B4 refuses a physical store root containing a newline', () => {
    projectRoot = tmp()
    const target = join(tmp(), 'store\nphysical')
    mkdirSync(target)
    symlinkSync(target, join(projectRoot, 'store'))
    expect(() => renderCodexOverrides(WS, {}, RELAY)).toThrow(/newline or NUL/)
  })

  it.each([
    ['missing default_permissions', (s: string) => s.replace('default_permissions = "marveen-relay"\n', '')],
    ['other default_permissions', (s: string) => s.replace('default_permissions = "marveen-relay"', 'default_permissions = "other"')],
    ['default_permissions inside a table', (s: string) => s.replace('default_permissions = "marveen-relay"\n', '') + '\ndefault_permissions = "marveen-relay"\n'],
    ['duplicate default_permissions', (s: string) => 'default_permissions = "marveen-relay"\n' + s],
    ['missing store entry', (s: string) => s.replace(storeLine() + '\n', '')],
    ['readable store', (s: string) => s.replace(storeLine(), storeLine().replace('"none"', '"read"'))],
    ['extra write entry', (s: string) => s.replace('[permissions.marveen-relay.filesystem]', '[permissions.marveen-relay.filesystem]\n"/home" = "write"')],
    ['extends table', (s: string) => s + '\n[permissions.marveen-relay]\nextends = ":workspace"\n'],
    ['second profile table', (s: string) => s + '\n[permissions.marveen-relay.filesystem]\n'],
    ['missing profile table', (s: string) => s.replace('[permissions.marveen-relay.filesystem]', '[filesystem]')],
    ['duplicate filesystem entry', (s: string) => s.replace(storeLine(), storeLine() + '\n' + storeLine())],
    ['different workspace', (s: string) => s.replace(`"${WS}" = "write"`, '"/other" = "write"')],
    ['permissions parent table', (s: string) => s + '\n[permissions]\n'],
    ['other profile', (s: string) => s + '\n[permissions.x.filesystem]\n'],
    ['permissions array table', (s: string) => s + '\n[[permissions.marveen-relay.filesystem]]\n'],
    ['dotted permissions key', (s: string) => 'permissions.x.filesystem = {}\n' + s],
    ['extends outside the profile', (s: string) => 'extends = ":workspace"\n' + s],
    ['extends header outside the profile', (s: string) => s + '\n[extends]\n'],
  ] as const)('B4 seat refuses %s', (_label, mutate) => {
    projectRoot = tmp()
    const content = fresh()
    const changed = mutate(content)
    expect(changed).not.toBe(content)
    expect(() => check(changed)).toThrow(/codexSandbox=relay refuses the existing .*Delete the file and start the agent so it is re-rendered/)
  })

  it('B4 validates comment-stripped entry lines and refuses permissions tables for overrides', () => {
    projectRoot = tmp()
    const out = fresh()
    expect(out).toContain('default_permissions = "marveen-relay"')
    expect(() => check(out.replace(storeLine(), storeLine() + ' # hidden store'))).not.toThrow()
    expect(() => check(out.replace('default_permissions = "marveen-relay"\n', '').replace('web_search = "disabled"\n', ''), 'overrides')).toThrow(/relay profile table would be merged/)
  })
})

describe('relay secret read roots', () => {
  it('T1 returns the four lexical paths, reading PROJECT_ROOT and HOME at call time', () => {
    projectRoot = '/marveen-secret-project'
    expect(codexRelaySecretReadRoots()).toEqual([
      '/marveen-secret-project/.env', '/marveen-secret-project/agents',
      '/marveen-cxdef-fixed/user-home/.claude/channels', '/marveen-cxdef-fixed/user-home/.gmail-mcp',
    ])
    projectRoot = '/marveen-secret-project-next'
    vi.stubEnv('HOME', '/marveen-secret-home-next')
    expect(codexRelaySecretReadRoots()).toEqual([
      '/marveen-secret-project-next/.env', '/marveen-secret-project-next/agents',
      '/marveen-secret-home-next/.claude/channels', '/marveen-secret-home-next/.gmail-mcp',
    ])
  })

  it('T2 denies lexical and physical secret paths below a symlinked HOME, including missing leaves', () => {
    projectRoot = tmp()
    const physicalHome = tmp()
    const linkedHome = join(tmp(), 'home-link')
    symlinkSync(physicalHome, linkedHome)
    vi.stubEnv('HOME', linkedHome)
    const entries = codexRelayFilesystemEntries(WS, RELAY.codexHome)
    for (const path of [
      join(projectRoot, '.env'), join(projectRoot, 'agents'),
      join(linkedHome, '.claude', 'channels'), join(linkedHome, '.gmail-mcp'),
      join(physicalHome, '.claude', 'channels'), join(physicalHome, '.gmail-mcp'),
    ]) {
      expect(entries).toContainEqual([path, 'none'])
    }
    mkdirSync(join(linkedHome, '.claude', 'channels'), { recursive: true })
    mkdirSync(join(linkedHome, '.gmail-mcp'))
    expect(codexRelayFilesystemEntries(WS, RELAY.codexHome)).toEqual(entries)
  })

  it('T3 refuses the agents root but keeps a nested agent workspace writable', () => {
    projectRoot = tmp()
    const agents = join(projectRoot, 'agents')
    const ws = join(agents, 'x')
    mkdirSync(ws, { recursive: true })
    expect(() => codexRelayFilesystemEntries(agents, RELAY.codexHome)).toThrow(`relay sandbox profile refuses workspace ${agents}: it is ${agents}, which the relay hides`)
    const nested = codexRelayFilesystemEntries(ws, RELAY.codexHome)
    expect(nested).toContainEqual([ws, 'write'])
    expect(nested).toContainEqual([agents, 'none'])
  })
})

describe('scaffold logging', () => {
  it('warns with names only', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never)
    const home = join(tmp(), 'home')
    const ws = tmp()
    mkdirSync(ws, { recursive: true })
    scaffoldCodexHome(home, ws, {
      'marveen-dashboard': { command: 'node', env: { T: '${T}' } },
      other: { command: 'uvx', env: { K: '${K}' }, args: ['--secret-arg-cxdef'] },
    }, 'seat', RELAY)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dropped: ['other'] }), expect.stringContaining('codexSandbox=relay'))
    expect(JSON.stringify(spy.mock.calls)).not.toContain('--secret-arg-cxdef')
  })
})
