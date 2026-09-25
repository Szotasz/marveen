import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root = two levels up from src/__tests__/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The Updates page and the branch-drift banner both print one command that is
// supposed to move a drifted install back onto main and update it. It is a
// STRING in the dashboard bundle, so nothing type-checks it -- and the two
// obvious spellings are both broken on a real install:
//
//   git checkout main
//     exits 128 when two remotes each carry a main (origin + a fork): git
//     cannot infer which one to follow.
//   git checkout -b main --track origin/main
//     works exactly ONCE. Run it again where a local main already exists and
//     it exits 128 with "a branch named 'main' already exists" -- which is the
//     state of every install that has already healed once.
//
// Measured 2026-09-25 (BRANCHHEAL925, kanban c4b73dab), git 2.53.0. So this
// test does not assert on the wording: it RUNS the command the dashboard would
// hand the user, in both states, in throwaway repos with two remotes.
const APP_JS = join(REPO_ROOT, 'web', 'app.js')
const HEAL_RX = /const BRANCH_HEAL_COMMAND = '([^']+)'/

function healCommand(): string {
  const m = readFileSync(APP_JS, 'utf-8').match(HEAL_RX)
  if (!m) throw new Error('BRANCH_HEAL_COMMAND not found in web/app.js')
  return m[1]
}

// update.sh must never run inside a test, so the tail is swapped for a marker.
// The swap is asserted, not assumed: if the command stops invoking update.sh,
// the banner stopped updating the install and that is a regression of its own.
function runnable(cmd: string): string {
  expect(cmd).toContain('bash update.sh')
  return cmd.replace('bash update.sh', 'echo UPDATE_RAN')
}

let tmp: string
let upstream: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

// A bare-ish source repo that both remotes will point at, so nothing in this
// test touches the network.
function makeUpstream(branch: string): string {
  const dir = join(tmp, `upstream-${branch}`)
  execFileSync('git', ['init', '-q', '-b', branch, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}

// A clone with TWO remotes (origin and fork) that both carry the upstream's
// branches -- the shape that makes `git checkout main` ambiguous.
function makeTwoRemoteClone(name: string, from: string): string {
  const dir = join(tmp, name)
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  git(dir, 'remote', 'add', 'origin', from)
  git(dir, 'remote', 'add', 'fork', from)
  git(dir, 'fetch', '-q', '--all')
  return dir
}

function runHeal(cwd: string): { status: number; stdout: string } {
  const res = execFileSync('bash', ['-c', `${runnable(healCommand())} 2>/dev/null`], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: 0, stdout: res }
}

function currentBranch(cwd: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8' }).trim()
}

describe('BRANCH_HEAL_COMMAND (the command the Updates page hands the user)', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'branch-heal-'))
    upstream = makeUpstream('main')
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('lands on main from a fresh two-remote clone, and updates', () => {
    const repo = makeTwoRemoteClone('fresh', upstream)
    const { stdout } = runHeal(repo)
    expect(currentBranch(repo)).toBe('main')
    expect(stdout).toContain('UPDATE_RAN')
  })

  it('still works where a local main already exists (the healed-once install)', () => {
    const repo = makeTwoRemoteClone('already-healed', upstream)
    runHeal(repo) // first heal creates the local main
    const { stdout } = runHeal(repo) // the state every healed install is in
    expect(currentBranch(repo)).toBe('main')
    expect(stdout).toContain('UPDATE_RAN')
  })

  it('tracks origin, not the fork', () => {
    const repo = makeTwoRemoteClone('upstream-check', upstream)
    runHeal(repo)
    const tracked = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    expect(tracked).toBe('origin/main')
  })

  it('does NOT update when no main can be reached', () => {
    // An upstream with no main at all: both switches must fail, and the
    // `(A || B) && C` precedence has to keep update.sh from running on a
    // branch the release was never cut from.
    const noMain = makeUpstream('trunk')
    const repo = makeTwoRemoteClone('no-main', noMain)
    let stdout = ''
    try {
      stdout = runHeal(repo).stdout
    } catch (e: unknown) {
      stdout = String((e as { stdout?: string }).stdout ?? '')
    }
    expect(stdout).not.toContain('UPDATE_RAN')
  })
})
