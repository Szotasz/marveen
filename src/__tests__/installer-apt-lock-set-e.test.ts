import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
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

// Whole-file scan for the idiom, in BOTH shapes it appears in:
//   same line:  x=$(cmd); rc=$?
//   next line:  x=$(cmd)
//               rc=$?
// The second shape is not hypothetical: the installer's claude probe used it,
// and the released script had to be fixed there separately. A test that only
// looked for the same-line form would have called that file clean.
const SAME_LINE = /^\s*(?:local\s+)?\w+=\$\(.+\)\s*;\s*\w+=\$\?/
const BARE_ASSIGN = /^\s*(?:local\s+)?\w+=\$\(.+\)\s*$/
const RC_CAPTURE = /^\s*(?:local\s+)?\w+=\$\?/

/** Next line that carries code: blanks and comments do not break the pair. */
function nextCodeLine(lines: string[], from: number): string {
  for (let i = from; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim()
    if (t !== '' && !t.startsWith('#')) return lines[i] as string
  }
  return ''
}

function findUnguardedCaptures(src: string): string[] {
  const lines = src.split('\n')
  const hits: string[] = []
  lines.forEach((line, i) => {
    if (SAME_LINE.test(line)) hits.push(`${i + 1}: ${line.trim()}`)
    else if (BARE_ASSIGN.test(line) && RC_CAPTURE.test(nextCodeLine(lines, i + 1))) {
      hits.push(`${i + 1}: ${line.trim()}`)
    }
  })
  return hits
}

describe('the assignment idiom that caused it', () => {
  it('appears nowhere in install-linux.sh, in either shape', () => {
    const hits = findUnguardedCaptures(LINUX)
    expect(hits, `unguarded capture(s) under set -e:\n${hits.join('\n')}`).toHaveLength(0)
  })

  it('appears nowhere in the other install scripts either', () => {
    for (const name of ['install-macos.sh', 'install-lang.sh', 'install.sh', 'update.sh']) {
      const path = join(ROOT, name)
      if (!existsSync(path)) continue
      const hits = findUnguardedCaptures(readFileSync(path, 'utf-8'))
      expect(hits, `${name}:\n${hits.join('\n')}`).toHaveLength(0)
    }
  })

  it('the scanner really does detect BOTH broken shapes (instrument control)', () => {
    // Zeros above are only evidence if the scanner can find a positive. Both
    // shapes are checked, because the next-line one is the easier to miss.
    expect(findUnguardedCaptures('  holder=$(apt_lock_holder); rc=$?')).toHaveLength(1)
    expect(findUnguardedCaptures('OUT=$(claude --print "ping" 2>&1)\nEXIT=$?')).toHaveLength(1)
    // A comment or a blank line between the two must not hide the pair: that is
    // how the shape would slip back in after someone documents it.
    expect(findUnguardedCaptures('OUT=$(cmd)\n# why we capture it\nEXIT=$?')).toHaveLength(1)
    expect(findUnguardedCaptures('OUT=$(cmd)\n\nEXIT=$?')).toHaveLength(1)
    // And it must NOT flag the guarded form we replaced them with.
    expect(findUnguardedCaptures('  holder=$(apt_lock_holder) && rc=0 || rc=$?')).toHaveLength(0)
    expect(findUnguardedCaptures('OUT=$(claude --print "ping" 2>&1) && E=0 || E=$?')).toHaveLength(0)
  })
})
