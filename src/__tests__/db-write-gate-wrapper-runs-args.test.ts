// GATEPATHNORM1118 F3 (Dani 81542, his cases7.json): a wrapper whose text this same command writes, with a positional
// parameter in a run position ($1, "$@", ${1}, $* as the command, after exec, eval, a shell, source or ., or as a
// shell's -c code), runs the arguments it is handed; handed the written file, it runs it. The written text names a
// protected install path, so these are denied. A wrapper that only reads or prints its argument, a wrapper handed
// another file, and a wrapper handed a harmless written text still pass. Decisions only; the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, textRunsPositional } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wrapper-args-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const bash = (c: string) => gateDecision('Bash', { command: c.replaceAll('@ROOT@', root).replaceAll('@S@', join(base, 'w')) }, { root, cwd: base })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = "printf 'echo hi > @ROOT@/.claude/settings.json\\n' > @S@/s.sh; "
const HARMLESS = "printf 'echo hi\\n' > @S@/s.sh; "

describe('F3: a wrapper written here that runs its arguments, handed the written file', () => {
  it.each([
    ['printf, exec sh "$@", run by its path', "printf '#!/bin/sh\\nexec sh \"$@\"\\n' > @S@/w; chmod +x @S@/w; @S@/w @S@/s.sh"],
    ['heredoc, sh "$1"', "cat > @S@/w2 <<'EOF'\n#!/bin/sh\nsh \"$1\"\nEOF\nchmod +x @S@/w2; @S@/w2 @S@/s.sh"],
    ['echo, . "$1", run by sh', "echo '. \"$1\"' > @S@/w3.sh; sh @S@/w3.sh @S@/s.sh"],
    ['printf, bash $1, run by bash', "printf 'bash $1' > @S@/w4.sh; bash @S@/w4.sh @S@/s.sh"],
    ['${1} as the command', "printf '\"${1}\"\\n' > @S@/w5; chmod +x @S@/w5; @S@/w5 @S@/s.sh"],
    ['eval of "$@"', "printf 'eval \"$@\"\\n' > @S@/w6.sh; sh @S@/w6.sh @S@/s.sh"],
    ['bash -c "$1"', "printf 'bash -c \"$1\"\\n' > @S@/w7.sh; sh @S@/w7.sh @S@/s.sh"],
    ['source $1 after a then', "printf 'if true; then source $1; fi\\n' > @S@/w8.sh; bash @S@/w8.sh @S@/s.sh"],
    ['$* after exec', "printf 'exec $*\\n' > @S@/w9; chmod +x @S@/w9; @S@/w9 @S@/s.sh"],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it.each([
    ['a wrapper that counts its argument\'s lines', "printf '#!/bin/sh\\nwc -l \"$1\"\\n' > @S@/r; chmod +x @S@/r; @S@/r @S@/s.sh"],
    ['a wrapper that prints or greps its argument', "printf 'echo \"$1\"; grep -c x \"$1\"\\n' > @S@/r2.sh; sh @S@/r2.sh @S@/s.sh"],
    ['a running wrapper handed another file', "printf 'exec sh \"$@\"\\n' > @S@/w; chmod +x @S@/w; printf 'echo ok\\n' > @S@/other.sh; @S@/w @S@/other.sh"],
  ])('the protected text, %s: passes', (_, tail) => { expect(bash(WRITE + tail)).toEqual(ALLOW) })
  it('a harmless written text handed to a running wrapper: passes', () => {
    expect(bash(HARMLESS + "printf 'exec sh \"$@\"\\n' > @S@/w; chmod +x @S@/w; @S@/w @S@/s.sh")).toEqual(ALLOW)
  })
})

describe('F3: a wrapper that runs the file with a shell is judged as running it with sh directly', () => {
  // a text that names only the install root on the way (an ancestor), and writes nothing protected: `sh s.sh` passes it
  const ANCESTOR = "printf 'cd @ROOT@ && ls\\n' > @S@/s.sh; "
  it('direct sh, and a wrapper that sources or sh-runs its argument: all pass alike', () => {
    expect(bash(ANCESTOR + 'sh @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + "printf '. \"$1\"\\n' > @S@/w.sh; sh @S@/w.sh @S@/s.sh")).toEqual(ALLOW)
    expect(bash(ANCESTOR + "printf '#!/bin/sh\\nexec sh \"$@\"\\n' > @S@/w2; chmod +x @S@/w2; @S@/w2 @S@/s.sh")).toEqual(ALLOW)
  })
  it('a wrapper that hands it to a shell\'s -c, or one with another interpreter\'s shebang, is not a shell run: denied', () => {
    expect(bash(ANCESTOR + "printf 'bash -c \"$1\"\\n' > @S@/w3.sh; sh @S@/w3.sh @S@/s.sh")).toEqual(DENY)
    expect(bash(ANCESTOR + "printf '#!/usr/bin/perl\\nexec sh \"$@\"\\n' > @S@/w4; chmod +x @S@/w4; @S@/w4 @S@/s.sh")).toEqual(DENY)
  })
})

describe('textRunsPositional', () => {
  it.each([
    ['sh "$1"', true], ['exec sh "$@"', true], ['. "$1"', true], ['bash $1', true], ['"${1}"', true], ['eval "$@"', true],
    ['bash -c "$1"', true], ['if x; then source $1; fi', true], ['exec $*', true], ['zsh -e "$2"', true],
    ['wc -l "$1"', false], ['echo "$1"', false], ['cat $1 | head', false], ['grep -c x "$1"', false], ['X=$1', false],
  ])('%j -> %s', (text, want) => { expect(textRunsPositional(text)).toBe(want) })
})
