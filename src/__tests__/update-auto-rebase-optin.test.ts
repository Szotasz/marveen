import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// AUTOREBASEOPTIN922 (2026-09-22, upstream review on #1460): the diverged-history
// refusal (#1112) is a DELIBERATE human checkpoint, so auto-rebase must be opt-in.
// Two contracts are pinned here, both raised in that review:
//
//   1. Default (no UPDATE_AUTO_REBASE) must behave exactly like #1112: loud exit 5,
//      and NO rebase attempted. A regression here silently rewrites a user's history.
//   2. With the opt-in ON, a FAILED fetch must NOT fall through to the rebase. The
//      original patch swallowed it with `|| true`, so the rebase then ran against a
//      STALE origin ref: no error, just something other than what was asked for.
//
// The block is extracted VERBATIM from update.sh and run in bash with git, notify.sh
// and the surrounding helpers stubbed on PATH, so the test measures the shipped text.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function extractBlock(): string {
  // Starts at the fetch that feeds the divergence counts (UPSTREAMSRC927), so the
  // extracted text also covers WHICH ref is measured, not only what follows.
  const start = UPDATE_SH.indexOf('DIVERGENCE_REF="FETCH_HEAD"')
  expect(start, 'diverged-history block not found in update.sh').toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf('\nif [ "${AHEAD:-0}" -gt 0 ]; then', start)
  expect(end, 'block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

/** Runs the block with a stubbed git. `gitScript` decides what each git subcommand does. */
function run(opts: { autoRebase?: string, gitScript: string }): { code: number, out: string, log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'update-autorebase-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'store'))
  mkdirSync(join(dir, 'scripts'))
  writeFileSync(join(bin, 'git'), opts.gitScript, { mode: 0o755 })
  writeFileSync(join(dir, 'scripts', 'notify.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  chmodSync(join(bin, 'git'), 0o755)

  const script = `
set -u
PATH="${bin}:$PATH"
INSTALL_DIR="${dir}"
CURRENT_BRANCH="develop"
AHEAD=3
RED=''; NC=''; ORANGE=''; GREEN=''
RESULT_MSG=""
restore_stash_before_exit() { :; }
${extractBlock()}
echo "REACHED_END"
`
  let code = 0
  let out = ''
  try {
    out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8', env: { ...process.env, ...(opts.autoRebase ? { UPDATE_AUTO_REBASE: opts.autoRebase } : {}) } })
  } catch (e) {
    const err = e as { status?: number, stdout?: string }
    code = err.status ?? -1
    out = err.stdout ?? ''
  }
  let log = ''
  try { log = readFileSync(join(dir, 'store', 'update.log'), 'utf-8') } catch { /* may not exist */ }
  return { code, out, log }
}

// `rev-list` answers BEHIND=2 (so the branch is diverged); everything else is recorded.
const GIT_BASE = `#!/bin/bash
echo "git $*" >> "$STUB_CALLS"
case "$1 $2" in
  "rev-list --count") echo 2; exit 0 ;;
esac
`

function gitStub(extra: string): string {
  return `#!/bin/bash
STUB_CALLS="\${STUB_CALLS:-/dev/null}"
echo "git $*" >> "$STUB_CALLS"
if [ "$1" = "rev-list" ]; then echo 2; exit 0; fi
${extra}
exit 0
`
}

describe('update.sh diverged-history handling', () => {
  it('defaults to the #1112 refusal and never rebases', () => {
    const r = run({ gitScript: gitStub('if [ "$1" = "rebase" ]; then echo "REBASE_RAN"; fi') })
    expect(r.code).toBe(5)
    expect(r.out).not.toContain('REBASE_RAN')
    expect(r.out).not.toContain('REACHED_END')
    expect(r.out).toContain('fast-forward nem lehetseges')
  })

  it('with the opt-in on, a failed fetch stops instead of rebasing onto a stale ref', () => {
    const r = run({
      autoRebase: '1',
      gitScript: gitStub(`
if [ "$1" = "fetch" ]; then echo "fetch exploded" >&2; exit 1; fi
if [ "$1" = "rebase" ] || [ "$3" = "rebase" ]; then echo "REBASE_RAN"; fi`),
    })
    expect(r.code).toBe(5)
    expect(r.out).not.toContain('REBASE_RAN')
    expect(r.out).toContain('a fetch elbukott')
  })

  it('with the opt-in on and a clean fetch, the rebase runs and the update continues', () => {
    const r = run({ autoRebase: '1', gitScript: gitStub('') })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Auto-rebase sikeres')
    expect(r.out).toContain('REACHED_END')
  })
})

// UPSTREAMSRC927: the counts used to come from `@{u}`, a LOCAL ref that nothing in
// the product refreshes. These cases use real git against a throwaway bare
// "origin" whose branch has moved on since the install last fetched, so the
// install's remote-tracking ref is stale -- the state every install is in
// between manual fetches.
describe('update.sh divergence guard measures the ref the pull will merge', () => {
  const g = (cwd: string, ...args: string[]) => execFileSync('git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=develop', ...args],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  const commit = (cwd: string, msg: string) => {
    writeFileSync(join(cwd, 'f'), msg + '\n', { flag: 'a' })
    g(cwd, 'add', 'f'); g(cwd, 'commit', '-qm', msg)
  }

  /** origin/develop moved on after the clone; `local` adds commits on the install. */
  function staleInstall(opts: { local: boolean, upstreamMoves: boolean }): string {
    const dir = mkdtempSync(join(tmpdir(), 'update-divref-'))
    g(dir, 'init', '-q', '--bare', 'origin.git')
    g(dir, 'clone', '-q', join(dir, 'origin.git'), 'seed')
    commit(join(dir, 'seed'), 'c1'); g(join(dir, 'seed'), 'push', '-q', 'origin', 'develop')
    g(dir, 'clone', '-q', join(dir, 'origin.git'), 'inst')
    mkdirSync(join(dir, 'inst', 'store'))
    if (opts.local) commit(join(dir, 'inst'), 'local-fix')
    if (opts.upstreamMoves) { commit(join(dir, 'seed'), 'c2'); g(join(dir, 'seed'), 'push', '-q', 'origin', 'develop') }
    return join(dir, 'inst')
  }

  function runReal(inst: string): { code: number, out: string } {
    const script = `
set -u
INSTALL_DIR="${inst}"
CURRENT_BRANCH="develop"
RED=''; NC=''; ORANGE=''; GREEN=''
RESULT_MSG=""
restore_stash_before_exit() { :; }
${extractBlock()}
echo "AHEAD=$AHEAD BEHIND=$BEHIND"
echo "REACHED_END"
`
    try {
      return { code: 0, out: execFileSync('/bin/bash', ['-c', script], { cwd: inst, encoding: 'utf-8', env: { ...process.env, UPDATE_AUTO_REBASE: '' } }) }
    } catch (e) {
      const err = e as { status?: number, stdout?: string }
      return { code: err.status ?? -1, out: err.stdout ?? '' }
    }
  }

  it('control: the install really is stale -- @{u} still says "not behind"', () => {
    const inst = staleInstall({ local: true, upstreamMoves: true })
    expect(g(inst, 'rev-list', '--count', 'HEAD..@{u}').trim()).toBe('0')
  })

  it('a divergence hidden by the stale @{u} is refused with exit 5, before the pull', () => {
    const r = runReal(staleInstall({ local: true, upstreamMoves: true }))
    expect(r.code).toBe(5)
    expect(r.out).toContain('fast-forward nem lehetseges')
    expect(r.out).not.toContain('REACHED_END')
  })

  it('a branch tracking some OTHER ref is still measured against origin/<branch>', () => {
    // The pull names origin/<branch>; `@{u}` is whatever the branch tracks. Here it
    // tracks a second remote frozen at the old commit, so `@{u}` says "not behind"
    // even after the fetch has refreshed origin/develop.
    const inst = staleInstall({ local: true, upstreamMoves: true })
    const frozen = join(inst, '..', 'frozen.git')
    g(join(inst, '..'), 'clone', '-q', '--bare', join(inst, '..', 'origin.git'), 'frozen.git')
    g(join(inst, '..', 'seed'), 'push', '-q', '-f', frozen, 'HEAD~1:develop')
    g(inst, 'remote', 'add', 'frozen', frozen); g(inst, 'fetch', '-q', 'frozen')
    g(inst, 'branch', '-q', '-u', 'frozen/develop')
    expect(g(inst, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('frozen/develop')
    const r = runReal(inst)
    expect(r.code).toBe(5)
    expect(r.out).toContain('fast-forward nem lehetseges')
  })

  it('ahead only is still not a divergence', () => {
    const r = runReal(staleInstall({ local: true, upstreamMoves: false }))
    expect(r.code).toBe(0)
    expect(r.out).toContain('AHEAD=1 BEHIND=0')
  })

  it('a failed fetch is said out loud and falls back to the last known origin ref', () => {
    const inst = staleInstall({ local: true, upstreamMoves: true })
    g(inst, 'remote', 'set-url', 'origin', join(inst, 'no-such-remote.git'))
    const r = runReal(inst)
    expect(r.out).toContain("a 'git fetch origin develop' elbukott")
    expect(r.out).toContain('AHEAD=1 BEHIND=0')
    expect(r.code).toBe(0)
  })
})
