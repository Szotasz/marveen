import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SEEDSKILLSUB1018: the seed-skills loops copied top-level files only, so a
// skill's subdirs never reached ~/.claude/skills/. fleet-helper's SKILL.md
// points at scripts/fleet.py, scripts/mail_triage.py, ...; on the reference
// host ~/.claude/skills/fleet-helper/ held SKILL.md alone (measured
// 2026-10-18). These tests require the subdir files IN THE INSTALLED TARGET on
// every path that writes one, and the update refresh to add them under the
// same untouched-SKILL.md rule as a task's references/ (SEEDREFDIR1018).

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

/** The `for skill_dir in "$SEED_SKILLS_DIR"/*\/; do ... done` loop, verbatim. */
function sliceSkillLoop(src: string): string {
  const lines = src.split('\n')
  const i = lines.findIndex((l) => l.trim() === 'for skill_dir in "$SEED_SKILLS_DIR"/*/; do')
  if (i < 0) throw new Error('seed-skills loop not found')
  const indent = lines[i].slice(0, lines[i].indexOf('for'))
  const j = lines.findIndex((l, k) => k > i && l === `${indent}done`)
  if (j < 0) throw new Error('unterminated seed-skills loop')
  return lines.slice(i, j + 1).join('\n')
}

function runSkillLoop(src: string, seedDir: string, skillsDir: string, file: string): void {
  writeFileSync(file, [
    'set -u',
    `SEED_SKILLS_DIR="${seedDir}"`,
    `SKILLS_DIR="${skillsDir}"`,
    'RESEED_FLEET=0; SEED_NEW=0; SEED_SKIP=0; SEED_FORCED=0',
    sliceSkillLoop(src),
  ].join('\n') + '\n')
  execFileSync('bash', [file], { encoding: 'utf-8' })
}

const LOOPS: Array<[string, string]> = [
  ['install-linux.sh', LINUX],
  ['install-macos.sh', MACOS],
  ['update.sh', UPDATE],
]

describe('a fresh skill seed ships the skill subdirs (SEEDSKILLSUB1018)', () => {
  for (const [label, src] of LOOPS) {
    it(`${label}: scripts/ arrives verbatim, mode bits and dotfiles included`, () => {
      const base = mkdtempSync(join(tmpdir(), 'seedskill-'))
      try {
        const skill = join(base, 'seed', 'demo')
        mkdirSync(join(skill, 'scripts'), { recursive: true })
        writeFileSync(join(skill, 'SKILL.md'), 'run scripts/tool.py {{MAIN_AGENT_ID}}\n')
        writeFileSync(join(skill, 'scripts', 'tool.py'), 'print("{{MAIN_AGENT_ID}}")\n')
        chmodSync(join(skill, 'scripts', 'tool.py'), 0o755)
        writeFileSync(join(skill, 'scripts', '.gitignore'), 'local.json\n')
        const skills = join(base, 'skills')
        mkdirSync(skills)
        runSkillLoop(src, join(base, 'seed'), skills, join(base, 'probe.sh'))
        const tool = join(skills, 'demo', 'scripts', 'tool.py')
        expect(existsSync(tool)).toBe(true)
        expect(readFileSync(tool, 'utf-8')).toBe('print("{{MAIN_AGENT_ID}}")\n')   // verbatim, not templated
        expect(statSync(tool).mode & 0o777).toBe(0o755)
        expect(existsSync(join(skills, 'demo', 'scripts', '.gitignore'))).toBe(true)
        expect(existsSync(join(skills, 'demo', 'scripts', 'scripts'))).toBe(false) // no nesting
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  }

  it('the shipped fleet-helper lands with scripts/fleet.py (install-linux.sh loop, real seed-skills/)', () => {
    const base = mkdtempSync(join(tmpdir(), 'seedskill-real-'))
    try {
      const skills = join(base, 'skills')
      mkdirSync(skills)
      runSkillLoop(LINUX, join(ROOT, 'seed-skills'), skills, join(base, 'probe.sh'))
      const fleet = join(skills, 'fleet-helper', 'scripts', 'fleet.py')
      expect(existsSync(fleet)).toBe(true)
      expect(readFileSync(fleet)).toEqual(readFileSync(join(ROOT, 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py')))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// Sliced per call, so a missing helper fails the refresh tests, not the file.
const funcs = () => ['render_seed_template', 'seed_copy_is_untouched', 'render_seed_file', 'refresh_one_seed_file', 'refresh_untouched_seeds', 'run_seed_refresh']
  .map((n) => sliceShellFn(UPDATE, n))
  .join('\n')

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** v1 ships SKILL.md only; v2 adds scripts/tool.py (executable). */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'seedskill-refresh-'))
  const install = join(base, 'install')
  const skill = join(install, 'seed-skills', 'demo')
  mkdirSync(skill, { recursive: true })
  git(install, ['init', '-q'])
  git(install, ['config', 'user.email', 'test@example.invalid'])
  git(install, ['config', 'user.name', 'test'])
  writeFileSync(join(skill, 'SKILL.md'), 'v1 inline\n')
  git(install, ['add', '-A']); git(install, ['commit', '-q', '-m', 'v1'])
  writeFileSync(join(skill, 'SKILL.md'), 'v2: run scripts/tool.py\n')
  mkdirSync(join(skill, 'scripts'))
  writeFileSync(join(skill, 'scripts', 'tool.py'), 'print(1)\n')
  chmodSync(join(skill, 'scripts', 'tool.py'), 0o755)
  git(install, ['add', '-A']); git(install, ['commit', '-q', '-m', 'v2'])
  const home = join(base, 'home')
  const live = join(home, '.claude', 'skills', 'demo')
  mkdirSync(live, { recursive: true })
  mkdirSync(join(home, '.claude', 'scheduled-tasks'), { recursive: true })
  return { base, install, home, live }
}

function runRefresh(f: ReturnType<typeof makeFixture>): string {
  const file = join(f.base, 'probe.sh')
  writeFileSync(file, [
    'set -u', 'GREEN=""; NC=""',
    `INSTALL_DIR="${f.install}"`, `HOME="${f.home}"`,
    'MAIN_AGENT_ID=""; BOT_NAME=""; OWNER_NAME=""; WEB_PORT=""',
    funcs(),
    'run_seed_refresh',
    'echo "updated=$SEED_REFRESH_UPDATED kept=$SEED_REFRESH_KEPT"',
  ].join('\n') + '\n')
  return execFileSync('bash', [file], { encoding: 'utf-8' }).trim().split('\n').pop() ?? ''
}

describe('the update refresh brings a skill subdir to an existing install (SEEDSKILLSUB1018)', () => {
  it('an untouched old skill gets the new SKILL.md AND scripts/tool.py, mode kept', () => {
    const f = makeFixture()
    try {
      writeFileSync(join(f.live, 'SKILL.md'), 'v1 inline\n')
      expect(runRefresh(f)).toBe('updated=2 kept=0')
      expect(readFileSync(join(f.live, 'SKILL.md'), 'utf-8')).toBe('v2: run scripts/tool.py\n')
      const tool = join(f.live, 'scripts', 'tool.py')
      expect(readFileSync(tool, 'utf-8')).toBe('print(1)\n')
      expect(statSync(tool).mode & 0o777).toBe(0o755)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('a locally edited SKILL.md is kept and its skill gets no scripts/ added', () => {
    const f = makeFixture()
    try {
      writeFileSync(join(f.live, 'SKILL.md'), 'v1 inline\n# mine\n')
      expect(runRefresh(f)).toBe('updated=0 kept=1')
      expect(existsSync(join(f.live, 'scripts'))).toBe(false)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('a task dir still gets references/ only: another subdir is not added there', () => {
    const base = mkdtempSync(join(tmpdir(), 'seedskill-task-'))
    try {
      const install = join(base, 'install')
      const task = join(install, 'seed-scheduled-tasks', 'scan')
      mkdirSync(join(task, 'threat-intel'), { recursive: true })
      git(install, ['init', '-q'])
      git(install, ['config', 'user.email', 'test@example.invalid'])
      git(install, ['config', 'user.name', 'test'])
      writeFileSync(join(task, 'SKILL.md'), 'scan\n')
      writeFileSync(join(task, 'threat-intel', 'cat.json'), '{}\n')
      git(install, ['add', '-A']); git(install, ['commit', '-q', '-m', 'v1'])
      const home = join(base, 'home')
      const live = join(home, '.claude', 'scheduled-tasks', 'scan')
      mkdirSync(live, { recursive: true })
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
      writeFileSync(join(live, 'SKILL.md'), 'scan\n')
      const file = join(base, 'probe.sh')
      writeFileSync(file, [
        'set -u', 'GREEN=""; NC=""',
        `INSTALL_DIR="${install}"`, `HOME="${home}"`,
        'MAIN_AGENT_ID="m"; BOT_NAME=""; OWNER_NAME=""; WEB_PORT=""',
        funcs(), 'run_seed_refresh',
      ].join('\n') + '\n')
      execFileSync('bash', [file], { encoding: 'utf-8' })
      expect(existsSync(join(live, 'threat-intel'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
