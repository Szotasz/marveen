// ENVRELAXGATE1104 (Samu 67797 (a)): every agent's own agents/<name>/.claude/settings.json and settings.local.json are
// on the db-write-gate's COMMON list: a sub-agent's gate hooks live there, so one edit takes a gate out. Only the
// dashboard writes them; no agent does, the main agent included. `*` is one segment; agents/<name> is not an ancestor,
// so the work there (cp x ., a note file) stays free, and a directory changer naming its .claude directory is caught on
// its own (claudeDirCopyIn). A text brake, not an OS boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, PROTECTED_INSTALL_PATHS, isSubAgentCaller, INSTALL_ROOT } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'

let base: string
let root: string
let wt: string
let agent: string
let other: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-settings-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  agent = join(root, 'agents', 'samu')
  other = join(root, 'agents', 'qwen')
  for (const d of [agent, other, join(wt, 'agents', 'samu')]) {
    mkdirSync(join(d, '.claude'), { recursive: true })
    writeFileSync(join(d, '.claude', 'settings.json'), '{}')
  }
  mkdirSync(join(root, 'store'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const DENY = { deny: true, reason: 'install-file' }
const bash = (command: string, cwd: string, subAgent: boolean) =>
  gateDecision('Bash', { command: command.replaceAll('@ROOT@', root) }, { cwd, root, subAgent })
const file = (tool: string, file_path: string, cwd: string, subAgent: boolean) =>
  gateDecision(tool, { file_path, content: '{"disableAllHooks": true}' }, { cwd, root, subAgent })

it('the three files are on the COMMON list, as one-segment patterns', () => {
  const rels = PROTECTED_INSTALL_PATHS.filter((t: { pattern?: boolean }) => t.pattern).map((t: { rel: string }) => t.rel)
  expect(rels).toEqual(['agents/*/.claude/settings.json', 'agents/*/.claude/settings.local.json', 'agents/*/.claude-config/settings.json'])
})

for (const who of [{ label: 'a sub-agent', subAgent: true }, { label: 'the main agent', subAgent: false }]) {
  describe(`${who.label}: writing an agent's own settings is denied`, () => {
    for (const f of ['settings.json', 'settings.local.json']) {
      it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(`%s on its own .claude/${f}`, (tool) => {
        expect(file(tool, join(agent, '.claude', f), agent, who.subAgent)).toEqual(DENY)
      })
      it(`a relative path, another agent's, a symlink, upper case: ${f}`, () => {
        expect(file('Write', `.claude/${f}`, agent, who.subAgent)).toEqual(DENY)
        expect(file('Write', join(other, '.claude', f), agent, who.subAgent)).toEqual(DENY)
        symlinkSync(join(agent, '.claude', 'settings.json'), join(base, 'innocent'))
        expect(file('Write', join(base, 'innocent'), agent, who.subAgent)).toEqual(DENY)
        expect(file('Write', join(agent, '.CLAUDE', f.toUpperCase()), agent, who.subAgent)).toEqual(DENY)
      })
      it.each([
        `echo '{"disableAllHooks": true}' > .claude/${f}`,
        `echo x >| .claude/${f}`,
        `echo x >> .claude/${f}`,
        `jq 'del(.hooks)' .claude/settings.json | tee .claude/${f}`,
        `sed -i '' 's/db-write-gate/x/' .claude/${f}`,
        `cp /tmp/x .claude/${f}`,
        `rm .claude/${f}`,
        `python3 -c "open('.claude/${f}','w').write('{}')"`,
        `echo x > @ROOT@/agents/samu/.claude/${f}`,
        `echo x > ../qwen/.claude/${f}`,
        `cp /tmp/x @ROOT@/agents/*/.claude/${f}`,
      ])(`Bash: %s`, (command) => {
        expect(bash(command, agent, who.subAgent)).toEqual(DENY)
      })
    }
    it('a glob word with the agent named (the pattern\'s * against a literal segment)', () => {
      expect(bash('cp /tmp/x .claude/settings.j*', agent, who.subAgent)).toEqual(DENY)
      expect(bash('echo x > @ROOT@/agents/samu/.claude/settings.*', agent, who.subAgent)).toEqual(DENY)
    })
    it('the .claude directory itself: moving, removing, replacing, re-permissioning it', () => {
      expect(bash('chmod -R a+w .claude', agent, who.subAgent)).toEqual(DENY)
      expect(bash('mv .claude .claude-old', agent, who.subAgent)).toEqual(DENY)
      expect(bash('rm -rf .claude', agent, who.subAgent)).toEqual(DENY)
      expect(bash('cp -r /tmp/evil/.claude .', agent, who.subAgent)).toEqual(DENY)
      expect(bash('cp -r /tmp/evil/.c* .', agent, who.subAgent)).toEqual(DENY)
      expect(bash(`rsync -a /tmp/evil/.claude ${'@ROOT@'}/agents/qwen/`, root, who.subAgent)).toEqual(DENY)
    })
  })
}

describe('what stays free', () => {
  it.each([
    'cat .claude/settings.json',
    "jq '.hooks.PreToolUse | length' .claude/settings.json",
    'grep -c db-write-gate .claude/settings.json',
  ])('a read: %s', (command) => {
    expect(bash(command, agent, true).deny).toBe(false)
  })
  it('the work in the agent\'s own directory: files, cp into ., its other .claude files', () => {
    expect(file('Write', join(agent, 'work', 'notes.md'), agent, true)).toEqual({ deny: false })
    expect(file('Write', join(agent, 'HANDOFF.md'), agent, true)).toEqual({ deny: false })
    expect(bash('cp /tmp/report.md .', agent, true).deny).toBe(false)
    expect(bash('mkdir -p work && cp /tmp/a work/', agent, true).deny).toBe(false)
    expect(file('Write', join(agent, '.claude', 'skills', 'x', 'SKILL.md'), agent, true)).toEqual({ deny: false })
    expect(bash('cp ~/.claude/skills/x/SKILL.md .', agent, true).deny).toBe(false)
    expect(bash('cp -r /tmp/evil/.claude /tmp/elsewhere/', agent.replace('/agents/samu', '/store'), true).deny).toBe(false)
  })
  it('a worktree\'s agents/<name>/.claude/settings.json (another root)', () => {
    expect(file('Write', join(wt, 'agents', 'samu', '.claude', 'settings.json'), agent, true)).toEqual({ deny: false })
  })
  it('a deeper path is not the pattern (agents/<a>/<b>/.claude/settings.json)', () => {
    expect(file('Write', join(agent, 'sub', '.claude', 'settings.json'), agent, true)).toEqual({ deny: false })
  })
})

// Samu 67803: the CALLER's own <CLAUDE_PROJECT_DIR>/.claude/settings*.json is on the sub-agent list too, as a per-call
// entry, so a caller whose project dir is NOT under the install's agents/ (a worker) is covered as well.
describe('the caller\'s own project settings, outside the install (sub-agent list, per call)', () => {
  const proj = () => join(base, 'worker-project')
  beforeEach(() => {
    mkdirSync(join(proj(), '.claude'), { recursive: true })
    writeFileSync(join(proj(), '.claude', 'settings.json'), '{}')
  })
  const call = (tool: string, input: Record<string, unknown>, subAgent: boolean, projectDir: string | null) =>
    gateDecision(tool, input, { cwd: proj(), root, subAgent, projectDir })
  const SUB_DENY = { deny: true, reason: 'subagent-file' }
  for (const f of ['settings.json', 'settings.local.json']) {
    it(`a sub-agent may not write its own ${f}: Write, Edit, >, >|, >>`, () => {
      expect(call('Write', { file_path: join(proj(), '.claude', f), content: '{}' }, true, proj())).toEqual(SUB_DENY)
      expect(call('Edit', { file_path: `.claude/${f}`, old_string: 'a', new_string: 'b' }, true, proj())).toEqual(SUB_DENY)
      for (const op of ['>', '>|', '>>']) expect(call('Bash', { command: `echo x ${op} .claude/${f}` }, true, proj())).toEqual(SUB_DENY)
    })
  }
  it('a read is free', () => {
    expect(call('Bash', { command: 'cat .claude/settings.json' }, true, proj()).deny).toBe(false)
  })
  it('control: the same path for the main agent, or for a sub-agent whose project it is not, is free', () => {
    expect(call('Write', { file_path: join(proj(), '.claude', 'settings.json'), content: '{}' }, false, proj())).toEqual({ deny: false })
    expect(call('Write', { file_path: join(proj(), '.claude', 'settings.json'), content: '{}' }, true, join(base, 'elsewhere'))).toEqual({ deny: false })
  })
  it('two callers in one process: each gets its OWN entries (the target cache is keyed by the project dir)', () => {
    const w = { file_path: join(proj(), '.claude', 'settings.json'), content: '{}' }
    expect(call('Write', w, true, proj())).toEqual(SUB_DENY)
    expect(call('Write', w, true, join(base, 'elsewhere'))).toEqual({ deny: false })
  })
})

describe('the hook end to end: the project dir comes from CLAUDE_PROJECT_DIR', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
  it('a caller outside the install may not write its own .claude/settings.json; another project\'s is free', () => {
    const proj = join(base, 'worker-project')
    const run = (projectDir: string) => spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(proj, '.claude', 'settings.json'), content: '{}' }, cwd: proj }),
      encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    })
    const own = run(proj)
    expect(JSON.parse(own.stdout).hookSpecificOutput.permissionDecisionReason).toContain('ENVRELAXGATE1104')
    const other = run(join(base, 'elsewhere'))
    expect(other.stdout).toBe('')
    expect(other.status).toBe(0)
  })
})

// Samu 67832: the user-level settings of a config dir. Every agent's agents/<name>/.claude-config/settings.json is on
// the COMMON list (pattern); the CALLER's own <CLAUDE_CONFIG_DIR>/settings.json is on the sub-agent list per call, so a
// worker (config dir ~/.marveen-worker{,-fast}/.claude-config) is covered as well. Claude Code's own /effort or /model
// write is not a tool call: this gate never sees it.
describe('the user-level settings of a CLAUDE_CONFIG_DIR', () => {
  const cfg = () => join(agent, '.claude-config')
  const workerCfg = () => join(base, 'home', '.marveen-worker', '.claude-config')
  beforeEach(() => {
    mkdirSync(cfg(), { recursive: true }); writeFileSync(join(cfg(), 'settings.json'), '{}')
    mkdirSync(join(other, '.claude-config'), { recursive: true }); writeFileSync(join(other, '.claude-config', 'settings.json'), '{}')
    mkdirSync(workerCfg(), { recursive: true }); writeFileSync(join(workerCfg(), 'settings.json'), '{}')
  })
  const call = (tool: string, input: Record<string, unknown>, o: { subAgent: boolean; configDir?: string | null; cwd?: string }) =>
    gateDecision(tool, input, { cwd: o.cwd ?? agent, root, subAgent: o.subAgent, configDir: o.configDir ?? null })

  for (const who of [{ label: 'a sub-agent', subAgent: true }, { label: 'the main agent', subAgent: false }]) {
    it(`${who.label}: an agent's agents/<name>/.claude-config/settings.json (its own, another's): Write, Edit, >, >|, >>`, () => {
      for (const target of [join(cfg(), 'settings.json'), join(other, '.claude-config', 'settings.json')]) {
        expect(call('Write', { file_path: target, content: '{"disableAllHooks": true}' }, who)).toEqual(DENY)
        expect(call('Edit', { file_path: target, old_string: '{}', new_string: '{"env":{}}' }, who)).toEqual(DENY)
        for (const op of ['>', '>|', '>>']) expect(call('Bash', { command: `echo x ${op} ${target}` }, who)).toEqual(DENY)
      }
      expect(call('Bash', { command: 'cp -r /tmp/evil/.claude-config .' }, who)).toEqual(DENY)
    })
  }
  it('a worker (its config dir outside the install): its own config settings.json is denied, per call', () => {
    const SUB = { deny: true, reason: 'subagent-file' }
    const w = { file_path: join(workerCfg(), 'settings.json'), content: '{"disableAllHooks": true}' }
    expect(call('Write', w, { subAgent: true, configDir: workerCfg(), cwd: join(base, 'home', '.marveen-worker') })).toEqual(SUB)
    for (const op of ['>', '>|', '>>']) {
      expect(call('Bash', { command: `echo x ${op} .claude-config/settings.json` }, { subAgent: true, configDir: workerCfg(), cwd: join(base, 'home', '.marveen-worker') })).toEqual(SUB)
    }
  })
  it('two callers in one process: each gets its OWN config entry (the target cache is keyed by the config dir)', () => {
    const SUB = { deny: true, reason: 'subagent-file' }
    const w = { file_path: join(workerCfg(), 'settings.json'), content: '{}' }
    expect(call('Write', w, { subAgent: true, configDir: workerCfg() })).toEqual(SUB)
    expect(call('Write', w, { subAgent: true, configDir: join(base, 'elsewhere') })).toEqual({ deny: false })
  })
  it('reads are free; another config dir than the caller\'s (outside the install) is not this rule\'s', () => {
    expect(call('Bash', { command: `cat ${join(cfg(), 'settings.json')}` }, { subAgent: true }).deny).toBe(false)
    expect(call('Write', { file_path: join(workerCfg(), 'settings.json'), content: '{}' }, { subAgent: true, configDir: join(base, 'elsewhere') })).toEqual({ deny: false })
  })
  it('control: the main agent\'s own config (~/.claude or <root>/.channels-config) is not touched by the sub-agent list', () => {
    const mainCfg = join(base, 'home', '.claude'); mkdirSync(mainCfg, { recursive: true })
    expect(call('Write', { file_path: join(mainCfg, 'settings.json'), content: '{}' }, { subAgent: false, configDir: mainCfg })).toEqual({ deny: false })
  })
  it('Dani 67822: a child session a sub-agent starts from the install root is still a sub-agent by its inherited config dir', () => {
    expect(isSubAgentCaller(root, root, join(root, 'agents', 'samu', '.claude-config'))).toBe(true)
    expect(isSubAgentCaller(root, root, null)).toBe(false)
    expect(isSubAgentCaller(root, root, join(base, 'home', '.claude'))).toBe(false)
    expect(isSubAgentCaller(root, root, join(root, '.channels-config'))).toBe(false)
  })
})

describe('the hook end to end: CLAUDE_CONFIG_DIR is read', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
  const run = (env: Record<string, string>, tool_input: Record<string, unknown>) => {
    const e = { ...process.env }
    delete e.CLAUDE_CONFIG_DIR; delete e.CLAUDE_PROJECT_DIR
    return spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input, cwd: INSTALL_ROOT }), encoding: 'utf-8', env: { ...e, ...env } })
  }
  it('a child session from the install root with a sub-agent\'s config dir may not write the .env (Dani 67822)', () => {
    const r = run({ CLAUDE_PROJECT_DIR: INSTALL_ROOT, CLAUDE_CONFIG_DIR: join(INSTALL_ROOT, 'agents', 'samu', '.claude-config') }, { command: 'echo SUDO_AGENTS=samu >> .env' })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('ENVRELAXGATE1104')
  })
  it('control: the main agent (install root, no isolated config) still passes', () => {
    const r = run({ CLAUDE_PROJECT_DIR: INSTALL_ROOT }, { command: 'echo X=1 >> .env' })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
  it('a worker may not write its own config settings.json', () => {
    const cfg = join(base, 'home', '.marveen-worker', '.claude-config')
    const r = run({ CLAUDE_PROJECT_DIR: join(base, 'home', '.marveen-worker'), CLAUDE_CONFIG_DIR: cfg }, { command: `echo '{"disableAllHooks": true}' > ${join(cfg, 'settings.json')}` })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('ENVRELAXGATE1104')
  })
})

// Dani 67840/67841: every agents/*/.claude-config/settings.local.json is a SYMLINK to ~/.claude/settings.local.json,
// a real file the main agent loads too. ~/.claude/settings.json and settings.local.json are on the SUB-AGENT list
// (home entries, real path compared, so the symlink route lands there); the main agent writes them legitimately.
// ~/.claude/projects (memory files) is not touched. The decision function only reads paths: nothing is written.
describe('the shared ~/.claude user settings, through a symlink and straight (sub-agent list)', () => {
  const homeLocal = () => join(homedir(), '.claude', 'settings.local.json')
  const homeSettings = () => join(homedir(), '.claude', 'settings.json')
  const SUB = { deny: true, reason: 'subagent-file' }
  const call = (tool: string, input: Record<string, unknown>, subAgent: boolean, configDir: string | null = null) =>
    gateDecision(tool, input, { cwd: agent, root, subAgent, configDir })
  let link: string
  beforeEach(() => {
    mkdirSync(join(agent, '.claude-config'), { recursive: true })
    link = join(agent, '.claude-config', 'settings.local.json')
    symlinkSync(homeLocal(), link)
  })
  it('a sub-agent: through its config dir\'s symlink, and straight at the target, is denied', () => {
    expect(call('Write', { file_path: link, content: '{"disableAllHooks": true}' }, true)).toEqual(SUB)
    expect(call('Edit', { file_path: homeLocal(), old_string: 'a', new_string: 'b' }, true)).toEqual(SUB)
    expect(call('Write', { file_path: homeSettings(), content: '{}' }, true)).toEqual(SUB)
    for (const op of ['>', '>|', '>>']) {
      expect(call('Bash', { command: `echo x ${op} .claude-config/settings.local.json` }, true)).toEqual(SUB)
      expect(call('Bash', { command: `echo x ${op} ~/.claude/settings.json` }, true)).toEqual(SUB)
    }
  })
  it('the caller\'s own config settings.local.json (a real file, e.g. a worker\'s) is denied per call', () => {
    const cfg = join(base, 'home', '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true }); writeFileSync(join(cfg, 'settings.local.json'), '{}')
    expect(call('Write', { file_path: join(cfg, 'settings.local.json'), content: '{}' }, true, cfg)).toEqual(SUB)
  })
  it('reads are free, and ~/.claude/projects (memory files) is not this rule\'s', () => {
    expect(call('Bash', { command: 'cat ~/.claude/settings.local.json' }, true).deny).toBe(false)
    expect(call('Bash', { command: 'jq . .claude-config/settings.local.json' }, true).deny).toBe(false)
    expect(call('Write', { file_path: join(homedir(), '.claude', 'projects', 'x', 'memory', 'note.md'), content: 'x' }, true)).toEqual({ deny: false })
    expect(call('Write', { file_path: join(agent, '.claude-config', 'projects', 'x', 'memory', 'note.md'), content: 'x' }, true)).toEqual({ deny: false })
  })
  it('control: the main agent writes them (straight and through the symlink)', () => {
    expect(call('Write', { file_path: homeLocal(), content: '{}' }, false)).toEqual({ deny: false })
    expect(call('Write', { file_path: homeSettings(), content: '{}' }, false)).toEqual({ deny: false })
    expect(call('Write', { file_path: link, content: '{}' }, false)).toEqual({ deny: false })
  })
})
