import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// UPDOOMNPMCI926: on a 3.8 GB swapless host the OOM killer ended `npm ci` three
// times in 33 s (exit 137). update.sh then printed a fixed "package-lock.json is
// out of sync" line, exited 1 with NO rollback, and left the tree on the new
// commit with the half-installed node_modules npm ci leaves behind, while the
// result file said "failed". These tests RUN the real retry(), npm_ci_failed()
// and restore_stash_before_exit() text from update.sh, plus the real call-site
// block, with npm and git stubbed.

const UPDATE = readFileSync(join(__dirname, '..', '..', 'update.sh'), 'utf-8')
const SANDBOX = mkdtempSync(join(tmpdir(), 'upd-npmci-'))
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

function fn(name: string): string {
  const m = UPDATE.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'))
  expect(m, `${name}() not found in update.sh`).not.toBeNull()
  return m![0]
}

// The real call site: from NPM_CI_RC=0 through the fi that closes the handler call.
function callSite(): string {
  const start = UPDATE.indexOf('  NPM_CI_RC=0\n')
  expect(start, 'npm ci call site not found').toBeGreaterThan(-1)
  const end = UPDATE.indexOf('\n  fi\n', start)
  return UPDATE.slice(start, end + '\n  fi\n'.length)
}

interface Run { code: number; out: string; status: string; msg: string; gitLog: string }

function run(opts: { ciRc: number; rollbackCiRc?: number; stashed?: boolean; viaCallSite?: boolean }): Run {
  const dir = mkdtempSync(join(SANDBOX, 'run-'))
  mkdirSync(join(dir, 'dist'))
  const script = [
    'set -e',
    `INSTALL_DIR='${dir}'`,
    `BUILT_COMMIT_FILE='${dir}/dist/.built-commit'`,
    "RED=''; NC=''; DIM=''",
    'OLD_VERSION=abc1234; OLD_VERSION_FULL=abc1234fullsha',
    `STASHED_AUTO=${opts.stashed ? 1 : 0}`,
    'RESULT_STATUS=failed; RESULT_MSG=""',
    `trap 'printf "%s" "$RESULT_STATUS" > "${dir}/status"; printf "%s" "$RESULT_MSG" > "${dir}/msg"' EXIT`,
    `git() { echo "git $*" >> '${dir}/git.log'; return 0; }`,
    // First `npm ci` calls (the update's own, under retry) fail with ciRc; once
    // git reset --hard has run, `npm ci` is the rollback's and uses rollbackCiRc.
    `npm() { if [ "$1" = ci ]; then if grep -q 'reset --hard' '${dir}/git.log' 2>/dev/null; then return ${opts.rollbackCiRc ?? 0}; fi; return ${opts.ciRc}; fi; return 0; }`,
    'sleep() { :; }',
    fn('retry'),
    fn('restore_stash_before_exit'),
    fn('npm_ci_failed'),
    opts.viaCallSite ? callSite() : `npm_ci_failed ${opts.ciRc}`,
    'echo UNREACHED',
  ].join('\n')
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' })
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf-8') : '')
  return { code: r.status ?? -1, out: r.stdout + r.stderr, status: read('status'), msg: read('msg'), gitLog: read('git.log') }
}

describe('update.sh: a failed npm ci (UPDOOMNPMCI926)', () => {
  it('retry() returns the last attempt\'s exit code, not a flat 1', () => {
    const r = spawnSync('bash', ['-c', [fn('retry'), 'sleep() { :; }', 'f() { return 137; }', 'retry 3 0 f; echo "rc=$?"'].join('\n')], { encoding: 'utf-8' })
    expect(r.stdout).toContain('rc=137')
  })

  it('an OOM kill (137) is named as memory, not as a lockfile problem, and rolls back', () => {
    const r = run({ ciRc: 137 })
    expect(r.code).toBe(6)
    expect(r.out).not.toContain('UNREACHED')
    expect(r.out).toContain('137')
    expect(r.out).toContain('memória')
    expect(r.out).toContain('dmesg')
    expect(r.out).not.toMatch(/Valoszinuleg a package-lock/)
    expect(r.gitLog).toContain('reset --hard abc1234fullsha')
    expect(r.status).toBe('rolled-back')
    expect(r.msg).toContain('memóriahiány')
    expect(r.msg).toContain('abc1234')
  })

  it('another exit code is named as it is, without claiming memory', () => {
    const r = run({ ciRc: 1 })
    expect(r.code).toBe(6)
    expect(r.out).toContain('kilépési kód: 1')
    expect(r.out).not.toContain('memória')
    expect(r.status).toBe('rolled-back')
  })

  it('a rollback whose own npm ci fails is reported as failed, with the manual step', () => {
    const r = run({ ciRc: 137, rollbackCiRc: 137 })
    expect(r.code).toBe(6)
    expect(r.status).toBe('failed')
    expect(r.msg).toContain('hiányos')
    expect(r.msg).toContain('npm ci --include=dev')
  })

  it('an auto-stash is restored on this exit too', () => {
    const r = run({ ciRc: 137, stashed: true })
    expect(r.gitLog).toContain('stash pop')
  })

  it('the real call site hands the retry\'s exit code to the handler', () => {
    const r = run({ ciRc: 137, viaCallSite: true })
    expect(r.code).toBe(6)
    expect(r.out).toContain('137')
    expect(r.status).toBe('rolled-back')
    expect(r.gitLog).toContain('reset --hard abc1234fullsha')
  })

  it('the old fixed lockfile message and the bare exit 1 are gone', () => {
    expect(UPDATE).not.toContain('Valoszinuleg a package-lock.json nincs szinkronban')
  })
})
