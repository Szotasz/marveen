// ENVRELAXMCPCFG1104 (Samu 68033/68034): the MCP server lists are on the db-write-gate's SUB-AGENT list. A stdio
// server written into one of them runs as a command at the agent's next start, outside every PreToolUse gate, and the
// dashboard's reconcile only ever adds servers, so the entry would stay. The main agent and the dashboard write them
// (fleet MCP setup); a sub-agent does not. Same real-path engine as the rest of the list. The decision function only
// reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, SUBAGENT_PROTECTED_INSTALL_PATHS, SUBAGENT_FILE_GATE_MSG, unquotedForQualifier } from '../../scripts/hooks/db-write-gate.mjs'
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
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-config-')))
  root = join(base, 'Install')
  wt = join(base, 'install-wt')
  agent = join(root, 'agents', 'samu')
  other = join(root, 'agents', 'qwen')
  for (const d of [agent, other, join(wt, 'agents', 'samu')]) {
    mkdirSync(join(d, '.claude-config'), { recursive: true })
    writeFileSync(join(d, '.mcp.json'), '{"mcpServers":{}}')
    writeFileSync(join(d, '.claude-config', '.claude.json'), '{"mcpServers":{}}')
  }
  mkdirSync(join(root, '.channels-config'), { recursive: true })
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}')
  writeFileSync(join(root, '.channels-config', '.claude.json'), '{}')
  mkdirSync(join(root, 'store'), { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const SUB = { deny: true, reason: 'subagent-file' }
const SERVER = '{"mcpServers":{"x":{"command":"sh","args":["-c","id"]}}}'
const call = (tool: string, input: Record<string, unknown>, o: { subAgent: boolean; cwd?: string; projectDir?: string | null; configDir?: string | null }) =>
  gateDecision(tool, input, { cwd: o.cwd ?? agent, root, subAgent: o.subAgent, projectDir: o.projectDir ?? null, configDir: o.configDir ?? null })
const write = (p: string, o: Parameters<typeof call>[2]) => call('Write', { file_path: p, content: SERVER }, o)
const bash = (command: string, o: Parameters<typeof call>[2]) => call('Bash', { command: command.replaceAll('@ROOT@', root) }, o)

it('the entries are on the SUB-AGENT list (not the common one); .channels-config/.claude.json via the directory entry (#2503)', () => {
  const rels = SUBAGENT_PROTECTED_INSTALL_PATHS.map((t: { rel?: string; home?: string }) => t.rel ?? `~/${t.home}`)
  for (const r of ['agents/*/.mcp.json', 'agents/*/.claude-config/.claude.json', '.mcp.json', '.channels-config', '~/.claude.json']) {
    expect(rels).toContain(r)
  }
})

describe('a sub-agent may not write an MCP server list', () => {
  const targets = () => [
    join(agent, '.mcp.json'),
    join(other, '.mcp.json'),
    join(agent, '.claude-config', '.claude.json'),
    join(other, '.claude-config', '.claude.json'),
    join(root, '.mcp.json'),
    join(root, '.channels-config', '.claude.json'),
    join(homedir(), '.claude.json'),
  ]
  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s on every list', (tool) => {
    for (const t of targets()) expect(call(tool, { file_path: t, content: SERVER }, { subAgent: true })).toEqual(SUB)
  })
  it('a relative path, a symlink, upper case', () => {
    expect(write('.mcp.json', { subAgent: true })).toEqual(SUB)
    expect(write('.claude-config/.claude.json', { subAgent: true })).toEqual(SUB)
    expect(write('../qwen/.mcp.json', { subAgent: true })).toEqual(SUB)
    symlinkSync(join(agent, '.claude-config', '.claude.json'), join(base, 'innocent'))
    expect(write(join(base, 'innocent'), { subAgent: true })).toEqual(SUB)
    expect(write(join(agent, '.MCP.JSON'), { subAgent: true })).toEqual(SUB)
  })
  it.each([
    `echo '${SERVER}' > .mcp.json`,
    'echo x >| .mcp.json',
    'echo x >> .claude-config/.claude.json',
    "jq '.mcpServers.x={\"command\":\"sh\"}' .mcp.json | tee .mcp.json",
    "sed -i '' 's/{}/{\"x\":{}}/' .claude-config/.claude.json",
    'cp /tmp/x .mcp.json',
    'mv /tmp/x .claude-config/.claude.json',
    'rm .mcp.json',
    "python3 -c \"open('.mcp.json','w').write('{}')\"",
    'echo x > @ROOT@/.mcp.json',
    'echo x > @ROOT@/.channels-config/.claude.json',
    'cp /tmp/x ~/.claude.json',
    'echo x > ../qwen/.claude-config/.claude.json',
  ])('Bash: %s', (command) => {
    expect(bash(command, { subAgent: true })).toEqual(SUB)
  })
})

describe('the caller\'s own lists outside the install (a worker), per call', () => {
  const proj = () => join(base, 'home', '.marveen-worker')
  const cfg = () => join(proj(), '.claude-config')
  beforeEach(() => {
    mkdirSync(cfg(), { recursive: true })
    writeFileSync(join(proj(), '.mcp.json'), '{}')
    writeFileSync(join(cfg(), '.claude.json'), '{}')
  })
  it('its project .mcp.json and its config .claude.json are denied; another caller\'s are free', () => {
    const o = { subAgent: true, cwd: proj(), projectDir: proj(), configDir: cfg() }
    expect(write(join(proj(), '.mcp.json'), o)).toEqual(SUB)
    expect(write(join(cfg(), '.claude.json'), o)).toEqual(SUB)
    for (const op of ['>', '>|', '>>']) expect(bash(`echo x ${op} .claude-config/.claude.json`, o)).toEqual(SUB)
    const elsewhere = { subAgent: true, cwd: proj(), projectDir: join(base, 'elsewhere'), configDir: join(base, 'elsewhere', 'cfg') }
    expect(write(join(proj(), '.mcp.json'), elsewhere)).toEqual({ deny: false })
    expect(write(join(cfg(), '.claude.json'), elsewhere)).toEqual({ deny: false })
  })
})

describe('what stays free', () => {
  it.each([
    'cat .mcp.json',
    "jq -r '.mcpServers | keys | join(\",\")' .claude-config/.claude.json",
    'grep -c Filesystem .claude-config/.claude.json',
  ])('a read: %s', (command) => {
    expect(bash(command, { subAgent: true }).deny).toBe(false)
  })
  it('the main agent writes them (fleet MCP setup)', () => {
    const o = { subAgent: false, cwd: root, projectDir: root }
    for (const t of [join(agent, '.mcp.json'), join(agent, '.claude-config', '.claude.json'), join(root, '.mcp.json'), join(root, '.channels-config', '.claude.json')]) {
      expect(write(t, o)).toEqual({ deny: false })
    }
    expect(bash('echo x > agents/samu/.mcp.json', o).deny).toBe(false)
  })
  it('a worktree\'s own .mcp.json (another root), a deeper path, a look-alike name', () => {
    expect(write(join(wt, '.mcp.json'), { subAgent: true })).toEqual({ deny: false })
    expect(write(join(wt, 'agents', 'samu', '.mcp.json'), { subAgent: true })).toEqual({ deny: false })
    expect(write(join(agent, 'work', '.mcp.json'), { subAgent: true })).toEqual({ deny: false })
    expect(write(join(agent, 'notes-mcp.json'), { subAgent: true })).toEqual({ deny: false })
  })
})

// Dani 68088, Samu 68092: the CLI writes the list itself, so no path is in the command. Sub-agent only, every scope.
describe('`claude mcp add|add-json|remove`: a sub-agent may not run it, the main agent may', () => {
  it.each([
    'claude mcp add x -- sh -c id',
    'claude mcp add --scope user x -- npx y',
    "claude mcp add-json x '{\"command\":\"sh\"}'",
    'claude mcp add-json --scope project x \'{}\'',
    'claude mcp add-from-claude-desktop',
    'claude mcp remove gitnexus',
    'claude --debug mcp add x -- y',
    '~/.local/bin/claude mcp add x -- y',
    'CLAUDE_CONFIG_DIR=/tmp/c claude mcp add x -- y',
    'env -u FOO claude mcp add x -- y',
    'cd /tmp && claude mcp add x -- y',
    'true; claude mcp add-json x \'{}\'',
  ])('denied for a sub-agent: %s', (command) => {
    expect(bash(command, { subAgent: true })).toEqual(SUB)
  })
  it.each([
    'claude mcp list',
    'claude mcp get gitnexus',
    'claude --version',
    "echo 'claude mcp add x' > notes.md",
    'git commit -m "doc: claude mcp add is denied"',
  ])('free for a sub-agent: %s', (command) => {
    expect(bash(command, { subAgent: true }).deny).toBe(false)
  })
  it('the main agent runs it', () => {
    expect(bash('claude mcp add --scope user x -- y', { subAgent: false, cwd: root, projectDir: root }).deny).toBe(false)
  })
})

describe('the hook end to end: CLAUDE_PROJECT_DIR and CLAUDE_CONFIG_DIR are read', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
  const run = (env: Record<string, string>, tool_name: string, tool_input: Record<string, unknown>, cwd: string) => {
    const e = { ...process.env }
    delete e.CLAUDE_CONFIG_DIR; delete e.CLAUDE_PROJECT_DIR
    return spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name, tool_input, cwd }), encoding: 'utf-8', env: { ...e, ...env } })
  }
  it('a worker may not write its own config .claude.json or project .mcp.json; the message names the class', () => {
    const proj = join(base, 'home', '.marveen-worker')
    const cfg = join(proj, '.claude-config')
    mkdirSync(cfg, { recursive: true })
    const env = { CLAUDE_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg }
    for (const r of [
      run(env, 'Write', { file_path: join(cfg, '.claude.json'), content: SERVER }, proj),
      run(env, 'Bash', { command: `echo '${SERVER}' > .mcp.json` }, proj),
    ]) {
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('ENVRELAXMCPCFG1104')
    }
  })
  it('control: another path of the same worker passes', () => {
    const proj = join(base, 'home', '.marveen-worker')
    const r = run({ CLAUDE_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: join(proj, '.claude-config') }, 'Write', { file_path: join(proj, 'notes.md'), content: 'x' }, proj)
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })
})

it('the deny message names the npx form the CLI rule does not see (Samu 68172)', () => {
  expect(SUBAGENT_FILE_GATE_MSG).toContain('npx @anthropic-ai/claude-code')
})

describe('a bare glob in the sub-agent\'s own directory follows the shell dotfile rule (worker-gates count(*), #2497)', () => {
  const own = () => ({ subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })
  it.each([
    'sqlite3 ../../store/claudeclaw.db "SELECT count(*) FROM kanban_cards"',
    'sqlite3 x.db "SELECT * FROM t"',
    // GATEQUOTEDSQL1104: a "(...d...)" elsewhere in the command is not a zsh dot qualifier (the old test was
    // case-insensitive and needed no glob before the parenthesis, so these read-only queries were denied).
    'supabase db query "select left(t.id::text,8) szal from t join lateral (select * from dm_messages d where d.thread_id=t.id) m on true" > dm.out',
    'psql "$DB" -c "select f(XD), * from t"',
    // Bence 69262: a quoted "(...D...)" is never a qualifier, wherever the command's glob stands
    "grep 'x(D)' *.md",
    'sqlite3 x.db "SELECT * FROM t" | wc -l',
    'sqlite3 x.db "SELECT max(ID) FROM t"; sqlite3 x.db "SELECT count(*) FROM t"',
    "psql -c $'select f(XD), * from t'",
    // python re-runs text as code, so its whole text is read: no glob here, so the strict reading changes nothing
    'python3 -c "print(len(D))"',
  ])('passes: %s', (command) => {
    expect(bash(command, own())).toEqual({ deny: false })
  })
  // GATEFILES1110: agents/<name>/agent-config.json is a protected name WITHOUT a leading dot in this very directory, so
  // the dotfile rule no longer frees an unquoted bare glob here: the shell would expand it to agent-config.json. These
  // three passed before it; their split or quoted forms still pass.
  it.each([
    // a lower-case d qualifier (order by depth) is not the dot qualifier, but *(od[1]) still expands to a plain name
    'cp /tmp/x.txt *(od[1])',
    'echo "f(XD)"; cp /tmp/evil.json *',
    // a python -c in the same command keeps the strict reading for the whole command (#2514: re-runs text as code)
    'python3 -c "open(sys.argv[1],encoding=\'utf-8\').read()" x.md; sqlite3 -readonly x.db "SELECT count(*) FROM t"',
  ])('denied since GATEFILES1110 (an unquoted or not-proven-quoted bare glob reaches agent-config.json): %s', (command) => {
    expect(bash(command, own())).toEqual(SUB)
  })
  it.each([
    'python3 -c "open(sys.argv[1],encoding=\'utf-8\').read()" x.md',
    'sqlite3 -readonly x.db "SELECT count(*) FROM t"',
    'cp /tmp/x.txt notes.txt',
  ])('the split forms still pass: %s', (command) => {
    expect(bash(command, own())).toEqual({ deny: false })
  })
  it.each([
    'cp /tmp/evil.json .mcp.json',
    'cp /tmp/evil.json .mcp*',
    'shopt -s dotglob; cp /tmp/evil.json *',
    'setopt globdots; sqlite3 x.db "SELECT count(*) FROM t"',
    'GLOBIGNORE=x; cp /tmp/evil.json *',
    'cp /tmp/evil.json *(D)',
    'cp /tmp/evil.json ?mcp.json(D)',
    'cp /tmp/evil.json *mcp.json(D)',
    // GATEQUOTEDSQL1104: the qualifier forms that still count (a D among other qualifiers, the #q form, a bracket glob)
    'cp /tmp/evil.json *(.D)',
    'cp /tmp/evil.json *(#qD)',
    'cp /tmp/evil.json [.]mcp.json(D)',
    'echo "(id)" > x.txt; cp /tmp/evil.json *(D)',
    // a quoted or escaped literal part between the glob and the qualifier: zsh still applies (D), so these expand to
    // the leading-dot .mcp.json (measured in zsh 5.9); the literal part names no protected path by itself
    "cp /tmp/evil.json *'json'(D)",
    'cp /tmp/evil.json *"json"(D)',
    'cp /tmp/evil.json *\\json(D)',
    // Bence 69254: every unquoted group with an upper-case D counts, a glob character before it or not
    'cp /tmp/evil.json (*|x)(D)',
    'cp /tmp/evil.json (*)(D)',
    'cp /tmp/evil.json (*.json|q)(D)',
    "cp /tmp/evil.json {*,' '}(D)",
    "cp /tmp/evil.json *' x'(D)",
    // the deliberate strict case: an unquoted "(...D...)" with no glob still turns the strict reading on
    'echo f(XD); cp /tmp/evil.json *',
    // where taking the quotes out is not the shell's own reading, the whole command is read
    "zsh -c 'cp /tmp/evil.json *(D)'",
    'echo "$(cp /tmp/evil.json *(D))"',
    'echo "`cp /tmp/evil.json *(D)`"',
    "cat > f <<'EOF'\nit's\nEOF\ncp /tmp/evil.json *(D); echo \"'\"",
    "echo $((1<<EOF)) # it's\ncp /tmp/evil.json *(D)\n# that's\nEOF",
    "echo $'\\''; cp /tmp/evil.json *(D); echo $'\\''",
    "echo 'x; cp /tmp/evil.json *(D)",
    'setopt GLOB__DOTS; cp /tmp/evil.json *',
    'setopt g_l_o_b_d_o_t_s; cp /tmp/evil.json *',
    'shopt -s DotGlob; cp /tmp/evil.json *',
    'FIGNORE=x; cp /tmp/evil.json *',
    'ksh -c "FIGNORE=; cp /tmp/evil.json *"',
  ])('still denied (a dot segment, or a dotglob mode named in the command): %s', (command) => {
    expect(bash(command, own()).deny).toBe(true)
  })
  // GATEQUOTEDSQL1104: the quoted spans come out only where a plain scan pairs the quotes as the shell does
  it.each([
    ['psql -c "select f(XD), * from t"', 'psql -c Q'],
    ["grep 'x(D)' *.md", 'grep Q *.md'],
    ["psql -c $'it\\'s (XD)'", 'psql -c Q'],
    ["echo \\'; cp x *(D); echo \\'", "echo \\'; cp x *(D); echo \\'"],
    ["cp x *' x'(D)", 'cp x *Q(D)'],
  ])('the quoted spans are taken out: %s', (command, read) => {
    expect(unquotedForQualifier(command)).toBe(read)
  })
  it.each([
    "echo x # it's\ncp x *(D)\n# that's",
    "cat > f <<'EOF'\nit's\nEOF\ncp x *(D); echo \"'\"",
    // balanced for a plain scan too: the apostrophes of two heredoc bodies pair across the cp
    "cat > f <<'EOF'\nit's\nEOF\ncp x *(D)\ncat > g <<'EOF'\nthat's\nEOF",
    "echo $((1<<EOF)) 'a\ncp x *(D)\n' b",
    "echo $[1] 'a; cp x *(D); ' b",
    "echo 'x; cp x *(D)",
    'echo "x; cp x *(D)',
  ])('a quoting a plain scan may pair wrongly is read whole: %s', (command) => {
    expect(unquotedForQualifier(command)).toBe(command)
  })
  it.each([
    'echo "$(cp x *(D))" "y(D)"',
    'echo "`cp x *(D)`"',
    'echo "$(cp x "y" *(D))"',
  ])('a "..." span holding a command substitution: the whole command is read (it runs, its globs expand): %s', (command) => {
    expect(unquotedForQualifier(command)).toBe(command)
  })
  it('a substitution outside quotes stays visible, its quoted parts come out', () => {
    expect(unquotedForQualifier('echo $(cp x "y(D)" *(D))')).toBe('echo $(cp x Q *(D))')
  })
})
