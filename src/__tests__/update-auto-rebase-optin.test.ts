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
  const start = UPDATE_SH.indexOf("BEHIND=$(git rev-list --count 'HEAD..@{u}'")
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
