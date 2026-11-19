// GATEPATHNORM1118 F4 (Dani 81744, his cases8.json): more forms of a wrapper that runs what it is handed. A braced
// positional with a modifier (${1:-x}, ${1-x}, ${@}, ${1#p}) is the parameter; a shell function the command defines
// (f() { "$@"; }, function g { sh "$1"; }) is a wrapper whose text is its body. A wrapper that runs "$@" as the command,
// handed `sh FILE`, runs FILE with a shell, judged as `sh FILE` directly. ${#1} (a length) and a function that only
// reads its argument stay data. Decisions only; the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, textRunsPositional } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wrapper-forms-')))
  root = join(base, 'Install')
  for (const d of ['.claude', 'scripts/hooks', 'store']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const bash = (c: string) => gateDecision('Bash', { command: c.replaceAll('@ROOT@', root).replaceAll('@S@', join(base, 'w')) }, { root, cwd: base })
const DENY = { deny: true, reason: 'install-file' }
const ALLOW = { deny: false }
const WRITE = "printf 'echo hi > @ROOT@/.claude/settings.json\\n' > @S@/s.sh; "
const ANCESTOR = "printf 'cd @ROOT@ && ls\\n' > @S@/s.sh; "

describe('F4: braced positional forms', () => {
  it.each([
    ['sh "${1:-x}"', "printf 'sh \"${1:-x}\"\\n' > @S@/w1; chmod +x @S@/w1; @S@/w1 @S@/s.sh"],
    ['sh ${1-x}', "printf 'sh ${1-x}\\n' > @S@/w2; chmod +x @S@/w2; @S@/w2 @S@/s.sh"],
    ['exec sh "${@}"', "printf 'exec sh \"${@}\"\\n' > @S@/w3; chmod +x @S@/w3; @S@/w3 @S@/s.sh"],
    ['. "${1#./}"', "printf '. \"${1#./}\"\\n' > @S@/w4.sh; sh @S@/w4.sh @S@/s.sh"],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
})

describe('F4: a shell function the command defines is a wrapper', () => {
  it.each([
    ['f() { "$@"; }; f sh FILE', 'f() { "$@"; }; f sh @S@/s.sh'],
    ['function g { sh "$1"; }; g FILE', 'function g { sh "$1"; }; g @S@/s.sh'],
    ['h() { exec bash "${1:-x}"; }; h FILE', 'h() { exec bash "${1:-x}"; }; h @S@/s.sh'],
    // the function keyword form, read as a wrapper too (mutant K7)
    ['function k { "$@"; }; k sh FILE', 'function k { "$@"; }; k sh @S@/s.sh'],
    ['function k() { "$@"; }; k sh FILE', 'function k() { "$@"; }; k sh @S@/s.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it('a function body whose first line looks like a shebang is no shebang (zsh runs `f() {#!/usr/bin/python` as a comment): still a shell run (mutant K6)', () => {
    const fn = 'f() {#!/usr/bin/python\nsh "$1"\n}\nf @S@/s.sh'
    expect(bash(WRITE + fn)).toEqual(DENY)
    // a shell run of a text that only passes the install root is judged as `sh FILE` directly
    expect(bash(ANCESTOR + fn)).toEqual(ALLOW)
  })
  it('a function that only reads or prints its argument: passes', () => {
    expect(bash(WRITE + 'r() { wc -l "$1"; echo "$1"; }; r @S@/s.sh')).toEqual(ALLOW)
  })
  it('a running function handed another file: passes', () => {
    expect(bash(WRITE + "printf 'echo ok\\n' > @S@/o.sh; f() { \"$@\"; }; f sh @S@/o.sh")).toEqual(ALLOW)
  })
})

describe('F4: "$@" handed `sh FILE` is a shell run, judged as `sh FILE` directly', () => {
  it('a text that only passes the install root: direct sh, a "$@" function and a "$@" wrapper file all pass', () => {
    expect(bash(ANCESTOR + 'sh @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + 'f() { "$@"; }; f sh @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + 'function f { "$@"; }; f sh @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + "printf 'exec \"$@\"\\n' > @S@/w; chmod +x @S@/w; @S@/w sh @S@/s.sh")).toEqual(ALLOW)
  })
  it('the same handed `sh -c FILE`: not a shell run of the file, denied (as sh -c directly)', () => {
    expect(bash(ANCESTOR + 'f() { "$@"; }; f sh -c @S@/s.sh')).toEqual(DENY)
  })
})

describe('textRunsPositional, F4 forms', () => {
  it.each([
    ['sh "${1:-x}"', true], ['sh ${1-x}', true], ['exec sh "${@}"', true], ['. "${1#./}"', true], ['"$@"', true], ['"${@}"; ', true],
    ['echo "${#1}"', false], ['sh "${#1}"', false], ['wc -l "${1:-x}"', false],
  ])('%j -> %s', (text, want) => { expect(textRunsPositional(text)).toBe(want) })
})
