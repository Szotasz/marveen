// INSTRSURFACE1118: a sub-agent may not write an instruction surface ANOTHER session loads at its start: the install
// root's CLAUDE.md files and .claude/{rules,skills,commands,agents,output-styles} (every sub-agent loads the root as an
// ancestor of its cwd, the main agent as its project), the same under every ancestor of the root, the shared ~/.claude
// ones (the spawn links every ~/.claude entry into each agent's config dir), and every OTHER agent's. Its OWN agent
// directory stays free: that is how an agent learns (its own skills, rules, CLAUDE.md). The main agent is not
// affected. The decision functions only read paths; HOME points at a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let self: string
let other: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'instr-surface-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  self = join(root, 'agents', 'samu')
  other = join(root, 'agents', 'geri')
  for (const d of [join(home, '.claude', 'skills'), join(root, '.claude'), join(self, '.claude', 'skills'), join(self, '.claude-config'),
    join(other, '.claude', 'skills'), join(other, '.claude-config'), join(base, 'worker-home')]) mkdirSync(d, { recursive: true })
  // the isolated config dir links the shared ~/.claude entries, as agent-process.ts provisions it
  symlinkSync(join(home, '.claude', 'skills'), join(self, '.claude-config', 'skills'))
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const SUB = { deny: true, reason: 'subagent-file' }
const FREE = { deny: false }
type Opts = { subAgent?: boolean; cwd?: string; projectDir?: string }
const o = ({ subAgent = true, cwd, projectDir }: Opts = {}) => ({
  root, cwd: cwd ?? (subAgent ? self : root), subAgent,
  projectDir: projectDir ?? (subAgent ? self : root), configDir: subAgent ? join(self, '.claude-config') : null,
})
const file = (tool: string, p: string, opts: Opts = {}) => {
  const input = tool === 'NotebookEdit' ? { notebook_path: p, new_source: 'x' }
    : tool === 'MultiEdit' ? { file_path: p, edits: [{ old_string: 'a', new_string: 'b' }] }
      : tool === 'Edit' ? { file_path: p, old_string: 'a', new_string: 'b' } : { file_path: p, content: 'x' }
  return gateDecision(tool, input, o(opts))
}
const write = (p: string, opts: Opts = {}) => file('Write', p, opts)
const bash = (command: string, opts: Opts = {}) => gateDecision('Bash', { command }, o(opts))

// Relative to an agent directory, the install root or an ancestor: every surface Claude Code loads at a session start.
const SURFACES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules/style.md', '.claude/skills/x/SKILL.md',
  '.claude/commands/x.md', '.claude/agents/x.md', '.claude/output-styles/x.md']
// ...and the isolated config dir's own (user-level) ones; its skills/agents entries are links into ~/.claude
const CONFIG_SURFACES = ['.claude-config/CLAUDE.md', '.claude-config/rules/style.md', '.claude-config/commands/x.md',
  '.claude-config/output-styles/x.md']
const HOME_SURFACES = ['.claude/CLAUDE.md', '.claude/rules/style.md', '.claude/commands/x.md', '.claude/output-styles/x.md',
  '.claude/skills/x/SKILL.md', '.claude/agents/x.md']
const TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

describe('the install root: a sub-agent may not write it, the main agent may', () => {
  it.each(SURFACES)('%s', (s) => {
    for (const tool of TOOLS) expect(file(tool, join(root, s))).toEqual(SUB)
    expect(write(join(root, s), { subAgent: false })).toEqual(FREE)
  })
  it('by a relative path from the agent directory', () => {
    expect(write('../../CLAUDE.md')).toEqual(SUB)
    expect(write('../../.claude/skills/x/SKILL.md')).toEqual(SUB)
  })
})

describe('an ancestor of the install root (loaded as an ancestor of every cwd below it)', () => {
  it.each(SURFACES)('%s', (s) => {
    expect(write(join(base, s))).toEqual(SUB)
    expect(write(join(dirname(base), s))).toEqual(SUB)
    expect(write(join(base, s), { subAgent: false })).toEqual(FREE)
  })
  it('a glob from an ancestor: unquoted it may expand to its CLAUDE.md (denied), quoted it is the literal name (free)', () => {
    expect(bash(`cd ${base} && sed -i s/a/b/ *`).deny).toBe(true)
    expect(bash(`cd ${base} && python3 -c "import sys; print(sys.argv[1:])" a '*'`)).toEqual(FREE)
  })
  it('a docblock `/**` in a heredoc or a grep pattern is no write to /CLAUDE.md (the tool-log replay, 2026-11-18)', () => {
    const wt = join(base, 'install-wt')
    expect(bash(`cd ${wt} && python3 - <<'EOF'\np='app/X.php'\ns=open(p).read()\nold="""/**\n * Doc\n */"""\nopen(p,'w').write(s.replace(old,''))\nEOF`)).toEqual(FREE)
    expect(bash(`cd ${wt} && sed -n 1,60p app/X.php | grep -v "^\\s*\\*\\|/\\*\\*"`)).toEqual(FREE)
  })
  it('a sibling of the install root is not an ancestor: free', () => {
    expect(write(join(base, 'install-wt', 'CLAUDE.md'))).toEqual(FREE)
    expect(write(join(base, 'install-wt', '.claude', 'skills', 'x', 'SKILL.md'))).toEqual(FREE)
  })
})

describe('the shared ~/.claude ones (linked into every agent config dir at its spawn)', () => {
  it.each(HOME_SURFACES)('~/%s', (s) => {
    for (const tool of TOOLS) expect(file(tool, join(home, s))).toEqual(SUB)
    expect(write(join(home, s), { subAgent: false })).toEqual(FREE)
  })
  it('through the own config dir symlink', () => {
    expect(write(join(self, '.claude-config', 'skills', 'x', 'SKILL.md'))).toEqual(SUB)
  })
  it('through the own config dir links to rules/, commands/ and the CLAUDE.md file (the spawn links them too)', () => {
    // the own-directory exemption must not reach the shared tree through these links
    for (const d of ['rules', 'commands']) {
      mkdirSync(join(home, '.claude', d), { recursive: true })
      symlinkSync(join(home, '.claude', d), join(self, '.claude-config', d))
    }
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'x')
    symlinkSync(join(home, '.claude', 'CLAUDE.md'), join(self, '.claude-config', 'CLAUDE.md'))
    for (const tool of TOOLS) {
      expect(file(tool, join(self, '.claude-config', 'rules', 'style.md'))).toEqual(SUB)
      expect(file(tool, join(self, '.claude-config', 'commands', 'x.md'))).toEqual(SUB)
      expect(file(tool, join(self, '.claude-config', 'CLAUDE.md'))).toEqual(SUB)
    }
    expect(bash(`printf x >> ${join(self, '.claude-config', 'CLAUDE.md')}`)).toEqual(SUB)
    expect(bash('printf x >> .claude-config/CLAUDE.md')).toEqual(SUB)
    expect(bash('printf x > .claude-config/rules/style.md')).toEqual(SUB)
    // control: the own real CLAUDE.md stays free
    expect(write(join(self, 'CLAUDE.md'))).toEqual(FREE)
  })
})

describe("another agent's: denied", () => {
  it.each([...SURFACES, ...CONFIG_SURFACES])('%s', (s) => {
    for (const tool of TOOLS) expect(file(tool, join(other, s))).toEqual(SUB)
    expect(write(join(other, s), { subAgent: false })).toEqual(FREE)
  })
  it('by ../ from the own directory, and through a symlink kept in the own directory', () => {
    expect(write('../geri/CLAUDE.md')).toEqual(SUB)
    expect(write('../geri/.claude/skills/x/SKILL.md')).toEqual(SUB)
    symlinkSync(join(other, '.claude', 'skills'), join(self, 'shortcut'))
    expect(write(join(self, 'shortcut', 'x', 'SKILL.md'))).toEqual(SUB)
  })
  it('a caller outside agents/ (a background worker): every agent is another one', () => {
    const w = { projectDir: join(base, 'worker-home'), cwd: join(base, 'worker-home') }
    expect(write(join(self, '.claude', 'skills', 'x', 'SKILL.md'), w)).toEqual(SUB)
    expect(write(join(self, 'CLAUDE.md'), w)).toEqual(SUB)
  })
  it("the rest of another agent's directory stays free (work files, reports)", () => {
    expect(write(join(other, 'work', 'notes.md'))).toEqual(FREE)
    expect(write(join(other, 'research', 'report.md'))).toEqual(FREE)
  })
})

describe('the OWN agent directory: free (the way an agent learns)', () => {
  it.each([...SURFACES, ...CONFIG_SURFACES])('%s', (s) => {
    for (const tool of TOOLS) expect(file(tool, join(self, s))).toEqual(FREE)
  })
  it('relative, and through a symlink outside it that resolves into it', () => {
    expect(write('.claude/skills/x/SKILL.md')).toEqual(FREE)
    expect(write('CLAUDE.md')).toEqual(FREE)
    symlinkSync(join(self, '.claude', 'skills'), join(base, 'my-skills'))
    expect(write(join(base, 'my-skills', 'x', 'SKILL.md'))).toEqual(FREE)
  })
  it('the shell forms', () => {
    expect(bash("mkdir -p .claude/skills/x && cat > .claude/skills/x/SKILL.md <<'EOF'\n---\nname: x\n---\nEOF")).toEqual(FREE)
    expect(bash('printf x >> CLAUDE.md')).toEqual(FREE)
    expect(bash('rm -rf .claude/skills/x')).toEqual(FREE)
    expect(bash('sed -i s/a/b/ .claude/rules/style.md')).toEqual(FREE)
    expect(bash('cp /tmp/x.md .claude/commands/x.md')).toEqual(FREE)
  })
  it('a cd inside the own directory, then a relative write', () => {
    mkdirSync(join(self, 'work'), { recursive: true })
    expect(bash('cd .claude/skills && mkdir -p x && printf x > x/SKILL.md')).toEqual(FREE)
    expect(bash('cd work && printf x >> ../CLAUDE.md')).toEqual(FREE)
  })
})

describe('the shell routes to the denied ones', () => {
  it('>, >>, tee, cp, mv, sed -i, rm -rf, mkdir, python open()', () => {
    expect(bash(`echo x >> ${join(root, 'CLAUDE.md')}`)).toEqual(SUB)
    expect(bash(`echo x > ${join(home, '.claude', 'CLAUDE.md')}`)).toEqual(SUB)
    expect(bash(`echo x | tee ${join(other, '.claude', 'rules', 'style.md')}`)).toEqual(SUB)
    expect(bash(`cp /tmp/x.md ${join(other, '.claude', 'skills', 'x', 'SKILL.md')}`)).toEqual(SUB)
    expect(bash(`mv /tmp/x.md ${join(root, '.claude', 'commands', 'x.md')}`)).toEqual(SUB)
    expect(bash(`sed -i s/a/b/ ${join(other, 'CLAUDE.md')}`)).toEqual(SUB)
    expect(bash(`rm -rf ${join(other, '.claude', 'skills', 'x')}`)).toEqual(SUB)
    expect(bash(`mkdir -p ${join(root, '.claude', 'skills', 'x')}`).deny).toBe(true)
    expect(bash(`python3 -c "open('${join(root, '.claude', 'rules', 'x.md')}', 'w').write('x')"`).deny).toBe(true)
  })
  it('a cd into another agent directory, then a relative write', () => {
    expect(bash("cd ../geri && mkdir -p .claude/skills/x && cat > .claude/skills/x/SKILL.md <<'EOF'\nx\nEOF").deny).toBe(true)
    expect(bash('cd ../geri && printf x >> CLAUDE.md').deny).toBe(true)
  })
  it('a bare surface name from its parent', () => {
    expect(bash(`cd ${join(other, '.claude')} && rm -rf skills`).deny).toBe(true)
    expect(bash(`cd ${join(root, '.claude')} && rm -rf rules`).deny).toBe(true)
  })
})

describe('what stays free', () => {
  it('reading every surface (Read, cat, grep)', () => {
    for (const p of [join(root, 'CLAUDE.md'), join(other, '.claude', 'skills', 'x', 'SKILL.md'), join(home, '.claude', 'CLAUDE.md')]) {
      expect(gateDecision('Read', { file_path: p }, o())).toEqual(FREE)
      expect(bash(`cat ${p}`)).toEqual(FREE)
      expect(bash(`grep -n x ${p}`)).toEqual(FREE)
    }
  })
  it('a read-only sqlite query with count(*) from the own directory', () => {
    expect(bash('sqlite3 -readonly ../../store/x.db "SELECT count(*) FROM t"').deny).toBe(false)
  })
  it('a cd into another agent directory, then only reading', () => {
    expect(bash('cd ../geri && cat CLAUDE.md && grep -rn x .claude/skills')).toEqual(FREE)
  })
  it('a message file that only names a surface in its text', () => {
    expect(write(join(self, 'work', 'msg.txt'))).toEqual(FREE)
    expect(gateDecision('Write', { file_path: join(self, 'work', 'msg.txt'), content: `see ${join(other, 'CLAUDE.md')}` }, o())).toEqual(FREE)
  })
})
