import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Auto-stash safety in update.sh.
//
// `git stash push -u` writes the untracked files into the new entry FIRST and deletes them
// AFTER. When one deletion fails, git returns an error with the entry already written and
// most untracked files already gone. The old branch then exited, leaving the working tree
// emptied of its untracked files. The fix adds (a) a gate before the stash and (b) a net
// after a failed one.
//
// The block is extracted VERBATIM from update.sh and run under `set -e` against a REAL
// throwaway git repository -- the point is git's real partial-failure behaviour, so git is
// not stubbed. Only the auto-stash block runs: nothing past it (pull, services, hooks) can.
//
// The invariant is measured on disk by this test, not through git: the tool under test is
// not asked whether it lost files.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const REAL_GIT = execFileSync('/bin/bash', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim()

function extractBlock(): string {
  const start = UPDATE_SH.indexOf('# Auto-stash safety.\n')
  expect(start, 'auto-stash safety block not found in update.sh').toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf('\n# Restore an auto-stash before an EARLY exit', start)
  expect(end, 'block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

const dirs: string[] = []
afterEach(() => {
  // The fixtures contain read-only directories on purpose; make them removable first.
  for (const d of dirs.splice(0)) {
    try { execFileSync('chmod', ['-R', 'u+rwx', d]) } catch { /* best effort */ }
    rmSync(d, { recursive: true, force: true })
  }
})

function git(repo: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd: repo, encoding: 'utf-8' })
}

/** A repo with one tracked, MODIFIED file (the only trigger for the auto-stash) and untracked files. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'update-autostash-'))
  dirs.push(repo)
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@example.invalid')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-qm', 'init')
  writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
  for (const d of ['a', 'b']) {
    mkdirSync(join(repo, d))
    for (const i of [1, 2, 3]) writeFileSync(join(repo, d, `f${i}.txt`), `${d}${i}\n`)
  }
  return repo
}

/** Every file on disk outside .git, counted by walking the tree -- independent of git. */
function filesOnDisk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, rel))) {
    if (!rel && name === '.git') continue
    const r = rel ? `${rel}/${name}` : name
    if (statSync(join(dir, r)).isDirectory()) out.push(...filesOnDisk(dir, r))
    else out.push(r)
  }
  return out.sort()
}

function stashCount(repo: string): number {
  return git(repo, 'stash', 'list').split('\n').filter(Boolean).length
}

/** A git on PATH that runs `gitScript` for `stash push` and passes everything else through. */
function wrapper(repo: string, onStashPush: string, onLsFiles = ''): string {
  const bin = join(repo, '..', `bin-${repo.split('/').pop()}`)
  mkdirSync(bin)
  dirs.push(bin)
  // `:` keeps an empty hook from becoming an empty then-block: that is a bash SYNTAX error, the
  // wrapper would fail on every call, `git status` would print nothing, and update.sh would see
  // a clean tree and skip the whole auto-stash branch -- a green test for the wrong reason
  // (measured: this is how the first version of test (5) passed as exit 0).
  writeFileSync(join(bin, 'git'), `#!/bin/bash
if [ "$1" = "stash" ] && [ "$2" = "push" ]; then
${onStashPush}
:
fi
if [ "$1" = "ls-files" ]; then
${onLsFiles}
:
fi
exec "${REAL_GIT}" "$@"
`, { mode: 0o755 })
  return bin
}

function run(repo: string, opts: { bin?: string } = {}): { code: number, out: string, msg: string } {
  const msgFile = join(repo, '..', `msg-${repo.split('/').pop()}`)
  const script = `
set -e
cd "${repo}"
${opts.bin ? `PATH="${opts.bin}:$PATH"` : ''}
RED=''; NC=''
MARVEEN_LANG=hu
RESULT_MSG=""
trap 'printf "%s" "$RESULT_MSG" > "${msgFile}"' EXIT
${extractBlock()}
echo "REACHED_END STASHED_AUTO=$STASHED_AUTO"
`
  let code = 0
  let out = ''
  try {
    out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8', env: { ...process.env, AUTO_STASH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number, stdout?: string, stderr?: string }
    code = err.status ?? -1
    out = (err.stdout ?? '') + (err.stderr ?? '')
  }
  const msg = existsSync(msgFile) ? readFileSync(msgFile, 'utf-8') : ''
  return { code, out, msg }
}

describe('update.sh auto-stash: gate before the stash', () => {
  it('(1) an untracked FILE the user cannot delete stops BEFORE the stash; nothing is lost', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'locked'))
    writeFileSync(join(repo, 'locked', 'held.bin'), 'x')
    chmodSync(join(repo, 'locked'), 0o555)
    const before = filesOnDisk(repo)

    const r = run(repo)

    expect(r.code).toBe(3)
    expect(r.out).not.toContain('REACHED_END')
    expect(stashCount(repo), 'no stash entry may be created').toBe(0)
    expect(filesOnDisk(repo), 'the working tree must be untouched').toEqual(before)
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('modified\n')
    expect(r.msg).toContain('a stash ELOTT')
    expect(r.msg).toContain('locked/held.bin')
  })

  it('(1b) an untracked DIRECTORY that cannot be removed stops too, although its files could be', () => {
    // A file-only gate passes this case: the file's own parent IS writable. But git removes
    // the emptied directory afterwards, and that needs ITS parent to be writable (measured).
    const repo = makeRepo()
    mkdirSync(join(repo, 'ro', 'sub'), { recursive: true })
    writeFileSync(join(repo, 'ro', 'sub', 'f.txt'), 'x')
    chmodSync(join(repo, 'ro'), 0o555)
    const before = filesOnDisk(repo)

    const r = run(repo)

    expect(r.code).toBe(3)
    expect(stashCount(repo)).toBe(0)
    expect(filesOnDisk(repo)).toEqual(before)
    expect(r.msg).toContain('ro/sub')
  })

  it('(5) if the untracked list cannot be produced, the gate STOPS instead of passing an empty list', () => {
    const repo = makeRepo()
    const bin = wrapper(repo, '', 'exit 128')
    const before = filesOnDisk(repo)

    const r = run(repo, { bin })

    expect(r.code).toBe(3)
    expect(stashCount(repo)).toBe(0)
    expect(filesOnDisk(repo)).toEqual(before)
    expect(r.msg).toContain('nem volt merheto')
  })
})

describe('update.sh auto-stash: net after a failed stash', () => {
  it('(2) a stash that fails AFTER the gate restores every file, overwrites nothing, keeps the entry', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, 'late'))
    writeFileSync(join(repo, 'late', 'x.bin'), 'x')
    // The directory becomes non-writable only AFTER the gate has passed (a real
    // time-of-check/time-of-use gap), so git's own partial failure happens for real.
    // Meanwhile another process re-creates one of the files the stash already deleted.
    const bin = wrapper(repo, `
chmod a-w "${repo}/late"
"${REAL_GIT}" "$@"; rc=$?
chmod u+w "${repo}/late"
mkdir -p "${repo}/a"
printf 'NEWER CONTENT\\n' > "${repo}/a/f1.txt"
exit $rc`)
    // (git removes the emptied a/ too, so the re-creating process has to make it again --
    // without the mkdir the newer file never existed and the test measured nothing.)
    const before = filesOnDisk(repo)

    const r = run(repo, { bin })

    expect(r.code).toBe(3)
    expect(r.out).not.toContain('REACHED_END')
    expect(stashCount(repo), 'the stash entry must be KEPT').toBe(1)
    expect(filesOnDisk(repo), 'every file must be back').toEqual(before)
    expect(readFileSync(join(repo, 'a', 'f1.txt'), 'utf-8'), 'a newer file must not be overwritten').toBe('NEWER CONTENT\n')
    expect(readFileSync(join(repo, 'b', 'f2.txt'), 'utf-8'), 'restored files keep their content').toBe('b2\n')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('modified\n')
    expect(r.msg).toContain('visszaallitva')
    expect(r.msg).toContain('MEGMARADT')
  })
})

describe('update.sh auto-stash: controls', () => {
  it('HAPPY PATH: with nothing blocking, the stash still happens (a gate that always refuses would pass the tests above)', () => {
    const repo = makeRepo()

    const r = run(repo)

    expect(r.out).toContain('REACHED_END STASHED_AUTO=1')
    expect(stashCount(repo)).toBe(1)
    expect(filesOnDisk(repo), 'untracked files are stashed away, only the tracked file stays').toEqual(['tracked.txt'])
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('original\n')
  })

  it('NO FALSE POSITIVE: our own files under a sticky, writable directory are removable', () => {
    // The sticky rule only bites for paths we do not own; without root we cannot create
    // another user's file, so that branch is not reproducible end-to-end here.
    const repo = makeRepo()
    mkdirSync(join(repo, 'shared'))
    writeFileSync(join(repo, 'shared', 'mine.txt'), 'x')
    chmodSync(join(repo, 'shared'), 0o1777)

    const r = run(repo)

    expect(r.out).toContain('REACHED_END STASHED_AUTO=1')
    expect(stashCount(repo)).toBe(1)
  })
})
