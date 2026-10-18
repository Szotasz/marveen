import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SEEDREFDIR1018: a shipped task may keep part of its text in a references/
// subdir that its SKILL.md points at (#2050 moves kanban-audit's step 4b and
// its pitfalls there). Every seeding loop copied top-level files only, and the
// update refresh never entered a subdir, so the pointer landed on a file that
// did not exist -- on a fresh install AND on every untouched copy the refresh
// slimmed down. These tests require the references file IN THE INSTALLED
// TARGET, on each path that writes one.

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

/** The `for tpl in "<dirVar>"/*\/; do ... done` loop, verbatim, up to its own `done`. */
function sliceTplLoop(src: string, dirVar: string): string {
  const lines = src.split('\n')
  const head = `for tpl in "$${dirVar}"/*/; do`
  const i = lines.findIndex((l) => l.trim() === head)
  if (i < 0) throw new Error(`loop over ${dirVar} not found`)
  const indent = lines[i].slice(0, lines[i].indexOf('for'))
  const j = lines.findIndex((l, k) => k > i && l === `${indent}done`)
  if (j < 0) throw new Error(`unterminated loop over ${dirVar}`)
  return lines.slice(i, j + 1).join('\n')
}

function run(script: string, file: string): string {
  writeFileSync(file, script)
  return execFileSync('bash', [file], { encoding: 'utf-8' })
}

const SKILL = 'step 4b: read references/w.md ({{MAIN_AGENT_ID}})\n'
const REF = 'waiting check for {{MAIN_AGENT_ID}} at {{INSTALL_DIR}}\n'

function makeSeedTree(base: string, srcRel: string): string {
  const install = join(base, 'install')
  const task = join(install, srcRel, 'demo-task')
  mkdirSync(join(task, 'references'), { recursive: true })
  writeFileSync(join(task, 'SKILL.md'), SKILL)
  writeFileSync(join(task, 'task-config.json'), '{"enabled":true}\n')
  writeFileSync(join(task, 'references', 'w.md'), REF)
  return install
}

const LOOPS: Array<[string, string, string, string]> = [
  ['install-linux.sh seed-scheduled-tasks', LINUX, 'SEED_SCHED_DIR', 'seed-scheduled-tasks'],
  ['install-macos.sh seed-scheduled-tasks', MACOS, 'SEED_SCHED_DIR', 'seed-scheduled-tasks'],
  ['update.sh seed-scheduled-tasks', UPDATE, 'SEED_SCHED_DIR', 'seed-scheduled-tasks'],
  ['install-linux.sh templates/scheduled-tasks', LINUX, 'SCHED_TPL_DIR', 'templates/scheduled-tasks'],
  ['install-macos.sh templates/scheduled-tasks', MACOS, 'SCHED_TPL_DIR', 'templates/scheduled-tasks'],
]

describe('a fresh seed ships the references/ subdir, rendered (SEEDREFDIR1018)', () => {
  for (const [label, src, dirVar, srcRel] of LOOPS) {
    it(label, () => {
      const base = mkdtempSync(join(tmpdir(), 'seedref-'))
      try {
        const install = makeSeedTree(base, srcRel)
        const target = join(base, 'home', 'scheduled-tasks')
        mkdirSync(target, { recursive: true })
        run([
          'set -u',
          'ok() { :; }; warn() { :; }; GREEN=""; NC=""',
          `INSTALL_DIR="${install}"`,
          `${dirVar}="${join(install, srcRel)}"`,
          `SCHED_TARGET_DIR="${target}"`,
          'SCHED_TOMBSTONE="$SCHED_TARGET_DIR/.removed-defaults"',
          'RESEED_FLEET=0; SCHED_NEW=0; SCHED_SKIP=0; SCHED_FORCED=0',
          'MAIN_AGENT_ID=marveen; BOT_NAME=Bot; OWNER_NAME=Owner; WEB_PORT=3420',
          sliceTplLoop(src, dirVar),
        ].join('\n') + '\n', join(base, 'probe.sh'))
        const ref = join(target, 'demo-task', 'references', 'w.md')
        expect(existsSync(ref)).toBe(true)
        expect(readFileSync(ref, 'utf-8')).toBe(`waiting check for marveen at ${install}\n`)
        expect(readFileSync(join(target, 'demo-task', 'SKILL.md'), 'utf-8')).toBe('step 4b: read references/w.md (marveen)\n')
        expect(existsSync(join(target, 'demo-task', 'task-config.json'))).toBe(true)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  }

  it('a task without references/ gets no empty references dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'seedref-'))
    try {
      const install = join(base, 'install')
      mkdirSync(join(install, 'seed-scheduled-tasks', 'plain'), { recursive: true })
      writeFileSync(join(install, 'seed-scheduled-tasks', 'plain', 'SKILL.md'), 'plain\n')
      const target = join(base, 'home')
      mkdirSync(target, { recursive: true })
      run([
        'set -u', 'ok() { :; }; GREEN=""; NC=""',
        `INSTALL_DIR="${install}"`,
        `SEED_SCHED_DIR="${join(install, 'seed-scheduled-tasks')}"`,
        `SCHED_TARGET_DIR="${target}"`, 'SCHED_TOMBSTONE="$SCHED_TARGET_DIR/.removed-defaults"',
        'SCHED_NEW=0; SCHED_SKIP=0; MAIN_AGENT_ID=m; BOT_NAME=b; OWNER_NAME=o',
        sliceTplLoop(LINUX, 'SEED_SCHED_DIR'),
      ].join('\n') + '\n', join(base, 'probe.sh'))
      expect(existsSync(join(target, 'plain', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(target, 'plain', 'references'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// Sliced per call, so a missing helper fails the refresh tests, not the file.
const funcs = () => ['render_seed_template', 'seed_copy_is_untouched', 'render_seed_file', 'refresh_one_seed_file', 'refresh_untouched_seeds']
  .map((n) => sliceShellFn(UPDATE, n))
  .join('\n')

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
}

/** v1 ships SKILL.md only; v2 slims it and moves text into references/. */
function makeRefreshFixture() {
  const base = mkdtempSync(join(tmpdir(), 'seedref-refresh-'))
  const install = join(base, 'install')
  const task = join(install, 'seed-scheduled-tasks', 'demo-task')
  mkdirSync(task, { recursive: true })
  git(install, ['init', '-q'])
  git(install, ['config', 'user.email', 'test@example.invalid'])
  git(install, ['config', 'user.name', 'test'])
  const v1 = 'v1 fat: step 4b inline ({{MAIN_AGENT_ID}})\n'
  writeFileSync(join(task, 'SKILL.md'), v1)
  git(install, ['add', '-A']); git(install, ['commit', '-q', '-m', 'v1'])
  const refV1 = 'ref v1 for {{MAIN_AGENT_ID}}\n'
  writeFileSync(join(task, 'SKILL.md'), SKILL)
  mkdirSync(join(task, 'references'))
  writeFileSync(join(task, 'references', 'w.md'), refV1)
  git(install, ['add', '-A']); git(install, ['commit', '-q', '-m', 'v2'])
  const live = join(base, 'home', 'scheduled-tasks', 'demo-task')
  mkdirSync(live, { recursive: true })
  const r = (s: string) => s.replaceAll('{{MAIN_AGENT_ID}}', 'marveen').replaceAll('{{INSTALL_DIR}}', install)
  return { base, install, task, live, v1, refV1, r }
}

function runRefresh(f: ReturnType<typeof makeRefreshFixture>): string {
  return run([
    'set -u',
    `INSTALL_DIR="${f.install}"`,
    'MAIN_AGENT_ID=marveen; BOT_NAME=""; OWNER_NAME=""; WEB_PORT=3420',
    'SEED_REFRESH_UPDATED=0; SEED_REFRESH_KEPT=0',
    funcs(),
    `refresh_untouched_seeds "seed-scheduled-tasks" "${join(f.base, 'home', 'scheduled-tasks')}" "template"`,
    'echo "updated=$SEED_REFRESH_UPDATED kept=$SEED_REFRESH_KEPT"',
  ].join('\n') + '\n', join(f.base, 'probe.sh')).trim()
}

describe('the update refresh handles the references/ subdir (SEEDREFDIR1018)', () => {
  it('an untouched old copy gets the slim SKILL.md AND the references file it points at', () => {
    const f = makeRefreshFixture()
    try {
      writeFileSync(join(f.live, 'SKILL.md'), f.r(f.v1))
      expect(runRefresh(f)).toBe('updated=2 kept=0')
      expect(readFileSync(join(f.live, 'SKILL.md'), 'utf-8')).toBe(f.r(SKILL))
      expect(readFileSync(join(f.live, 'references', 'w.md'), 'utf-8')).toBe(f.r(f.refV1))
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('a locally edited SKILL.md is kept and its directory gets nothing added', () => {
    const f = makeRefreshFixture()
    try {
      const edited = f.r(f.v1) + '# local lesson\n'
      writeFileSync(join(f.live, 'SKILL.md'), edited)
      expect(runRefresh(f)).toBe('updated=0 kept=1')
      expect(readFileSync(join(f.live, 'SKILL.md'), 'utf-8')).toBe(edited)
      expect(existsSync(join(f.live, 'references'))).toBe(false)
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('an untouched old references file is refreshed, an edited one survives byte-for-byte', () => {
    const f = makeRefreshFixture()
    try {
      const refV2 = 'ref v2 for {{MAIN_AGENT_ID}}\n'
      writeFileSync(join(f.task, 'references', 'w.md'), refV2)
      writeFileSync(join(f.task, 'references', 'x.md'), 'x v1\n')
      git(f.install, ['add', '-A']); git(f.install, ['commit', '-q', '-m', 'v3'])
      writeFileSync(join(f.task, 'references', 'x.md'), 'x v2\n')
      git(f.install, ['add', '-A']); git(f.install, ['commit', '-q', '-m', 'v4'])

      mkdirSync(join(f.live, 'references'))
      writeFileSync(join(f.live, 'SKILL.md'), f.r(SKILL))
      writeFileSync(join(f.live, 'references', 'w.md'), f.r(f.refV1))          // untouched, old
      writeFileSync(join(f.live, 'references', 'x.md'), 'x v1\n# mine\n')     // edited
      writeFileSync(join(f.live, 'references', 'own.md'), 'operator file\n')  // not shipped
      expect(runRefresh(f)).toBe('updated=1 kept=1')
      expect(readFileSync(join(f.live, 'references', 'w.md'), 'utf-8')).toBe(f.r(refV2))
      expect(readFileSync(join(f.live, 'references', 'x.md'), 'utf-8')).toBe('x v1\n# mine\n')
      expect(readFileSync(join(f.live, 'references', 'own.md'), 'utf-8')).toBe('operator file\n')
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second run changes nothing and reports nothing', () => {
    const f = makeRefreshFixture()
    try {
      writeFileSync(join(f.live, 'SKILL.md'), f.r(f.v1))
      runRefresh(f)
      expect(runRefresh(f)).toBe('updated=0 kept=0')
      expect(readFileSync(join(f.live, 'references', 'w.md'), 'utf-8')).toBe(f.r(f.refV1))
    } finally {
      rmSync(f.base, { recursive: true, force: true })
    }
  })
})
