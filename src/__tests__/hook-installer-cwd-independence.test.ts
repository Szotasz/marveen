import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every git-hook installer must land its hooks in the repository it BELONGS TO,
// whatever directory it happens to be started from.
//
// The shape that fails looks correct: `git -C "$ROOT" rev-parse --git-common-dir`
// asks the right repository, but the ANSWER is relative to that repository
// (".git"), so resolving it with a bare `cd` resolves it against the CALLER's
// cwd. Measured on all three installers at 47d352b: started from another
// checkout, each one wrote its hooks into THAT repository's .git/hooks, printed
// its success line and exited 0 -- while the repo it was meant to protect got
// nothing. A guard that reports success and protects nothing is the one failure
// mode these guards exist to prevent.
//
// Measured behaviourally, not by text match: an installer whose comment
// describes the right path and whose code writes the wrong one is exactly the
// failure being pinned. The same resolution already shipped in
// install-graphify-refresh-hook.sh; this file keeps it fixed for all three.

const ROOT = process.cwd()

/** Each installer with the hook file that proves it ran, and the dispatcher it
 *  writes alongside. Both are asserted, because a chain entry without its
 *  dispatcher never runs either. */
const INSTALLERS = [
  {
    script: 'install-prod-tree-guard-hook.sh',
    guard: join('.git', 'hooks', 'pre-commit.d', '05-prod-tree-guard'),
    dispatcher: join('.git', 'hooks', 'pre-commit'),
  },
  {
    script: 'install-git-guard-hook.sh',
    guard: join('.git', 'hooks', 'pre-push.d', '10-no-force-push-protected'),
    dispatcher: join('.git', 'hooks', 'pre-push'),
  },
  {
    script: 'install-secret-gate-hook.sh',
    guard: join('.git', 'hooks', 'pre-commit.d', '10-secret-gate'),
    dispatcher: join('.git', 'hooks', 'pre-commit'),
  },
] as const

const stage = mkdtempSync(join(tmpdir(), 'hookcwd-'))
afterAll(() => rmSync(stage, { recursive: true, force: true }))

let n = 0
/** A throwaway git repo carrying a copy of one installer under scripts/. */
function makeRepo(label: string, script?: string): string {
  const repo = join(stage, `${label}-${n++}`)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'store'), { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
  writeFileSync(join(repo, 'x.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  if (script) cpSync(join(ROOT, 'scripts', script), join(repo, 'scripts', script))
  writeFileSync(join(repo, 'store', '.dashboard-token'), 'test-token\n')
  return repo
}

const install = (repo: string, script: string, cwd: string) =>
  spawnSync('/bin/bash', [join(repo, 'scripts', script)], { cwd, encoding: 'utf-8', timeout: 20000 })

describe.each(INSTALLERS)('$script: the install target is the repo, not the caller cwd', ({ script, guard, dispatcher }) => {
  it('NEGATIVE CONTROL: started from the repo root it installs into that repo (unchanged behaviour)', () => {
    const repo = makeRepo('root', script)
    const r = install(repo, script, repo)
    expect(r.status).toBe(0)
    expect(existsSync(join(repo, guard))).toBe(true)
    expect(existsSync(join(repo, dispatcher))).toBe(true)
  })

  it('started from a SUBDIRECTORY of its own repo it still installs into that repo', () => {
    const repo = makeRepo('subdir', script)
    const sub = join(repo, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const r = install(repo, script, sub)
    expect(r.status).toBe(0)
    expect(existsSync(join(repo, guard))).toBe(true)
  })

  it('started from a NON-GIT directory it still installs into its own repo', () => {
    const repo = makeRepo('nongit', script)
    const outside = mkdtempSync(join(stage, 'plain-'))
    const r = install(repo, script, outside)
    expect(r.status).toBe(0)
    expect(existsSync(join(repo, guard))).toBe(true)
  })

  it('started from ANOTHER checkout it guards its OWN repo and leaves the foreign one untouched', () => {
    const repo = makeRepo('own', script)
    const foreign = makeRepo('foreign')
    const r = install(repo, script, foreign)
    expect(r.status).toBe(0)
    expect(existsSync(join(repo, guard))).toBe(true)
    // The contamination half: hooks written into someone else's .git are worse
    // than no hooks -- they block operations in a repo that never asked for it,
    // and they are invisible there (nothing in that repo's tree mentions them).
    expect(existsSync(join(foreign, guard))).toBe(false)
    expect(existsSync(join(foreign, dispatcher))).toBe(false)
  })

  it('started from a LINKED WORKTREE of another repo (where .git is a FILE) it does not fail', () => {
    const repo = makeRepo('wt-own', script)
    const other = makeRepo('wt-other')
    const wt = join(stage, `wt-linked-${n++}`)
    execFileSync('git', ['-C', other, 'worktree', 'add', '-q', '-b', `probe-${n}`, wt])
    const r = install(repo, script, wt)
    expect(r.status).toBe(0)
    expect(existsSync(join(repo, guard))).toBe(true)
  })
})
