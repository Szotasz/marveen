// MAINEXTRAHOOKS1123 (owner decision 2026-11-23): the MAIN agent installs an install-local extra hook on the owners'
// request -- it writes store/extra-hooks.json and drops a script into <root>/local-hooks/ -- with no owner keystroke
// and no dashboard click. Every SUB-AGENT stays denied, by both gates:
//   - scripts/hooks/db-write-gate.mjs (every agent): the pair moved from the common list to the sub-agent list, so the
//     main agent (CLAUDE_PROJECT_DIR = the install root, no CLAUDE_CONFIG_DIR under agents/) passes and a sub-agent is
//     denied by the real-path engine;
//   - scripts/self-pace-gate.mjs (wired into the sub-agents only): its EXTRAHOOKSGATE1020 rule is unchanged.
// Every other protected install path stays denied for the main agent too. A text brake, not an OS boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isSubAgentCaller, PROTECTED_INSTALL_PATHS, SUBAGENT_PROTECTED_INSTALL_PATHS, INSTALL_ROOT } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

let base: string
let root: string // the "install"
let wt: string // a worktree of it
let agentDir: string // a sub-agent's project dir
let agentCfg: string // its isolated CLAUDE_CONFIG_DIR
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'main-extra-hooks-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  for (const d of [root, wt]) {
    for (const sub of ['.claude', join('scripts', 'hooks'), 'store', 'local-hooks']) mkdirSync(join(d, sub), { recursive: true })
    writeFileSync(join(d, '.claude', 'settings.json'), '{}')
    writeFileSync(join(d, 'scripts', 'hooks', 'gate.py'), '')
    writeFileSync(join(d, 'scripts', 'self-pace-gate.mjs'), '')
    writeFileSync(join(d, 'store', 'extra-hooks.json'), '{"entries":[]}')
    writeFileSync(join(d, 'store', 'autonomy-config.json'), '{}')
    writeFileSync(join(d, 'store', 'egress-allowlist.json'), '{"domains":[]}')
    writeFileSync(join(d, 'local-hooks', 'old.py'), '')
  }
  agentDir = join(root, 'agents', 'samu')
  agentCfg = join(agentDir, '.claude-config')
  mkdirSync(agentCfg, { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const fill = (s: string) => s.replaceAll('@ROOT@', root).replaceAll('@WT@', wt)
// The main agent: its project dir is the install root, its config dir ~/.claude (as the live hook computes it).
const MAIN = () => ({ root, subAgent: false, projectDir: root, configDir: join(homedir(), '.claude') })
const SUBA = () => ({ root, subAgent: true, projectDir: agentDir, configDir: agentCfg })
const mainBash = (command: string, cwd = root) => gateDecision('Bash', { command: fill(command) }, { ...MAIN(), cwd })
const subBash = (command: string, cwd = agentDir) => gateDecision('Bash', { command: fill(command) }, { ...SUBA(), cwd })
const mainFile = (tool: string, p: string, cwd = root) => gateDecision(tool, { file_path: p, content: 'x', old_string: 'a', new_string: 'b', edits: [] }, { ...MAIN(), cwd })
const subFile = (tool: string, p: string, cwd = agentDir) => gateDecision(tool, { file_path: p, content: 'x', old_string: 'a', new_string: 'b', edits: [] }, { ...SUBA(), cwd })
const ALLOW = { deny: false }
const SUB_DENY = { deny: true, reason: 'subagent-file' }
const MAIN_DENY = { deny: true, reason: 'install-file' }

const extras = () => join(root, 'store', 'extra-hooks.json')
const script = () => join(root, 'local-hooks', 'x.py')

describe('the lists: the pair left the common list and is on the sub-agent list', () => {
  const rels = (l: Array<{ rel?: string }>) => l.map((t) => t.rel)
  it('store/extra-hooks.json is not on the every-agent list any more', () => {
    expect(rels(PROTECTED_INSTALL_PATHS)).not.toContain('store/extra-hooks.json')
    expect(rels(PROTECTED_INSTALL_PATHS)).not.toContain('local-hooks')
  })
  it('both are on the sub-agent list, local-hooks as a directory', () => {
    expect(SUBAGENT_PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'store/extra-hooks.json' })
    expect(SUBAGENT_PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'local-hooks', dir: true })
  })
})

describe('the main agent: writing the extras file and a local-hooks script is ALLOWED', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s of store/extra-hooks.json', (tool) => {
    expect(mainFile(tool, extras())).toEqual(ALLOW)
  })
  it.each(['Write', 'Edit', 'MultiEdit'])('%s of local-hooks/x.py (a new script) and of an existing one', (tool) => {
    expect(mainFile(tool, script())).toEqual(ALLOW)
    expect(mainFile(tool, join(root, 'local-hooks', 'old.py'))).toEqual(ALLOW)
  })
  it('a relative path from the root', () => {
    expect(mainFile('Write', 'store/extra-hooks.json')).toEqual(ALLOW)
    expect(mainFile('Write', 'local-hooks/x.py')).toEqual(ALLOW)
  })
  it.each([
    `echo '{"entries":[]}' > store/extra-hooks.json`,
    `echo '{"entries":[]}' > @ROOT@/store/extra-hooks.json`,
    `cp /tmp/e.json store/extra-hooks.json`,
    `printf '{}' | tee store/extra-hooks.json`,
    `echo '{}' > /tmp/e.json && mv /tmp/e.json @ROOT@/store/extra-hooks.json`,
    `python3 -c "open('store/extra-hooks.json','w').write('{}')"`,
    `jq '.entries += [{"event":"PreToolUse","script":"x.py"}]' store/extra-hooks.json > /tmp/e.json && mv /tmp/e.json store/extra-hooks.json`,
    `mkdir -p local-hooks && cp /tmp/x.py local-hooks/x.py`,
    `cat > @ROOT@/local-hooks/x.py <<'EOF'\nimport sys\nsys.exit(0)\nEOF`,
    `chmod 755 local-hooks/x.py`,
    `cp /tmp/x.py local-hooks/`,
    `install -m 755 /tmp/x.py @ROOT@/local-hooks/x.py`,
  ])('Bash: %s', (command) => {
    expect(mainBash(command)).toEqual(ALLOW)
  })
  it('an MCP file tool writing either', () => {
    expect(gateDecision('mcp__filesystem__write_file', { path: extras(), content: '{}' }, { ...MAIN(), cwd: root })).toEqual(ALLOW)
    expect(gateDecision('mcp__filesystem__write_file', { path: script(), content: '' }, { ...MAIN(), cwd: root })).toEqual(ALLOW)
  })
})

// The sub-agent was denied store/extra-hooks.json before this change too (then by the every-agent list): these
// assertions are reason-agnostic on purpose, so they hold on the old code and on the new one.
describe('NEGATIVE CONTROL: a sub-agent (agents/<name>) is DENIED store/extra-hooks.json, as before', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s', (tool) => {
    expect(subFile(tool, extras()).deny).toBe(true)
  })
  it('a relative path from its own directory, a symlink under another name, upper case', () => {
    expect(subFile('Write', '../../store/extra-hooks.json').deny).toBe(true)
    symlinkSync(extras(), join(agentDir, 'innocent.json'))
    expect(subFile('Write', join(agentDir, 'innocent.json')).deny).toBe(true)
    expect(subFile('Write', join(root, 'STORE', 'Extra-Hooks.json')).deny).toBe(true)
  })
  it.each([
    `echo '{"entries":[]}' > @ROOT@/store/extra-hooks.json`,
    `echo '{"entries":[]}' > ../../store/extra-hooks.json`,
    `cp /tmp/e.json @ROOT@/store/extra-hooks.json`,
    `printf '{}' | tee @ROOT@/store/extra-hooks.json`,
    `echo '{}' > /tmp/e.json && mv /tmp/e.json @ROOT@/store/extra-hooks.json`,
    `rm -f @ROOT@/store/extra-hooks.json`,
    `cd @ROOT@ && echo '{}' > store/extra-hooks.json`,
  ])('Bash: %s', (command) => {
    expect(subBash(command).deny).toBe(true)
  })
  it('an MCP file tool writing it', () => {
    expect(gateDecision('mcp__filesystem__write_file', { path: extras(), content: '{}' }, { ...SUBA(), cwd: agentDir }).deny).toBe(true)
  })
  it('the deny now comes from the sub-agent list (its own reason and message)', () => {
    expect(subFile('Write', extras())).toEqual(SUB_DENY)
    expect(subBash(`cp /tmp/e.json @ROOT@/store/extra-hooks.json`)).toEqual(SUB_DENY)
  })
})

// NEW (MAINEXTRAHOOKS1123): local-hooks/ was guarded for a sub-agent by the self-pace gate alone (below); the
// db-write-gate now reads it as well, by real path. These fail on the old code by design.
describe('NEGATIVE CONTROL: a sub-agent is DENIED local-hooks/ by the db-write-gate too', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s of local-hooks/x.py', (tool) => {
    expect(subFile(tool, script())).toEqual(SUB_DENY)
  })
  it('a relative path from its own directory, a symlink under another name, upper case', () => {
    expect(subFile('Write', '../../local-hooks/x.py')).toEqual(SUB_DENY)
    symlinkSync(join(root, 'local-hooks'), join(agentDir, 'innocent'))
    expect(subFile('Write', join(agentDir, 'innocent', 'x.py'))).toEqual(SUB_DENY)
    expect(subFile('Write', join(root, 'Local-Hooks', 'x.py'))).toEqual(SUB_DENY)
  })
  it.each([
    `cp /tmp/x.py @ROOT@/local-hooks/x.py`,
    `cp /tmp/x.py @ROOT@/local-hooks/`,
    `cat > @ROOT@/local-hooks/x.py <<'EOF'\nimport sys\nEOF`,
    `rm -rf @ROOT@/local-hooks`,
    `cd @ROOT@ && rm -rf local-hooks`,
    `cd @ROOT@ && echo x > local-hooks/x.py`,
    `mv /tmp/x.py ../../local-hooks/old.py`,
  ])('Bash: %s', (command) => {
    expect(subBash(command)).toEqual(SUB_DENY)
  })
  it('an MCP file tool writing a script', () => {
    expect(gateDecision('mcp__filesystem__write_file', { path: script(), content: '' }, { ...SUBA(), cwd: agentDir }).deny).toBe(true)
  })
  it('POSITIVE CONTROL: a sub-agent reads both, and writes its worktree\'s own copy', () => {
    expect(subBash('cat @ROOT@/store/extra-hooks.json')).toEqual(ALLOW)
    expect(subBash('ls @ROOT@/local-hooks')).toEqual(ALLOW)
    expect(subBash(`echo '{}' > @WT@/store/extra-hooks.json`)).toEqual(ALLOW)
    expect(subFile('Write', join(wt, 'local-hooks', 'x.py'))).toEqual(ALLOW)
  })
  it('the sub-agent message names the pair and sends the agent to the main agent', () => {
    const hook = join(INSTALL_ROOT, 'scripts', 'hooks', 'db-write-gate.mjs')
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: join(INSTALL_ROOT, 'agents', 'samu') }
    delete env.CLAUDE_CONFIG_DIR
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(INSTALL_ROOT, 'store', 'extra-hooks.json'), content: '{}' }, cwd: INSTALL_ROOT }), encoding: 'utf-8', env })
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason
    // the short deny text (#3112): the rule, then what was caught, then the way through the main agent
    expect(reason).toContain(`Elkapva: ${join(INSTALL_ROOT, 'store', 'extra-hooks.json')}.`)
    expect(reason).toContain('kerd a fo agenst')
  })
})

describe('NEGATIVE CONTROL: the self-pace gate (sub-agents only) still denies the pair, unchanged', () => {
  const pace = (tool: string, input: Record<string, unknown>) => selfPaceDecision(tool, input, { allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd: agentDir })
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s', (tool) => {
    expect(pace(tool, { file_path: extras(), content: '{}' }).deny).toBe(true)
    expect(pace(tool, { file_path: script(), content: '' }).deny).toBe(true)
  })
  it.each([
    `echo '{}' > @ROOT@/store/extra-hooks.json`,
    `cp /tmp/x.py @ROOT@/local-hooks/x.py`,
    `python3 -c "open('@ROOT@/store/extra-hooks.json','w').write('{}')"`,
  ])('Bash: %s', (command) => {
    expect(pace('Bash', { command: fill(command) }).deny).toBe(true)
  })
})

describe('NEGATIVE CONTROL: every other protected install path stays denied for the main agent', () => {
  it.each(['.claude/settings.json', 'scripts/hooks/gate.py', 'scripts/hooks/new.py', 'scripts/self-pace-gate.mjs',
    'store/autonomy-config.json', 'store/agent-sender-role-gates.json', 'store/config-overrides.json', 'store/custom-providers.json',
    'store/context-guard.json', 'store/.dashboard-totp.json', 'agents/samu/.claude/settings.json'])('Write of %s', (rel) => {
    expect(mainFile('Write', join(root, rel))).toEqual(MAIN_DENY)
  })
  it.each([
    `echo '{}' > store/autonomy-config.json`,
    `cp /tmp/x scripts/hooks/gate.py`,
    `echo x >> scripts/self-pace-gate.mjs`,
    `rm -rf scripts/hooks`,
  ])('Bash: %s', (command) => {
    expect(mainBash(command)).toEqual(MAIN_DENY)
  })
  it('a command that writes an allowed extra AND a protected file is denied on the protected one', () => {
    expect(mainBash(`echo '{}' > store/extra-hooks.json; echo '{}' > store/autonomy-config.json`)).toEqual(MAIN_DENY)
  })
})

describe('who is the main agent: isSubAgentCaller (CLAUDE_PROJECT_DIR + CLAUDE_CONFIG_DIR, the existing ENVRELAXGATE1104 signal)', () => {
  it('the install root with a config dir outside agents/ is the main agent', () => {
    expect(isSubAgentCaller(root, root, join(homedir(), '.claude'))).toBe(false)
    expect(isSubAgentCaller(root, root, join(root, '.channels-config'))).toBe(false)
  })
  it('agents/<name>, an unset project dir, or a config dir under agents/ (a child claude started from the root) is a sub-agent', () => {
    expect(isSubAgentCaller(agentDir, root, agentCfg)).toBe(true)
    expect(isSubAgentCaller(undefined, root)).toBe(true)
    expect(isSubAgentCaller(root, root, agentCfg)).toBe(true)
  })
})

describe('the hook end to end (the caller read from the environment, as Claude Code sets it)', () => {
  const hook = join(INSTALL_ROOT, 'scripts', 'hooks', 'db-write-gate.mjs')
  const run = (projectDir: string | undefined, configDir: string | undefined, payload: unknown) => {
    const env = { ...process.env }
    delete env.CLAUDE_PROJECT_DIR
    delete env.CLAUDE_CONFIG_DIR
    if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir
    if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir
    return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  }
  const writeExtras = { tool_name: 'Write', tool_input: { file_path: join(INSTALL_ROOT, 'store', 'extra-hooks.json'), content: '{"entries":[]}' }, cwd: INSTALL_ROOT }
  const writeScript = { tool_name: 'Bash', tool_input: { command: 'cp /tmp/x.py local-hooks/x.py' }, cwd: INSTALL_ROOT }
  const denied = (r: ReturnType<typeof spawnSync>) => String(r.stdout).includes('"permissionDecision":"deny"')

  it('the main agent (project dir = the install root) passes for both', () => {
    for (const p of [writeExtras, writeScript]) {
      const r = run(INSTALL_ROOT, undefined, p)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
  it('a sub-agent (project dir agents/<name>) is denied the extras file (as before)', () => {
    expect(denied(run(join(INSTALL_ROOT, 'agents', 'samu'), undefined, writeExtras))).toBe(true)
  })
  it('a sub-agent is denied a local-hooks script by this gate too (new)', () => {
    expect(denied(run(join(INSTALL_ROOT, 'agents', 'samu'), undefined, writeScript))).toBe(true)
  })
  it('the install root with a sub-agent\'s config dir (a child claude a sub-agent started there) is denied', () => {
    expect(denied(run(INSTALL_ROOT, join(INSTALL_ROOT, 'agents', 'samu', '.claude-config'), writeExtras))).toBe(true)
  })
  it('an unset project dir is a sub-agent (fail-closed)', () => {
    expect(denied(run(undefined, undefined, writeExtras))).toBe(true)
  })
  it('NEGATIVE CONTROL: the main agent is still denied the autonomy levels', () => {
    const r = run(INSTALL_ROOT, undefined, { tool_name: 'Write', tool_input: { file_path: join(INSTALL_ROOT, 'store', 'autonomy-config.json'), content: '{}' }, cwd: INSTALL_ROOT })
    expect(denied(r)).toBe(true)
  })
})
