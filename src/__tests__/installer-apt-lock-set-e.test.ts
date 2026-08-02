import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The 2026-08-02 bug: a brand new VPS died at `set_step "prerequisites"` with
// exit 1, right after printing "Telepites sudo-val (apt)...". Root cause, proved
// on a live host: the script runs under `set -e` (line 5), and the exit status of
// an ASSIGNMENT is the status of its command substitution. So
//
//     holder=$(apt_lock_holder); rc=$?
//
// exits the whole script on that line whenever apt_lock_holder returns non-zero
// -- and it returns non-zero exactly when there is NO lock (1) or fuser is
// missing (2). The three-state logic underneath therefore never ran: the only
// surviving branch was "somebody really is holding the lock". The lock guard
// killed the install on QUIET machines and waved it through on contended ones,
// which is why it passed the 07-30 workshop and failed on a fresh VPS.
//
// These tests execute the real function out of the shipped script rather than
// re-describing it, because the bug was invisible at the level of reading.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

/** Pull one shell function out of a script so it can be executed for real. */
function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let i = src.indexOf('{', start) + 1
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i)
}

/**
 * Run the REAL wait_for_apt_lock under `set -e` with apt_lock_holder stubbed to
 * a chosen exit code. Returns the script's exit status and stdout.
 */
function runWaitForAptLock(holderRc: number, holderOut = ''): { code: number; out: string } {
  const fn = sliceShellFn(LINUX, 'wait_for_apt_lock')
  const script = [
    'set -e',
    // Minimal environment the function touches. Nothing here decides the
    // outcome; the stub's exit code does.
    'DIM=""; NC=""; RED=""',
    '_t() { echo "$1"; }',
    'warn() { echo "warn: $*"; }',
    'ok() { echo "ok: $*"; }',
    'fail() { echo "fail: $*"; exit 9; }',
    'APT_LOCK_WAIT_CAP=0',
    `apt_lock_holder() { ${holderOut ? `echo "${holderOut}";` : ''} return ${holderRc}; }`,
    fn,
    'echo BEFORE',
    'wait_for_apt_lock',
    'echo REACHED_THE_END',
  ].join('\n')
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string }
    return { code: e.status ?? -1, out: e.stdout ?? '' }
  }
}

describe('wait_for_apt_lock under set -e', () => {
  it('does NOT kill the install when there is no apt lock (the 08-02 regression)', () => {
    const r = runWaitForAptLock(1)
    expect(r.out).toContain('BEFORE')
    expect(r.out).toContain('REACHED_THE_END')
    expect(r.code).toBe(0)
  })

  it('does NOT kill the install when fuser is missing', () => {
    const r = runWaitForAptLock(2)
    expect(r.out).toContain('REACHED_THE_END')
    expect(r.code).toBe(0)
  })

  it('still detects a real lock holder (positive control)', () => {
    // Without this the two results above could pass simply because the guard
    // never does anything at all. APT_LOCK_WAIT_CAP=0 makes the wait loop
    // terminate immediately, so a held lock reaches the named timeout failure.
    const r = runWaitForAptLock(0, '4242 apt-get')
    expect(r.out).toContain('4242 apt-get')
    expect(r.out).not.toContain('REACHED_THE_END')
    expect(r.code).toBe(9)
  })
})

describe('the assignment idiom that caused it', () => {
  it('is gone from install-linux.sh', () => {
    // `x=$(...)` followed by `rc=$?` on the same line: the author expected
    // execution to continue, which under set -e it does not.
    const hits = LINUX.split('\n').filter((l) => /^\s*(?:local\s+)?\w+=\$\(.+\)\s*;\s*\w+=\$\?/.test(l))
    expect(hits, `still present: ${hits.join(' | ')}`).toHaveLength(0)
  })

  it('the matcher really does find the broken form (instrument control)', () => {
    // A zero above is only evidence if this pattern can detect a positive.
    const broken = '  holder=$(apt_lock_holder); rc=$?'
    expect(/^\s*(?:local\s+)?\w+=\$\(.+\)\s*;\s*\w+=\$\?/.test(broken)).toBe(true)
  })
})
