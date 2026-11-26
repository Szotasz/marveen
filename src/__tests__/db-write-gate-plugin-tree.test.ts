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

describe('ISOCFGENV1125: mod folders named in a settings env CLAUDE_CODE_PLUGIN_DIRS', () => {
  const other = () => join(root, 'agents', 'tomi')
  const mod = () => join(other(), '.claude-config', 'mods', 'observer')
  const setEnv = (file: string, v: string) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: v } }))
  }
  it('another agent\'s isolated settings names a folder under its own config dir: no sub-agent writes it, the owner of the dir neither', () => {
    setEnv(join(other(), '.claude-config', 'settings.json'), `${mod()}:${join(base, 'ext', 'second')}`)
    expect(write(join(mod(), 'hooks', 'register.ts'))).toEqual(SUB)
    expect(bash(`echo x >> ${join(mod(), 'hooks', 'register.ts')}`)).toEqual(SUB)
    expect(write(join(base, 'ext', 'second', 'x.ts'))).toEqual(SUB)
    const own = { cwd: other(), configDir: join(other(), '.claude-config') }
    const ownWrite = gateDecision('Write', { file_path: join(mod(), 'hooks', 'register.ts'), content: 'x' }, { ...o(own), projectDir: other() })
    expect(ownWrite).toEqual(SUB)
  })
  it('read from the main agent\'s .channels-config and an agent\'s project .claude/settings.local.json too', () => {
    setEnv(join(root, '.channels-config', 'settings.json'), join(base, 'ext', 'main-mod'))
    setEnv(join(agent, '.claude', 'settings.local.json'), join(base, 'ext', 'proj-mod'))
    expect(write(join(base, 'ext', 'main-mod', 'x.ts'))).toEqual(SUB)
    expect(write(join(base, 'ext', 'proj-mod', 'x.ts'))).toEqual(SUB)
  })
  it('the guarded and the relative are left out; a folder nobody names stays free; the main agent is not on this list', () => {
    setEnv(join(other(), '.claude-config', 'settings.json'), `relative/mod::${root}:${join(root, 'agents')}`)
    expect(write(join(base, 'ext', 'free', 'x.ts'))).toEqual({ deny: false })
    expect(write(join(agent, 'work', 'x.ts'))).toEqual({ deny: false })
    setEnv(join(other(), '.claude-config', 'settings.json'), mod())
    expect(write(join(mod(), 'x.ts'), { subAgent: false, cwd: root })).toEqual({ deny: false })
  })
  it('a broken settings file or a non-string value adds nothing', () => {
    mkdirSync(join(other(), '.claude-config'), { recursive: true })
    writeFileSync(join(other(), '.claude-config', 'settings.json'), '{not json')
    expect(write(join(mod(), 'x.ts'))).toEqual({ deny: false })
    writeFileSync(join(other(), '.claude-config', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 42 } }))
    expect(write(join(mod(), 'x.ts'))).toEqual({ deny: false })
  })
})

describe('PLUGINDIRANCESTOR1125: a named folder outside the root and $HOME, its ancestors, and the raw claudeConfigDir', () => {
  const ext = () => join(base, 'ext')
  const named = () => join(ext(), 'a', 'mod')
  const setEnv = (file: string, v: string) => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: v } }))
  }
  beforeEach(() => setEnv(join(root, 'agents', 'tomi', '.claude-config', 'settings.json'), named()))
  it.each([
    () => `mv ${join(ext(), 'a')} ${join(ext(), 'a-old')}`,
    () => `mv ${join(base, 'prep')} ${join(ext(), 'a')}`,
    () => `ln -sfn ${join(base, 'prep')} ${join(ext(), 'a')}`,
    () => `mv ${ext()} ${join(base, 'ext-old')}`,
    () => `rm -rf ${join(ext(), 'a')}`,
  ])('an ancestor swap of the named folder is denied: %#', (c) => {
    expect(bash(c())).toEqual(SUB)
  })
  it('the same for a directory marketplace outside the root and $HOME', () => {
    setEnv(join(root, 'agents', 'tomi', '.claude-config', 'settings.json'), '')
    mkdirSync(join(root, '.channels-config', 'plugins'), { recursive: true })
    writeFileSync(join(root, '.channels-config', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ dir: { source: { source: 'directory', path: join(ext(), 'mk', 'market') } } }))
    expect(bash(`mv ${join(ext(), 'mk')} ${join(ext(), 'mk-old')}`)).toEqual(SUB)
  })
  it('free: a sibling, a reader on the ancestor, and `/` itself', () => {
    expect(write(join(ext(), 'b', 'x.ts'))).toEqual({ deny: false })
    expect(bash(`mv ${join(ext(), 'b')} ${join(ext(), 'b-old')}`).deny).toBe(false)
    expect(bash(`ls ${join(ext(), 'a')}`).deny).toBe(false)
    expect(bash('find / -name nothing-here -maxdepth 1').deny).toBe(false)
  })
  it('an agent\'s raw claudeConfigDir (no plan) is a config root: its settings env and its plugins dir', () => {
    const cfg = join(base, 'rawcfg')
    writeFileSync(join(agent, 'agent-config.json'), JSON.stringify({ claudeConfigDir: cfg }))
    setEnv(join(cfg, 'settings.json'), join(ext(), 'raw-mod'))
    expect(write(join(ext(), 'raw-mod', 'x.ts'))).toEqual(SUB)
    expect(write(join(cfg, 'plugins', 'installed_plugins.json'))).toEqual(SUB)
  })
})

// PLUGINDIRGIT1125 (Geri 85505, the #3142 follow-up): a named folder inside a git work tree is rewritten by a git that
// writes that tree from its top, which names the tree, not the folder. Denied for a sub-agent; reads, add/commit and a
// tree without a named folder (an agent's own worktree) stay free.
describe('PLUGINDIRGIT1125: git verbs on a work tree that holds a named plugin folder', () => {
  const repo = () => join(base, 'ext-repo')
  const own = () => join(base, 'own-wt')
  beforeEach(() => {
    mkdirSync(join(repo(), '.git'), { recursive: true })
    mkdirSync(join(repo(), 'mods', 'm'), { recursive: true })
    mkdirSync(join(own(), '.git'), { recursive: true })
    const f = join(root, 'agents', 'tomi', '.claude-config', 'settings.json')
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: join(repo(), 'mods', 'm') } }))
  })
  it.each([
    () => `git -C ${repo()} checkout .`,
    () => `git -C ${repo()} reset --hard HEAD~1`,
    () => `git -C ${join(repo(), 'mods')} restore .`,
    () => `cd ${repo()} && git clean -fdx`,
    () => `cd ${repo()} && git stash pop`,
    () => `git -C ${repo()} switch other`,
    () => `git -C ${repo()} pull`,
    () => `git -C ${repo()} merge topic`,
    () => `git --work-tree=${repo()} checkout -- .`,
    () => `git -C ${own()} worktree remove ${repo()}`,
    () => `git -C ${own()} worktree add ${repo()} topic`,
    () => `git clone https://example.com/x/y.git ${repo()}`,
    () => `cd ${base} && git clone --depth 1 https://example.com/x/ext-repo.git`,
  ])('denied for a sub-agent: %#', (c) => {
    expect(bash(c())).toEqual(SUB)
  })
  it('an unknown directory: denied (the main-checkout rule reads it as the install already, so the reason stays git)', () => {
    expect(bash('git -C "$R" checkout .')).toEqual({ deny: true, reason: 'git' })
  })
  it.each([
    () => `git -C ${repo()} status`,
    () => `git -C ${repo()} log --oneline -3`,
    () => `git -C ${repo()} diff`,
    () => `git -C ${repo()} add . && git -C ${repo()} commit -m x`,
    () => `git -C ${repo()} fetch origin`,
    () => `git -C ${own()} checkout -b topic`,
    () => `git -C ${own()} reset --hard origin/develop`,
    () => `git -C ${own()} worktree add ${join(base, 'own-wt-2')} -b t2`,
    () => `git clone https://example.com/x/y.git ${join(base, 'other')}`,
  ])('free for a sub-agent: %#', (c) => {
    expect(bash(c()).deny).toBe(false)
  })
  it('the main agent is not under this rule', () => {
    expect(bash(`git -C ${repo()} reset --hard HEAD~1`, { subAgent: false, cwd: root }).deny).toBe(false)
  })
  // Samu's #3145 review: core.worktree points a repository's work tree elsewhere, and repoTop reads only the .git entry.
  // So it is a protected git key now, set (`git config`) or for one call (`-c`), as the remote URLs and hooksPath are.
  it.each([
    () => `git -C ${own()} config core.worktree ${repo()}`,
    () => `git -C ${own()} config --local core.worktree ${repo()}`,
    () => `git -C ${own()} config set core.worktree ${repo()}`,
    () => `git -C ${own()} -c core.worktree=${repo()} checkout -- .`,
    () => `git -C ${own()} -c CORE.WORKTREE=${repo()} checkout -- .`,
  ])('core.worktree cannot be set or passed: %#', (c) => {
    expect(bash(c()).deny).toBe(true)
  })
  it('core.worktree may be read', () => {
    expect(bash(`git -C ${own()} config --get core.worktree`).deny).toBe(false)
    expect(bash(`git -C ${own()} config core.worktree`).deny).toBe(false)
  })
  it('a named folder that is not inside a git work tree: a git from its parent is not this rule\'s', () => {
    rmSync(join(repo(), '.git'), { recursive: true, force: true })
    expect(bash(`git -C ${repo()} checkout .`).deny).toBe(false)
    expect(bash(`git clone https://example.com/x/y.git ${repo()}`).deny).toBe(true)   // clone INTO the folder's parent: still
  })
})

// PLUGINDIRGIT2-1126 (Samu 85549/85602, Geri 85548): two more ways a git writes a work tree the command does not name.
// core.worktree in the repository's own config (already there, written earlier or with the Write tool) moves the tree a
// tree-writing verb rewrites; a push to a local repository (a path, ".", file://, a remote whose URL is local) updates
// that repository's checked-out tree when it sets receive.denyCurrentBranch=updateInstead. Both are measured on the tree
// git would really write.
describe('PLUGINDIRGIT2-1126: core.worktree from the config, and a push to a local repository', () => {
  const repo = () => join(base, 'ext-repo')
  const own = () => join(base, 'own-wt')
  const clean = () => join(base, 'clean-repo')
  const cfg = (dir: string, text: string) => writeFileSync(join(dir, 'config'), text)
  beforeEach(() => {
    mkdirSync(join(repo(), '.git'), { recursive: true })
    mkdirSync(join(repo(), 'mods', 'm'), { recursive: true })
    mkdirSync(join(own(), '.git'), { recursive: true })
    mkdirSync(join(clean(), '.git'), { recursive: true })
    const f = join(root, 'agents', 'tomi', '.claude-config', 'settings.json')
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: join(repo(), 'mods', 'm') } }))
  })

  describe('core.worktree read from the repository config', () => {
    it.each([
      ['absolute', () => `[core]\n\tbare = false\n\tworktree = ${repo()}\n`],
      ['relative to the .git directory', () => '[core]\n\tworktree = ../../ext-repo\n'],
      ['quoted, mixed-case key and section', () => `[Core]\n\tWorkTree = "${repo()}" ; moved\n`],
      ['old-style section on one line with the key', () => `[core] worktree = ${repo()}\n`],
    ])('a tree-writing verb in a checkout whose config points at the folder\'s tree: denied (%s)', (_n, text) => {
      cfg(join(own(), '.git'), text())
      expect(bash(`git -C ${own()} checkout .`)).toEqual(SUB)
      expect(bash(`cd ${own()} && git reset --hard HEAD~1`)).toEqual(SUB)
    })
    it('a linked worktree: its config.worktree and the shared config are both read', () => {
      const wt = join(base, 'linked')
      const gd = join(own(), '.git', 'worktrees', 'linked')
      mkdirSync(gd, { recursive: true })
      mkdirSync(wt, { recursive: true })
      writeFileSync(join(wt, '.git'), `gitdir: ${gd}\n`)
      writeFileSync(join(gd, 'commondir'), '../..\n')
      writeFileSync(join(gd, 'config.worktree'), `[core]\n\tworktree = ${repo()}\n`)
      expect(bash(`git -C ${wt} checkout .`)).toEqual(SUB)
      rmSync(join(gd, 'config.worktree'))
      cfg(join(own(), '.git'), `[core]\n\tworktree = ${repo()}\n`)
      expect(bash(`git -C ${wt} checkout .`)).toEqual(SUB)
    })
    it('--git-dir: its core.worktree, else the current directory, is the tree', () => {
      cfg(join(own(), '.git'), `[core]\n\tworktree = ${repo()}\n`)
      expect(bash(`cd ${base} && git --git-dir=${join(own(), '.git')} checkout .`)).toEqual(SUB)
      cfg(join(own(), '.git'), '[core]\n\tbare = false\n')
      expect(bash(`cd ${repo()} && git --git-dir=${join(own(), '.git')} checkout -f .`)).toEqual(SUB)
      expect(bash(`cd ${clean()} && git --git-dir=${join(own(), '.git')} checkout -f .`).deny).toBe(false)
    })
    it('a config the gate cannot read whole (an include) fails closed', () => {
      cfg(join(own(), '.git'), '[include]\n\tpath = ../elsewhere.cfg\n')
      expect(bash(`git -C ${own()} checkout .`)).toEqual(SUB)
    })
    it.each([
      ['core.worktree points at a tree without a named folder', () => { cfg(join(own(), '.git'), `[core]\n\tworktree = ${clean()}\n`) }, () => `git -C ${own()} checkout .`],
      ['--work-tree overrides the config', () => { cfg(join(own(), '.git'), `[core]\n\tworktree = ${repo()}\n`) }, () => `git -C ${own()} --work-tree=${clean()} checkout -- .`],
      ['a read in a checkout pointed at the folder\'s tree', () => { cfg(join(own(), '.git'), `[core]\n\tworktree = ${repo()}\n`) }, () => `git -C ${own()} status`],
      ['the key in another section', () => { cfg(join(own(), '.git'), `[remote "origin"]\n\tworktree = ${repo()}\n\turl = https://example.com/x.git\n`) }, () => `git -C ${own()} checkout .`],
    ])('free: %s', (_n, setup, c) => {
      setup()
      expect(bash(c()).deny).toBe(false)
    })
  })

  describe('a push to a local repository (receive.denyCurrentBranch=updateInstead)', () => {
    it.each([
      () => `git -C ${own()} push ${repo()} HEAD:main`,
      () => `git -C ${own()} push file://${repo()} topic`,
      () => `git -C ${own()} push --repo=${repo()}`,
      () => `git -C ${own()} push -o ci.skip ${repo()} topic`,
      () => `git -C ${repo()} push . HEAD:main`,
      () => `cd ${base} && git push ext-repo topic`,
      () => `git -C ${own()} push ../ext-repo topic`,
    ])('denied: %#', (c) => {
      expect(bash(c())).toEqual(SUB)
    })
    it('a remote whose URL is local, named or as the default (no target: every remote, the strict direction)', () => {
      cfg(join(own(), '.git'), `[remote "loc"]\n\turl = ${repo()}\n\tfetch = +refs/heads/*:refs/remotes/loc/*\n`)
      expect(bash(`git -C ${own()} push loc topic`)).toEqual(SUB)
      expect(bash(`git -C ${own()} push`)).toEqual(SUB)
      cfg(join(own(), '.git'), `[remote "origin"]\n\turl = https://example.com/x.git\n\tpushurl = ${repo()}\n`)
      expect(bash(`git -C ${own()} push origin topic`)).toEqual(SUB)
    })
    it('a target repository whose own core.worktree points at the folder\'s tree', () => {
      const bare = join(base, 'bare.git')
      mkdirSync(bare, { recursive: true })
      writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
      cfg(bare, `[core]\n\tbare = false\n\tworktree = ${repo()}\n`)
      expect(bash(`git -C ${own()} push ${bare} topic`)).toEqual(SUB)
    })
    // Samu's #3156 review: url.<base>.insteadOf / pushInsteadOf in the clone's own config rewrite a target into a local
    // repository; any such entry fails closed for a push.
    it.each([
      ['insteadOf, a target that looks like a relative path', () => `[url "${repo()}"]\n\tinsteadOf = x:\n`, () => `git -C ${own()} push x:anything topic`],
      ['pushInsteadOf, a target that looks like a relative path', () => `[url "${repo()}"]\n\tpushInsteadOf = x:\n`, () => `git -C ${own()} push x:anything topic`],
      ['pushInsteadOf, a network-looking URL', () => `[url "${repo()}"]\n\tpushInsteadOf = https://example.com/\n`, () => `git -C ${own()} push https://example.com/y.git topic`],
      ['insteadOf, mixed case, under a remote with a network URL', () => `[url "${repo()}"]\n\tInsteadOf = https://example.com/\n[remote "origin"]\n\turl = https://example.com/y.git\n`, () => `git -C ${own()} push origin topic`],
    ])('a url rewrite in the repository config fails closed: %s', (_n, text, c) => {
      cfg(join(own(), '.git'), text())
      expect(bash(c())).toEqual(SUB)
    })
    it('a config the gate cannot read whole (an include holding a pushInsteadOf) fails a push closed, whatever the target', () => {
      cfg(join(own(), '.git'), '[include]\n\tpath = extra.cfg\n')
      writeFileSync(join(own(), '.git', 'extra.cfg'), `[url "${repo()}"]\n\tpushInsteadOf = x:\n`)
      expect(bash(`git -C ${own()} push x:anything topic`)).toEqual(SUB)
      // a target that resolves outside every git repository: only the unreadable-config rule stops it (the relative
      // form above lands inside the clone, whose unreadable config fails closed on its own)
      writeFileSync(join(own(), '.git', 'extra.cfg'), `[url "${repo()}"]\n\tpushInsteadOf = ${join(base, 'nowhere')}/\n`)
      expect(bash(`git -C ${own()} push ${join(base, 'nowhere', 'y')} topic`)).toEqual(SUB)
    })
    it('an unknown target fails closed', () => {
      expect(bash(`git -C ${own()} push "$T" topic`)).toEqual(SUB)
    })
    it.each([
      ['a network remote', () => { cfg(join(own(), '.git'), '[remote "origin"]\n\turl = https://example.com/x.git\n') }, () => `git -C ${own()} push origin topic`],
      ['a URL', () => {}, () => `git -C ${own()} push https://example.com/x.git topic`],
      ['an scp-style remote', () => {}, () => `git -C ${own()} push git@example.com:x/y.git topic`],
      ['"." in a checkout without a named folder', () => {}, () => `git -C ${own()} push . topic:other`],
      ['a local repository without a named folder', () => {}, () => `git -C ${own()} push ${clean()} topic`],
      ['the default push with only network remotes', () => { cfg(join(own(), '.git'), '[remote "origin"]\n\turl = https://example.com/x.git\n') }, () => `git -C ${own()} push`],
    ])('free: %s', (_n, setup, c) => {
      setup()
      expect(bash(c()).deny).toBe(false)
    })
    it('the main agent is not under this rule', () => {
      expect(bash(`git -C ${own()} push ${repo()} HEAD:main`, { subAgent: false, cwd: root }).deny).toBe(false)
    })
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
