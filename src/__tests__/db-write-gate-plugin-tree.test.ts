// PLUGINCODEWRITE1104: a sub-agent may not write the Claude Code plugin trees or the shared user-level trees every
// session loads (~/.claude/plugins, <root>/plugins, ~/marveen-local-plugins, ~/.claude/agents|skills|hooks, each agent's
// plugin registries, the workers' plugins, a plugin's installPath outside the cache, other config roots' plugins), nor
// run `claude plugin` beyond list/validate/marketplace list/--help. The decision functions only read paths: nothing
// here writes to the home directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, dynamicPluginEntries, claudePluginWrite } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

let base: string
let root: string
let agent: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-tree-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  mkdirSync(join(agent, '.claude-config', 'plugins'), { recursive: true })
  mkdirSync(join(agent, 'work'), { recursive: true })
  mkdirSync(join(root, 'plugins', 'worksource'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const H = homedir()
const SUB = { deny: true, reason: 'subagent-file' }
const o = (x: { cwd?: string; subAgent?: boolean; configDir?: string | null } = {}) =>
  ({ root, cwd: x.cwd ?? agent, subAgent: x.subAgent ?? true, projectDir: x.subAgent === false ? root : agent, configDir: x.configDir ?? join(agent, '.claude-config') })
const write = (p: string, x?: Parameters<typeof o>[0]) => gateDecision('Write', { file_path: p, content: 'x' }, o(x))
const bash = (c: string, x?: Parameters<typeof o>[0]) => gateDecision('Bash', { command: c }, o(x))

describe('the static targets: a sub-agent may not write them', () => {
  const targets = () => [
    join(H, '.claude', 'plugins', 'cache', 'm', 'p', '1.0', 'server.ts'),
    join(H, '.claude', 'plugins', 'known_marketplaces.json'),
    join(root, 'plugins', 'worksource', 'server.mjs'),
    join(H, 'marveen-local-plugins', 'gromzo', 'gromzo-channel', 'server.ts'),
    join(H, '.claude', 'agents', 'x.md'),
    join(H, '.claude', 'skills', 'x', 'SKILL.md'),
    join(H, '.claude', 'hooks', 'x.cjs'),
    join(agent, '.claude-config', 'plugins', 'installed_plugins.json'),
    join(root, 'agents', 'other', '.claude-config', 'plugins', 'known_marketplaces.json'),
    join(H, '.marveen-worker', '.claude-config', 'plugins', 'x.json'),
    join(H, '.marveen-worker-fast', '.claude-config', 'plugins', 'x.json'),
  ]
  it('native Write', () => {
    for (const t of targets()) expect(write(t)).toEqual(SUB)
  })
  it('through the agent\'s own config-dir symlink (the real path lands on the shared tree)', () => {
    symlinkSync(join(H, '.claude', 'plugins', 'cache'), join(agent, '.claude-config', 'plugins', 'cache'))
    expect(write(join(agent, '.claude-config', 'plugins', 'cache', 'm', 'x.ts'))).toEqual(SUB)
  })
  it('the caller\'s own config dir plugins, outside the install (a worker), per call', () => {
    const cfg = join(base, 'w', '.claude-config')
    expect(write(join(cfg, 'plugins', 'x.json'), { configDir: cfg })).toEqual(SUB)
  })
  it('an MCP read of the plugin tree is denied for a sub-agent (D2), free for the main agent', () => {
    const p = join(H, '.claude', 'plugins', 'cache', 'm', 'x.ts')
    expect(gateDecision('mcp__Filesystem__read_file', { path: p }, o()).deny).toBe(true)
    expect(gateDecision('mcp__Filesystem__read_file', { path: p }, o({ subAgent: false, cwd: root })).deny).toBe(false)
  })
})

describe('Bash: bare names, ancestors below $HOME, $CLAUDE_CONFIG_DIR', () => {
  it.each([
    ['cd ~/.claude && rm -rf plugins', undefined],
    ['rm -rf plugins', join(H, '.claude')],
    ['cd ~/marveen-local-plugins && rm -rf gromzo', undefined],
    ['rsync -a /tmp/x/ ~/.claude/', undefined],
    ['cp -R /tmp/x/plugins ~/.claude/', undefined],
    ['cp -R src/ ~/.claude/', undefined],
    ['tar -xf /tmp/p.tar', join(H, '.claude')],
    ['mv ~/.claude ~/.claude.bak', undefined],
    ['echo x > $CLAUDE_CONFIG_DIR/plugins/installed_plugins.json', undefined],
    ['cp /tmp/evil ${CLAUDE_CONFIG_DIR}/plugins/cache/x/server.ts', undefined],
    ['cp -l ~/.claude/skills/x/SKILL.md .', undefined],
  ])('denied: %s (cwd %s)', (c, cwd) => {
    expect(bash(c, cwd ? { cwd } : undefined).deny).toBe(true)
  })
  it('E4: $CLAUDE_CONFIG_DIR/settings.json, the #2494 gap (an agents/*/ config settings: common list, install-file)', () => {
    expect(bash('echo x > $CLAUDE_CONFIG_DIR/settings.json').deny).toBe(true)
    // a worker's config dir outside the install: the caller entry, sub-agent list
    const cfg = join(base, 'w', '.claude-config')
    expect(bash('echo x > ${CLAUDE_CONFIG_DIR}/settings.json', { configDir: cfg })).toEqual(SUB)
  })
  it('cp into one\'s own agent dir lands each copy: a protected landing place is denied', () => {
    expect(bash('cp ~/.claude/skills/x/settings.json .claude/').deny).toBe(true)
    expect(bash('cp ~/.claude/skills/x/SKILL.md ./').deny).toBe(false)
  })
  it.each([
    ['cd ~/.claude && ls', undefined],
    ['cat ~/.claude/plugins/installed_plugins.json', undefined],
    ['jq . ~/.claude/plugins/known_marketplaces.json', undefined],
    ['cp ~/.claude/skills/x/SKILL.md .', undefined],
    ['tar -xf y', join(H, '.claude', 'projects', 'x')],
    ['cp /tmp/a work/', undefined],
  ])('free: %s (cwd %s)', (c, cwd) => {
    expect(bash(c, cwd ? { cwd } : undefined).deny).toBe(false)
  })
  it('free: a memory file under ~/.claude/projects', () => {
    expect(write(join(H, '.claude', 'projects', 'x', 'memory', 'note.md'))).toEqual({ deny: false })
  })
  it('stated limit (D3): $HOME itself is not an ancestor target', () => {
    expect(bash('rsync -a /tmp/x/ ~/').deny).toBe(false)
  })
  it('the main agent writes the plugin tree', () => {
    expect(write(join(H, '.claude', 'plugins', 'cache', 'm', 'x.ts'), { subAgent: false, cwd: root })).toEqual({ deny: false })
    expect(bash('claude plugin install x@y', { subAgent: false, cwd: root }).deny).toBe(false)
  })
})

describe('dynamic targets: installPath outside the cache, directory marketplaces, other config roots', () => {
  const reg = () => join(base, 'reg')
  const src = (otherRoots: string[] = []) => ({ otherRoots, regDirs: [reg()], sig: 'test' })
  beforeEach(() => mkdirSync(reg(), { recursive: true }))
  it('takes absolute installPaths and directory/file marketplace paths; leaves out the guarded and the too-broad', () => {
    writeFileSync(join(reg(), 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'a@m': [{ installPath: join(base, 'ext', 'a') }],
      'b@m': [{ installPath: '/' }, { installPath: '/tmp' }, { installPath: '~/.claude' }, { installPath: H }],
      'c@m': [{ installPath: root }, { installPath: join(root, 'agents') }, { installPath: agent }],
      'd@m': [{ installPath: 'relative/x' }, { installPath: join(H, '.claude', 'plugins', 'cache', 'm', 'd') }],
    } }))
    writeFileSync(join(reg(), 'known_marketplaces.json'), JSON.stringify({
      dir: { source: { source: 'directory', path: join(base, 'ext', 'mk') }, installLocation: join(base, 'ext', 'mk') },
      file: { source: { source: 'file', path: join(base, 'ext', 'fm', 'marketplace.json') } },
      gh: { source: { source: 'github', repo: 'x/y' }, installLocation: join(H, '.claude', 'plugins', 'marketplaces', 'gh') },
    }))
    const got = dynamicPluginEntries(root, agent, src()).map((e: { abs: string }) => e.abs).sort()
    expect(got).toEqual([join(base, 'ext', 'a'), join(base, 'ext', 'fm'), join(base, 'ext', 'mk')].sort())
  })
  it('other config roots: their plugins dir', () => {
    const got = dynamicPluginEntries(root, agent, src([join(base, 'maincfg')])).map((e: { abs: string }) => e.abs)
    expect(got).toContain(join(base, 'maincfg', 'plugins'))
  })
  it('a missing or broken registry adds nothing; the cap is 200', () => {
    expect(dynamicPluginEntries(root, agent, src())).toEqual([])
    writeFileSync(join(reg(), 'installed_plugins.json'), '{not json')
    expect(dynamicPluginEntries(root, agent, src())).toEqual([])
    const plugins: Record<string, unknown> = {}
    for (let i = 0; i < 250; i++) plugins[`p${i}@m`] = [{ installPath: join(base, 'ext', `p${i}`) }]
    writeFileSync(join(reg(), 'installed_plugins.json'), JSON.stringify({ plugins }))
    expect(dynamicPluginEntries(root, agent, src())).toHaveLength(200)
  })
  it('end to end through the gate: the main agent\'s isolated registry and MAIN_AGENT_CONFIG_DIR / a plan configDir', () => {
    mkdirSync(join(root, '.channels-config', 'plugins'), { recursive: true })
    mkdirSync(join(root, 'store'), { recursive: true })
    writeFileSync(join(root, '.channels-config', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'z@m': [{ installPath: join(base, 'ext', 'z') }] } }))
    writeFileSync(join(root, '.env'), `MAIN_AGENT_CONFIG_DIR=${join(base, 'maincfg')}\n`)
    writeFileSync(join(root, 'store', 'claude-plans.json'), JSON.stringify([{ id: 'p', label: 'p', configDir: join(base, 'plancfg') }]))
    expect(write(join(base, 'ext', 'z', 'server.ts'))).toEqual(SUB)
    expect(write(join(base, 'maincfg', 'plugins', 'x.json'))).toEqual(SUB)
    expect(write(join(base, 'plancfg', 'plugins', 'x.json'))).toEqual(SUB)
    expect(write(join(base, 'ext', 'other', 'x.ts'))).toEqual({ deny: false })
  })
})

describe('the `claude plugin` CLI (allowlist)', () => {
  it.each([
    'claude plugin install x@m', 'claude plugins i x', 'claude plugin uninstall x', 'claude plugin enable x',
    'claude plugin update x', 'claude plugin marketplace add ./y', 'claude plugin marketplace remove m',
    'claude plugin marketplace update', 'CLAUDE_CONFIG_DIR=/tmp/c claude plugin install x', 'claude --plugin-dir /tmp/p',
    "claude --settings '{\"enabledPlugins\":{\"x@m\":true}}'",
  ])('denied for a sub-agent: %s', (c) => {
    expect(claudePluginWrite(c)).toBe(true)
    expect(bash(c)).toEqual(SUB)
  })
  it.each(['claude plugin list', 'claude plugin validate .', 'claude plugin marketplace list', 'claude plugin install --help', 'claude plugin'])(
    'free: %s', (c) => {
      expect(bash(c).deny).toBe(false)
    })
  it('stated limit: a `claude` run on a customer machine over ssh is not at a segment start, not seen', () => {
    expect(bash('ssh host "claude plugin marketplace add x && claude plugin install y"').deny).toBe(false)
  })
})
