// MAINEXTRAHOOKS1123: the MAIN agent installs an install-local extra hook on the owners' request -- it writes
// store/extra-hooks.json and drops a script into <root>/local-hooks/ -- but only on the owner's opt-in per install
// (fleet review of #3064, condition (a)): the overrides-only EXTRA_HOOKS_MAIN_AGENT_WRITE in store/config-overrides.json,
// default off. Off, the main agent is denied the pair as before (the operator writes it by hand). Every SUB-AGENT stays
// denied in both states, by both gates:
//   - scripts/hooks/db-write-gate.mjs (every agent): the pair (EXTRA_HOOKS_PAIR) is on the sub-agent list always and on
//     the main agent's list while the switch is off; the switch file and the announced-digest record are on the common
//     list, so no agent flips the switch or hides a change;
//   - scripts/self-pace-gate.mjs (wired into the sub-agents only): its EXTRAHOOKSGATE1020 rule is unchanged.
// Every other protected install path stays denied for the main agent too. A text brake, not an OS boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isSubAgentCaller, mainExtraHooksWriteOn, EXTRA_HOOKS_PAIR, EXTRA_HOOKS_SWITCH, PROTECTED_INSTALL_PATHS, SUBAGENT_PROTECTED_INSTALL_PATHS, INSTALL_ROOT, INSTALL_FILE_GATE_MSG } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision } from '../../scripts/self-pace-gate.mjs'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
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
const overrides = () => join(root, 'store', 'config-overrides.json')
// The owner's switch, as the Settings route stores it (a string), or any raw JSON text for the fail-closed cases.
const setSwitch = (value: unknown) => writeFileSync(overrides(), JSON.stringify({ OTHER_KEY: '1', [EXTRA_HOOKS_SWITCH]: value }))
const switchOn = () => setSwitch('on')

describe('the lists: the pair left the common list and is on the sub-agent list', () => {
  const rels = (l: Array<{ rel?: string }>) => l.map((t) => t.rel)
  it('store/extra-hooks.json is not on the every-agent list any more', () => {
    expect(rels(PROTECTED_INSTALL_PATHS)).not.toContain('store/extra-hooks.json')
    expect(rels(PROTECTED_INSTALL_PATHS)).not.toContain('local-hooks')
  })
  it('both are on the sub-agent list, local-hooks as a directory', () => {
    expect(SUBAGENT_PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'store/extra-hooks.json' })
    expect(SUBAGENT_PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'local-hooks', dir: true })
    expect(EXTRA_HOOKS_PAIR).toEqual([{ rel: 'store/extra-hooks.json' }, { rel: 'local-hooks', dir: true }])
    expect(EXTRA_HOOKS_SWITCH).toBe('EXTRA_HOOKS_MAIN_AGENT_WRITE')
  })
  // Review condition (a): the switch file itself must be out of every agent's reach, or the main agent flips its own
  // switch. It was on the common list before this PR (APPROVALSLACK1030), and stays there.
  it('the switch file and the announced-digest record are on the EVERY-agent list', () => {
    expect(PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'store/config-overrides.json' })
    expect(PROTECTED_INSTALL_PATHS).toContainEqual({ rel: 'store/.extra-hooks-digest.json' })
  })
})

// Review condition (a): an opt-in per install, default OFF, fail-closed.
describe('(a) the owner\'s switch: only the string "on" in store/config-overrides.json opens the pair', () => {
  it('no file, an unparsable file, an array, a missing key: OFF', () => {
    expect(mainExtraHooksWriteOn(root)).toBe(false)
    writeFileSync(overrides(), '{ not json')
    expect(mainExtraHooksWriteOn(root)).toBe(false)
    writeFileSync(overrides(), '["on"]')
    expect(mainExtraHooksWriteOn(root)).toBe(false)
    writeFileSync(overrides(), JSON.stringify({ OTHER_KEY: 'on' }))
    expect(mainExtraHooksWriteOn(root)).toBe(false)
  })
  it.each([['off'], [''], ['1'], ['yes'], ['true'], ['onn'], [true], [1], [null], [['on']], [{ on: true }]])('%j: OFF', (v) => {
    setSwitch(v)
    expect(mainExtraHooksWriteOn(root)).toBe(false)
  })
  it.each([['on'], [' ON '], ['On']])('%j: ON (trimmed, any case, as the registry validates it)', (v) => {
    setSwitch(v)
    expect(mainExtraHooksWriteOn(root)).toBe(true)
  })
  it('the switch is read again after the file changes (on -> off -> on)', () => {
    switchOn()
    expect(mainExtraHooksWriteOn(root)).toBe(true)
    setSwitch('off')
    expect(mainExtraHooksWriteOn(root)).toBe(false)
    switchOn()
    expect(mainExtraHooksWriteOn(root)).toBe(true)
  })
  it('a .env line does not count (overrides-only: a .env value may only tighten)', () => {
    writeFileSync(join(root, '.env'), `${EXTRA_HOOKS_SWITCH}=on\n`)
    expect(mainExtraHooksWriteOn(root)).toBe(false)
  })
})

describe('(a) switch OFF (the default): the main agent is DENIED the pair, as before this PR', () => {
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s of store/extra-hooks.json and of local-hooks/x.py', (tool) => {
    expect(mainFile(tool, extras())).toEqual(MAIN_DENY)
    expect(mainFile(tool, script())).toEqual(MAIN_DENY)
    expect(mainFile(tool, join(root, 'local-hooks', 'old.py'))).toEqual(MAIN_DENY)
  })
  it.each([
    `echo '{"entries":[]}' > store/extra-hooks.json`,
    `cp /tmp/e.json @ROOT@/store/extra-hooks.json`,
    `python3 -c "open('store/extra-hooks.json','w').write('{}')"`,
    `cp /tmp/x.py local-hooks/x.py`,
    `cat > @ROOT@/local-hooks/x.py <<'EOF'\nimport sys\nEOF`,
    `rm -rf local-hooks`,
  ])('Bash: %s', (command) => {
    expect(mainBash(command)).toEqual(MAIN_DENY)
  })
  it('an MCP file tool writing either', () => {
    expect(gateDecision('mcp__filesystem__write_file', { path: extras(), content: '{}' }, { ...MAIN(), cwd: root }).deny).toBe(true)
    expect(gateDecision('mcp__filesystem__write_file', { path: script(), content: '' }, { ...MAIN(), cwd: root }).deny).toBe(true)
  })
  it.each([['off'], ['yes'], [true]])('the same with the switch set to %j', (v) => {
    setSwitch(v)
    expect(mainFile('Write', extras())).toEqual(MAIN_DENY)
    expect(mainBash('cp /tmp/x.py local-hooks/x.py')).toEqual(MAIN_DENY)
  })
  // local-hooks/ is the first main-agent entry a bare `*` reaches from the install root: a QUOTED one is the literal
  // name (the shell never expands it), an unquoted one expands onto the directory
  it('a quoted `*` at the root is the literal name and passes; an unquoted one reaches local-hooks/ and is denied', () => {
    expect(mainBash(`sqlite3 -readonly store/x.db "SELECT count(*) FROM t"`)).toEqual(ALLOW)
    expect(mainBash(`grep -c '*' store/extra-hooks.json`)).toEqual(ALLOW)
    expect(mainBash(`cp /tmp/x.py *`)).toEqual(MAIN_DENY)
    expect(mainBash(`bash -c "cp /tmp/x.py *"`)).toEqual(MAIN_DENY)
  })
  it('reading both stays free, and so does the worktree\'s own copy', () => {
    expect(mainBash('cat store/extra-hooks.json')).toEqual(ALLOW)
    expect(mainBash('ls local-hooks')).toEqual(ALLOW)
    expect(mainFile('Write', join(wt, 'store', 'extra-hooks.json'), wt)).toEqual(ALLOW)
    expect(mainFile('Write', join(wt, 'local-hooks', 'x.py'), wt)).toEqual(ALLOW)
  })
  // The deny message is short since #3112 (the rule, what was caught, the way, a pointer to the docs); the full list
  // lives in docs/db-write-gate.md, "Full deny texts", and names the pair, the switch and the digest record there.
  it('the full deny text in the docs names the pair and the switch; the short message points there', () => {
    const docs = readFileSync(join(INSTALL_ROOT, 'docs', 'db-write-gate.md'), 'utf-8')
    const full = docs.split('### Telepitesi kapu-fajlok')[1].split('\n### ')[0]
    expect(full).toContain('store/extra-hooks.json')
    expect(full).toContain('local-hooks/')
    expect(full).toContain('EXTRA_HOOKS_MAIN_AGENT_WRITE')
    expect(full).toContain('store/.extra-hooks-digest.json')
    expect(INSTALL_FILE_GATE_MSG).toContain('docs/db-write-gate.md ("Telepitesi kapu-fajlok"')
  })
})

describe('(a) switch ON: the main agent may still not flip its own switch or reset the announced digest', () => {
  beforeEach(switchOn)
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s of store/config-overrides.json and store/.extra-hooks-digest.json', (tool) => {
    expect(mainFile(tool, overrides())).toEqual(MAIN_DENY)
    expect(mainFile(tool, join(root, 'store', '.extra-hooks-digest.json'))).toEqual(MAIN_DENY)
  })
  it.each([
    `echo '{"EXTRA_HOOKS_MAIN_AGENT_WRITE":"off"}' > store/config-overrides.json`,
    `jq '.EXTRA_HOOKS_MAIN_AGENT_WRITE="on"' store/config-overrides.json > /tmp/o && mv /tmp/o store/config-overrides.json`,
    `rm -f store/.extra-hooks-digest.json`,
    `echo '{}' > @ROOT@/store/.extra-hooks-digest.json`,
    `cd store && echo '{}' > .extra-hooks-digest.json`,
  ])('Bash: %s', (command) => {
    expect(mainBash(command)).toEqual(MAIN_DENY)
  })
  it('a sub-agent is denied both as well', () => {
    expect(subFile('Write', overrides()).deny).toBe(true)
    expect(subFile('Write', join(root, 'store', '.extra-hooks-digest.json')).deny).toBe(true)
  })
})

describe('(a) switch ON: the main agent writing the extras file and a local-hooks script is ALLOWED', () => {
  beforeEach(switchOn)
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
// assertions are reason-agnostic on purpose, so they hold on the old code and on the new one. They run with the
// owner's switch ON, the state in which the main agent passes: the switch never opens the pair to a sub-agent.
describe('NEGATIVE CONTROL: a sub-agent (agents/<name>) is DENIED store/extra-hooks.json, as before', () => {
  beforeEach(switchOn)
  it('with the switch off too (then the main agent\'s own list denies it first)', () => {
    setSwitch('off')
    expect(subFile('Write', extras())).toEqual(MAIN_DENY)
    expect(subBash(`cp /tmp/e.json @ROOT@/store/extra-hooks.json`).deny).toBe(true)
  })
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
  beforeEach(switchOn)
  it('with the switch off too', () => {
    setSwitch('off')
    expect(subFile('Write', script()).deny).toBe(true)
    expect(subBash(`cp /tmp/x.py @ROOT@/local-hooks/x.py`).deny).toBe(true)
  })
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

describe('NEGATIVE CONTROL: every other protected install path stays denied for the main agent (switch ON)', () => {
  beforeEach(switchOn)
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

// End to end: the hook JSON piped into the gate process, the caller read from the environment as Claude Code sets it.
// The gate guards the install it sits in (INSTALL_ROOT from its own path) and reads the switch there, so it runs from
// a COPY in a throwaway install: flipping the switch in the checkout running the tests (a live install, perhaps) is
// not something a test may do. Copied: the gate and the modules it imports.
describe('the hook end to end, on a copied gate in a throwaway install', () => {
  let inst: string
  beforeEach(() => {
    inst = join(base, 'Copied')
    mkdirSync(join(inst, 'scripts', 'hooks'), { recursive: true })
    mkdirSync(join(inst, 'store'), { recursive: true })
    mkdirSync(join(inst, 'local-hooks'), { recursive: true })
    for (const f of ['hooks/db-write-gate.mjs', 'hooks/child-claude-channel-guard.mjs', 'hooks/mcp-file-targets.mjs', 'self-pace-gate.mjs']) {
      copyFileSync(join(INSTALL_ROOT, 'scripts', f), join(inst, 'scripts', f))
    }
    writeFileSync(join(inst, 'store', 'extra-hooks.json'), '{"entries":[]}')
  })
  const run = (projectDir: string | undefined, configDir: string | undefined, payload: unknown) => {
    const env = { ...process.env }
    delete env.CLAUDE_PROJECT_DIR
    delete env.CLAUDE_CONFIG_DIR
    if (projectDir !== undefined) env.CLAUDE_PROJECT_DIR = projectDir
    if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir
    return spawnSync(process.execPath, [join(inst, 'scripts', 'hooks', 'db-write-gate.mjs')], { input: JSON.stringify(payload), encoding: 'utf-8', env })
  }
  const writeExtras = () => ({ tool_name: 'Write', tool_input: { file_path: join(inst, 'store', 'extra-hooks.json'), content: '{"entries":[]}' }, cwd: inst })
  const writeScript = () => ({ tool_name: 'Bash', tool_input: { command: 'cp /tmp/x.py local-hooks/x.py' }, cwd: inst })
  const writeFile = (rel: string) => ({ tool_name: 'Write', tool_input: { file_path: join(inst, rel), content: '{}' }, cwd: inst })
  const reasonOf = (r: ReturnType<typeof spawnSync>): string | null =>
    String(r.stdout) === '' ? null : JSON.parse(String(r.stdout)).hookSpecificOutput.permissionDecisionReason
  const denied = (r: ReturnType<typeof spawnSync>) => String(r.stdout).includes('"permissionDecision":"deny"')
  const flip = (v: unknown) => writeFileSync(join(inst, 'store', 'config-overrides.json'), JSON.stringify({ [EXTRA_HOOKS_SWITCH]: v }))

  it('switch absent (the default): the main agent is denied both, the message names what was caught', () => {
    for (const [p, caught] of [[writeExtras(), join(inst, 'store', 'extra-hooks.json')], [writeScript(), 'local-hooks/x.py']] as const) {
      const r = run(inst, undefined, p)
      expect(r.status).toBe(0)
      expect(denied(r)).toBe(true)
      expect(reasonOf(r)).toContain(`Elkapva: ${caught}`)
      expect(reasonOf(r)).toContain('APPROVALDBGATE1030')
    }
  })
  it.each([['off'], ['yes'], [true]])('switch %j: the main agent is denied both', (v) => {
    flip(v)
    for (const p of [writeExtras(), writeScript()]) expect(denied(run(inst, undefined, p))).toBe(true)
  })
  it('an unparsable overrides file: denied (fail-closed)', () => {
    writeFileSync(join(inst, 'store', 'config-overrides.json'), '{"EXTRA_HOOKS_MAIN_AGENT_WRITE": "on"')
    for (const p of [writeExtras(), writeScript()]) expect(denied(run(inst, undefined, p))).toBe(true)
  })
  it('switch "on": the main agent (project dir = the install root) passes for both', () => {
    flip('on')
    for (const p of [writeExtras(), writeScript()]) {
      const r = run(inst, undefined, p)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
  it('switch "on": the main agent is still denied the switch file and the announced-digest record', () => {
    flip('on')
    expect(denied(run(inst, undefined, writeFile('store/config-overrides.json')))).toBe(true)
    expect(denied(run(inst, undefined, writeFile('store/.extra-hooks-digest.json')))).toBe(true)
    expect(denied(run(inst, undefined, { tool_name: 'Bash', tool_input: { command: `echo '{}' > store/config-overrides.json` }, cwd: inst }))).toBe(true)
  })
  it('switch "on": a sub-agent (project dir agents/<name>) is denied both, told to ask the main agent', () => {
    flip('on')
    for (const p of [writeExtras(), writeScript()]) {
      const r = run(join(inst, 'agents', 'samu'), undefined, p)
      expect(denied(r)).toBe(true)
      expect(reasonOf(r)).toContain('ENVRELAXGATE1104')
      expect(reasonOf(r)).toContain('kerd a fo agenst')
    }
  })
  it('switch "on": the install root with a sub-agent\'s config dir (a child claude a sub-agent started there) is denied', () => {
    flip('on')
    expect(denied(run(inst, join(inst, 'agents', 'samu', '.claude-config'), writeExtras()))).toBe(true)
  })
  it('switch "on": an unset project dir is a sub-agent (fail-closed)', () => {
    flip('on')
    expect(denied(run(undefined, undefined, writeExtras()))).toBe(true)
  })
  it('NEGATIVE CONTROL: with the switch on, the main agent is still denied the autonomy levels', () => {
    flip('on')
    expect(denied(run(inst, undefined, writeFile('store/autonomy-config.json')))).toBe(true)
  })
})
