import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// STASHPOPGUARD1013: an AUTO_STASH update whose `git stash pop` conflicts used to
// restart the services on a tree full of conflict markers and report success.
// Scripts, settings JSON and hook files are read at runtime, so the markers broke
// them silently (measured on a fleet install: the channel bridge died on a syntax
// error, .claude/settings.json stopped parsing, so no hook loaded).
//
// Pinned here:
//   1. Preflight: a stash that would conflict on the target commit stops the run
//      BEFORE the pull (exit 5); the tree, HEAD and the local changes are as before.
//   2. The rehearsal never touches the real tree and leaves no worktree behind.
//   3. An untracked local file that the new commit now tracks counts as a conflict.
//   4. A rehearsal that cannot run refuses too (fail closed).
//   5. A clean stash goes through: the block reaches its end, and the later pop
//      lands the local change on top of the pulled commit.
//   6. Safety net: if the late pop conflicts anyway, the run rolls back to the old
//      commit with the local changes and exits 6 BEFORE the restart.
//
// The blocks are extracted VERBATIM from update.sh and run in bash against real
// git repos (a bare "origin" and an install clone), so the test measures the
// shipped text. npm and notify.sh are stubs that only record their calls.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function slice(startMarker: string, endMarker: string): string {
  const start = UPDATE_SH.indexOf(startMarker)
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf(endMarker, start)
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

// restore_stash_before_exit + stash_pop_probe + stash_conflict_rollback
const HELPERS = () => slice('restore_stash_before_exit() {', '# UPDOOMNPMCI926')
const PREFLIGHT = () => slice('# STASHPOPGUARD1013 (preflight)', '# Pull latest, NON-fatal')
const LATE_POP = () => slice('# Restore auto-stashed local changes before restarting services.', '# Restart services -- via a DETACHED finalizer.')

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ENV } }).trim()
}

const BASE_CHANNELS = '#!/bin/bash\necho one\necho two\necho three\n'
const LOCAL_CHANNELS = '#!/bin/bash\necho one\necho LOCAL\necho three\n'

type Upstream = 'conflict' | 'clean' | 'untracked-collision'

/** origin (bare) + install clone on OLD, with a local tracked edit and an untracked file; origin moved per `up`. */
function setup(up: Upstream) {
  const dir = mkdtempSync(join(tmpdir(), 'update-stashguard-'))
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const install = join(dir, 'install')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
  mkdirSync(join(seed, 'scripts'))
  writeFileSync(join(seed, 'scripts', 'channels.sh'), BASE_CHANNELS)
  writeFileSync(join(seed, 'settings.json'), '{"hooks": {}}\n')
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main')
  execFileSync('git', ['clone', '-q', origin, install], { stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
  const oldSha = git(install, 'rev-parse', 'HEAD')

  writeFileSync(join(install, 'scripts', 'channels.sh'), LOCAL_CHANNELS)
  writeFileSync(join(install, 'local-only.txt'), 'operator note\n')

  if (up === 'conflict') writeFileSync(join(seed, 'scripts', 'channels.sh'), '#!/bin/bash\necho one\necho UPSTREAM\necho three\n')
  if (up === 'clean') writeFileSync(join(seed, 'settings.json'), '{"hooks": {"x": 1}}\n')
  if (up === 'untracked-collision') writeFileSync(join(seed, 'local-only.txt'), 'now tracked upstream\n')
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', `upstream ${up}`); git(seed, 'push', '-q', 'origin', 'HEAD:main')

  // INSTALL_DIR is kept apart from the repo, so the stubs and store/ never land in the stash.
  const instDir = join(dir, 'instdir')
  mkdirSync(join(instDir, 'scripts'), { recursive: true })
  mkdirSync(join(instDir, 'store'))
  mkdirSync(join(instDir, 'dist'))
  writeFileSync(join(instDir, 'scripts', 'notify.sh'), `#!/bin/bash\necho "$*" >> "${join(dir, 'notify.calls')}"\n`, { mode: 0o755 })
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), `#!/bin/bash\necho "npm $*" >> "${join(dir, 'npm.calls')}"\nexit 0\n`, { mode: 0o755 })
  const probeTmp = join(dir, 'probe-tmp')
  mkdirSync(probeTmp)
  return { dir, install, instDir, bin, probeTmp, oldSha }
}

function prelude(e: ReturnType<typeof setup>, extra = ''): string {
  return `
set -e
PATH="${e.bin}:$PATH"
cd "${e.install}"
INSTALL_DIR="${e.instDir}"
RED=''; NC=''; ORANGE=''; GREEN=''; DIM=''
MARVEEN_LANG=hu
RESULT_STATUS="failed"; RESULT_PHASE="init"; RESULT_MSG=""
CURRENT_BRANCH="main"
STASHED_AUTO=0
SKIP_BUILD=0
retry() { shift 2; "$@"; }
trap 'echo "RESULT=$RESULT_STATUS|$RESULT_PHASE|$RESULT_MSG"' EXIT
OLD_VERSION_FULL="$(git rev-parse HEAD)"
OLD_VERSION="$(git rev-parse --short HEAD)"
git stash push -u -m "marveen-update-auto-stash test" >/dev/null
STASHED_AUTO=1
${extra}
${HELPERS()}
`
}

function run(e: ReturnType<typeof setup>, body: string, tmp = e.probeTmp): { code: number, out: string } {
  let code = 0
  let out = ''
  try {
    out = execFileSync('/bin/bash', ['-c', body], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV, TMPDIR: tmp } })
  } catch (err) {
    const x = err as { status?: number, stdout?: string }
    code = x.status ?? -1
    out = x.stdout ?? ''
  }
  return { code, out }
}

const PREFLIGHT_RUN = (e: ReturnType<typeof setup>) => `${prelude(e)}
git fetch --quiet origin main
DIVERGENCE_REF="FETCH_HEAD"
${PREFLIGHT()}
echo "REACHED_END"
`

function readCalls(dir: string, name: string): string {
  try { return readFileSync(join(dir, name), 'utf-8') } catch { return '' }
}

function gitGrepMarkers(cwd: string): string {
  try { return git(cwd, 'grep', '-l', '-e', '^<<<<<<< ', '-e', '^>>>>>>> ') } catch { return '' }
}

describe('update.sh auto-stash pop guard (STASHPOPGUARD1013)', () => {
  it('refuses before the pull when the stash would conflict, and leaves the tree as it was', () => {
    const e = setup('conflict')
    const r = run(e, PREFLIGHT_RUN(e))
    expect(r.code).toBe(5)
    expect(r.out).not.toContain('REACHED_END')
    expect(r.out).toContain('utkoznenek az uj verzioval (scripts/channels.sh')
    expect(r.out).toContain('RESULT=failed|stash-preflight|')
    expect(git(e.install, 'rev-parse', 'HEAD')).toBe(e.oldSha)
    expect(git(e.install, 'stash', 'list')).toBe('')
    expect(readFileSync(join(e.install, 'scripts', 'channels.sh'), 'utf-8')).toBe(LOCAL_CHANNELS)
    expect(readFileSync(join(e.install, 'local-only.txt'), 'utf-8')).toBe('operator note\n')
    expect(gitGrepMarkers(e.install)).toBe('')
    expect(readCalls(e.dir, 'notify.calls')).toContain('NEM indult el')
  })

  it('rehearses on a throwaway worktree and leaves none behind', () => {
    const e = setup('conflict')
    run(e, PREFLIGHT_RUN(e))
    expect(git(e.install, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length).toBe(1)
    expect(readdirSync(e.probeTmp)).toEqual([])
  })

  it('counts an untracked local file that the new commit tracks as a conflict', () => {
    const e = setup('untracked-collision')
    const r = run(e, PREFLIGHT_RUN(e))
    expect(r.code).toBe(5)
    expect(r.out).toContain('local-only.txt')
    expect(git(e.install, 'rev-parse', 'HEAD')).toBe(e.oldSha)
    expect(git(e.install, 'stash', 'list')).toBe('')
    expect(readFileSync(join(e.install, 'local-only.txt'), 'utf-8')).toBe('operator note\n')
  })

  it('fails closed when the rehearsal itself cannot run', () => {
    const e = setup('clean')
    const r = run(e, PREFLIGHT_RUN(e), join(e.dir, 'no-such-dir'))
    expect(r.code).toBe(5)
    expect(r.out).toContain('utkozes-probaja nem futott le')
    expect(git(e.install, 'rev-parse', 'HEAD')).toBe(e.oldSha)
    expect(git(e.install, 'stash', 'list')).toBe('')
    expect(readFileSync(join(e.install, 'scripts', 'channels.sh'), 'utf-8')).toBe(LOCAL_CHANNELS)
  })

  it('lets a clean stash through, and the late pop lands it on the pulled commit', () => {
    const e = setup('clean')
    const r = run(e, `${prelude(e)}
git fetch --quiet origin main
DIVERGENCE_REF="FETCH_HEAD"
${PREFLIGHT()}
echo "PREFLIGHT_PASSED stash=$(git stash list | wc -l)"
git pull -q --ff-only origin main
NEW_VERSION_FULL="$(git rev-parse HEAD)"
BUILT_COMMIT_FILE="$INSTALL_DIR/dist/.built-commit"
${LATE_POP()}
echo "REACHED_END"
`)
    expect(r.code).toBe(0)
    expect(r.out).toContain('PREFLIGHT_PASSED stash=1')
    expect(r.out).toContain('REACHED_END')
    expect(git(e.install, 'rev-parse', 'HEAD')).not.toBe(e.oldSha)
    expect(readFileSync(join(e.install, 'settings.json'), 'utf-8')).toBe('{"hooks": {"x": 1}}\n')
    expect(readFileSync(join(e.install, 'scripts', 'channels.sh'), 'utf-8')).toBe(LOCAL_CHANNELS)
    expect(git(e.install, 'stash', 'list')).toBe('')
    expect(readdirSync(e.probeTmp)).toEqual([])
  })

  it('skips the rehearsal when there is nothing to pull', () => {
    const e = setup('clean')
    const r = run(e, `${prelude(e)}
DIVERGENCE_REF="HEAD"
${PREFLIGHT()}
echo "REACHED_END"
`)
    expect(r.code).toBe(0)
    expect(r.out).toContain('REACHED_END')
    expect(r.out).not.toContain('utkozes-proba')
  })

  it('safety net: a late pop conflict rolls back with the local changes and exits before the restart', () => {
    const e = setup('conflict')
    const r = run(e, `${prelude(e)}
git pull -q --ff-only origin main
NEW_VERSION_FULL="$(git rev-parse HEAD)"
BUILT_COMMIT_FILE="$INSTALL_DIR/dist/.built-commit"
${LATE_POP()}
echo "REACHED_RESTART"
`)
    expect(r.code).toBe(6)
    expect(r.out).not.toContain('REACHED_RESTART')
    expect(r.out).toContain('RESULT=rolled-back|stash-restore|A helyi valtozasok visszaallitasa utkozott az uj verzioval (scripts/channels.sh')
    expect(r.out).not.toContain("a 'git stash list'-ben maradtak")
    expect(git(e.install, 'rev-parse', 'HEAD')).toBe(e.oldSha)
    expect(git(e.install, 'stash', 'list')).toBe('')
    expect(git(e.install, 'diff', '--name-only', '--diff-filter=U')).toBe('')
    expect(gitGrepMarkers(e.install)).toBe('')
    expect(readFileSync(join(e.install, 'scripts', 'channels.sh'), 'utf-8')).toBe(LOCAL_CHANNELS)
    expect(readFileSync(join(e.install, 'local-only.txt'), 'utf-8')).toBe('operator note\n')
    expect(readFileSync(join(e.instDir, 'dist', '.built-commit'), 'utf-8').trim()).toBe(e.oldSha)
    const npm = readCalls(e.dir, 'npm.calls')
    expect(npm).toContain('npm rebuild better-sqlite3')
    expect(npm.match(/npm run build/g)?.length).toBe(2)
    expect(npm).not.toContain('npm ci')
    expect(readCalls(e.dir, 'notify.calls')).toContain('visszaallas')
  })
})
