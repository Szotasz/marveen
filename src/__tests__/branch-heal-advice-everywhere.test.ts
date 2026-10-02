import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// BRANCHHEAL925, follow-up to #1566. That PR fixed the ONE command the Updates
// page hands the user. The same advice stands in five more places -- update.sh
// prints it from three guards, update-preflight.ts returns it in two messages --
// and every one of them was the bare `git checkout main`, which fails in exactly
// the two states #1566 measured:
//
//   two remotes that both carry main (origin + a fork)  -> exit 128, ambiguous
//   an install that has already healed once             -> `checkout -b` exits 128
//
// So this test does not pin one more string. It EXTRACTS every command those
// files advise, refuses the broken spellings wherever they appear, and RUNS the
// advised command in both states. A sixth entry point added later is caught by
// the extraction, not by someone remembering this file exists.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8')

// The two spellings #1566 measured as broken. Either one appearing in advice is
// a regression, whichever file it appears in.
const BROKEN = [
  'git checkout main',
  'git checkout -b main --track origin/main',
]

/** Commands update.sh tells the operator to type: `echo "   <a git command>"`. */
function shellAdvice(): string[] {
  return read('update.sh')
    .split('\n')
    .map(l => l.match(/^\s*echo "\s*(git [^"]*?)\s*"\s*$/)?.[1])
    .filter((c): c is string => Boolean(c))
}

/** Commands update-preflight.ts puts in a user-facing message. */
function preflightAdvice(): string[] {
  return [...read('src/update-preflight.ts').matchAll(/'([^'\n]*git [^'\n]*)'/g)]
    .map(m => m[1])
    .filter(c => c.includes('main'))
}

/** The dashboard's constant, from #1566 -- the one that is already measured. */
function healCommand(): string {
  const m = read('web/app.js').match(/const BRANCH_HEAL_COMMAND = '([^']+)'/)
  if (!m) throw new Error('BRANCH_HEAL_COMMAND not found in web/app.js')
  return m[1]
}

/** The switch part, without the `&& bash update.sh` tail the guards must not have. */
const healFragment = () => healCommand().replace(/\s*&&\s*bash update\.sh\s*$/, '')

let tmp: string
let upstream: string

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

function makeUpstream(branch: string): string {
  const dir = join(tmp, `upstream-${branch}`)
  execFileSync('git', ['init', '-q', '-b', branch, dir], { stdio: 'pipe' })
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}

/** origin AND fork both carrying main: the shape that makes plain checkout ambiguous. */
function makeTwoRemoteClone(name: string, from: string): string {
  const dir = join(tmp, name)
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  git(dir, 'remote', 'add', 'origin', from)
  git(dir, 'remote', 'add', 'fork', from)
  git(dir, 'fetch', '-q', '--all')
  return dir
}

function run(cwd: string, cmd: string): number {
  try {
    execFileSync('bash', ['-c', `${cmd} >/dev/null 2>&1`], { cwd, stdio: 'pipe' })
    return 0
  } catch (e: unknown) {
    return Number((e as { status?: number }).status ?? 1)
  }
}

const currentBranch = (cwd: string) =>
  execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8' }).trim()

describe('every place that advises getting back onto main advises a command that works', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'heal-advice-'))
    upstream = makeUpstream('main')
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('update.sh advises three commands about main, none of them a broken spelling', () => {
    const about = shellAdvice().filter(c => c.includes('main'))
    // Three guards: shallow detached HEAD, plain detached HEAD, branch-not-on-origin.
    expect(about.filter(c => c.startsWith('git switch'))).toHaveLength(3)
    for (const cmd of about) expect(BROKEN).not.toContain(cmd)
  })

  it('update-preflight.ts advises the same, in both of its messages', () => {
    const about = preflightAdvice()
    expect(about.filter(c => c.includes('git switch main'))).toHaveLength(2)
    for (const cmd of about) {
      for (const broken of BROKEN) expect(cmd).not.toBe(broken)
    }
  })

  it('the guards advise the dashboard command, minus the tail that would update the install', () => {
    // Parity, so the six entry points cannot drift apart. The guards must NOT
    // append `bash update.sh`: their own prose already says to start the update
    // again afterwards, and update.sh printing "now run update.sh" is a loop.
    const fragment = healFragment()
    const shell = shellAdvice().filter(c => c.startsWith('git switch'))
    const preflight = preflightAdvice().filter(c => c.includes('git switch'))
    // Scope first: without these two counts the loops below pass vacuously on an
    // empty list, which is exactly what happened while this test was being written.
    expect(shell).toHaveLength(3)
    expect(preflight).toHaveLength(2)
    for (const cmd of shell) {
      expect(cmd).toBe(fragment)
      expect(cmd).not.toContain('update.sh')
    }
    for (const cmd of preflight) {
      expect(cmd).toContain(fragment)
      expect(cmd).not.toContain('update.sh')
    }
  })

  it('the advised command lands on main from a fresh two-remote clone', () => {
    const repo = makeTwoRemoteClone('fresh', upstream)
    expect(run(repo, healFragment())).toBe(0)
    expect(currentBranch(repo)).toBe('main')
  })

  it('and still works where a local main already exists (the healed-once install)', () => {
    const repo = makeTwoRemoteClone('already-healed', upstream)
    run(repo, healFragment())
    expect(run(repo, healFragment())).toBe(0)
    expect(currentBranch(repo)).toBe('main')
  })

  it('it tracks origin, not the fork', () => {
    const repo = makeTwoRemoteClone('upstream-check', upstream)
    run(repo, healFragment())
    const tracked = execFileSync(
      'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: repo, encoding: 'utf-8' },
    ).trim()
    expect(tracked).toBe('origin/main')
  })

  it('the broken spellings really do fail in these states, so the test measures something', () => {
    // Without this the suite above could pass against a command that was never
    // in danger. Both broken forms have to actually fail where #1566 said they do.
    const ambiguous = makeTwoRemoteClone('broken-ambiguous', upstream)
    expect(run(ambiguous, 'git checkout main')).not.toBe(0)

    const healed = makeTwoRemoteClone('broken-second-run', upstream)
    expect(run(healed, 'git checkout -b main --track origin/main')).toBe(0)
    expect(run(healed, 'git checkout -b main --track origin/main')).not.toBe(0)
  })
})
