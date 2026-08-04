import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Refreshing a shipped file on an existing machine is a WRITE into someone
// else's install, so the rule that makes it acceptable has to hold under test.
//
// Why the refresh exists: seeding is skip-if-exists, so a fix to a file we ship
// reaches new installs only. That is how the kanban-audit task kept calling
// sqlite3/jq -- absent on a stock Linux box -- four times a day on every
// existing machine, with two of its steps dying silently.
//
// The rule: refresh ONLY a copy that is byte-identical to SOME version we
// shipped (any point in that path's history, not just the newest), because then
// the operator provably never edited it. The direction that matters most is the
// NEGATIVE one: a locally modified file must survive untouched. Its failure
// would be silent -- the operator's edit would simply be gone -- so it gets the
// most explicit assertions here.

const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

const FUNCS = ['render_seed_template', 'seed_copy_is_untouched', 'refresh_untouched_seeds', 'run_seed_refresh']
  .map((n) => sliceShellFn(UPDATE, n))
  .join('\n')

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** A throwaway install: a git repo with a seed history, plus a ~/.claude tree. */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'seedrefresh-'))
  const install = join(base, 'install')
  const home = join(base, 'home')
  mkdirSync(join(install, 'seed-skills', 'demo'), { recursive: true })
  mkdirSync(join(install, 'seed-scheduled-tasks', 'demo-task'), { recursive: true })
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(home, '.claude', 'scheduled-tasks'), { recursive: true })
  writeFileSync(join(install, '.env'), 'MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Szabolcs\nWEB_PORT=3420\n')

  git(install, ['init', '-q'])
  git(install, ['config', 'user.email', 'test@example.invalid'])
  git(install, ['config', 'user.name', 'test'])

  const skill = join(install, 'seed-skills', 'demo', 'SKILL.md')
  const task = join(install, 'seed-scheduled-tasks', 'demo-task', 'SKILL.md')
  const versions = ['v1 shipped\n', 'v2 shipped\n', 'v3 shipped (current)\n']
  const taskVersions = ['task v1 {{MAIN_AGENT_ID}}\n', 'task v2 {{MAIN_AGENT_ID}}\n', 'task v3 {{MAIN_AGENT_ID}}\n']
  for (let i = 0; i < versions.length; i++) {
    writeFileSync(skill, versions[i])
    writeFileSync(task, taskVersions[i])
    git(install, ['add', 'seed-skills/demo/SKILL.md', 'seed-scheduled-tasks/demo-task/SKILL.md'])
    git(install, ['commit', '-q', '-m', `v${i + 1}`])
  }
  return { base, install, home, versions, taskVersions }
}

function runRefresh(install: string, home: string): { out: string; code: number } {
  const script = join(install, 'probe.sh')
  writeFileSync(script, [
    'set -u',
    'GREEN=""; NC=""',
    `INSTALL_DIR="${install}"`,
    `HOME="${home}"`,
    'MAIN_AGENT_ID=""; BOT_NAME=""; OWNER_NAME=""; WEB_PORT=""',
    FUNCS,
    'run_seed_refresh',
  ].join('\n') + '\n')
  try {
    return { out: execFileSync('bash', [script], { encoding: 'utf-8' }).trim(), code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim(), code: err.status ?? -1 }
  }
}

describe('seed refresh touches only provably untouched copies', () => {
  it('refreshes a copy that matches the CURRENT shipped version', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'skills', 'demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), f.versions[2])
      expect(runRefresh(f.install, f.home).code).toBe(0)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(f.versions[2])
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('refreshes a copy that matches an OLDER shipped version (two releases behind)', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'skills', 'demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), f.versions[0])   // untouched, but ancient
      const r = runRefresh(f.install, f.home)
      expect(r.code).toBe(0)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(f.versions[2])
      expect(r.out).toMatch(/frissitve: 1/)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('NEVER overwrites a locally modified copy -- the failure that would be silent', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'skills', 'demo')
      mkdirSync(dir, { recursive: true })
      const edited = f.versions[1] + '# the operator added this line\n'
      writeFileSync(join(dir, 'SKILL.md'), edited)
      const r = runRefresh(f.install, f.home)
      expect(r.code).toBe(0)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(edited)   // byte-for-byte
      expect(r.out).not.toMatch(/frissitve: [1-9]/)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('a one-character edit is enough to be left alone', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'skills', 'demo')
      mkdirSync(dir, { recursive: true })
      const edited = f.versions[2].replace('current', 'currenT')
      writeFileSync(join(dir, 'SKILL.md'), edited)
      runRefresh(f.install, f.home)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(edited)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('handles the TEMPLATED task copies in rendered form', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'scheduled-tasks', 'demo-task')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), 'task v1 marveen\n')          // rendered v1, untouched
      runRefresh(f.install, f.home)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe('task v3 marveen\n')
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('leaves a modified TEMPLATED copy alone too', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'scheduled-tasks', 'demo-task')
      mkdirSync(dir, { recursive: true })
      const edited = 'task v1 marveen\n# operator note\n'
      writeFileSync(join(dir, 'SKILL.md'), edited)
      runRefresh(f.install, f.home)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(edited)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('never visits a skill the operator authored (no seed source)', () => {
    const f = makeFixture()
    try {
      const mine = join(f.home, '.claude', 'skills', 'my-own-skill')
      mkdirSync(mine, { recursive: true })
      writeFileSync(join(mine, 'SKILL.md'), 'my own content\n')
      runRefresh(f.install, f.home)
      expect(readFileSync(join(mine, 'SKILL.md'), 'utf-8')).toBe('my own content\n')
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('does not create a directory that was never seeded here', () => {
    const f = makeFixture()
    try {
      runRefresh(f.install, f.home)   // no demo/ in the target at all
      // assert on the DIRECTORY, not just the file: a mutation that mkdir -p'd
      // the target still left the file absent, so a file-only check passed
      // while the guard was gone (mutation control, 2026-08-04).
      expect(existsSync(join(f.home, '.claude', 'skills', 'demo'))).toBe(false)
      expect(existsSync(join(f.home, '.claude', 'skills', 'demo', 'SKILL.md'))).toBe(false)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second pass changes nothing and reports nothing', () => {
    const f = makeFixture()
    try {
      const dir = join(f.home, '.claude', 'skills', 'demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), f.versions[0])
      runRefresh(f.install, f.home)
      const after1 = readFileSync(join(dir, 'SKILL.md'), 'utf-8')
      const second = runRefresh(f.install, f.home)
      expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(after1)
      expect(second.out).not.toMatch(/frissitve: [1-9]/)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })
})

describe('the refresh runs where it can reach an already-current machine', () => {
  it('is called before the up-to-date early exit', () => {
    const lines = UPDATE.split('\n')
    const call = lines.findIndex((l) => /^run_seed_refresh$/.test(l)) + 1
    const branch = lines.findIndex((l) => l.includes('if [ "$OLD_VERSION" = "$NEW_VERSION" ]')) + 1
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(branch)
  })

  it('does not touch CLAUDE.md -- that refresh stays behind its own flag', () => {
    const fn = sliceShellFn(UPDATE, 'run_seed_refresh') + sliceShellFn(UPDATE, 'refresh_untouched_seeds')
    expect(fn).not.toMatch(/CLAUDE\.md/)
    expect(UPDATE).toMatch(/REGEN_CLAUDEMD/)   // the flag still exists, unchanged
  })
})
