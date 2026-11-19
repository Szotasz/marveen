// GATEPATHNORM1118 F6 (Dani 81908, his cases10.json): forms the develop still let through, none a regression of F5.
// A braced positional's modifier may nest to any depth (${1:-${2:-${3}}}): the text is read with every balanced
// ${N...} taken as ${N}. A function chain has no depth ceiling: a function runs what every function it reaches through
// positional calls runs. bash's --rcfile / --init-file take an argument, so the next word is the script; the named rc
// file is a run too (an interactive shell runs it). Decisions only; the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, textRunsPositional } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-f6-')))
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
const chain = (n: number) => {
  let t = `f${n}() { "$@"; }; `
  for (let i = n - 1; i >= 1; i--) t += `f${i}() { f${i + 1} "$@"; }; `
  return t + 'f1 sh @S@/s.sh'
}

describe('F6: a positional nested to any depth', () => {
  it.each([
    ['sh "${1:-${2:-${3}}}"', "printf '#!/bin/sh\\nsh \"${1:-${2:-${3}}}\"\\n' > @S@/w1; chmod +x @S@/w1; @S@/w1 @S@/s.sh"],
    ['f() { sh "${1:-${2:-${3:-${4}}}}"; }', 'f() { sh "${1:-${2:-${3:-${4}}}}"; }; f @S@/s.sh'],
    ['f() { "${@:-${X:-${Y}}}"; }', 'f() { "${@:-${X:-${Y}}}"; }; f sh @S@/s.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it('a chain that hands on a deeply nested positional: denied (mutant N2)', () => {
    expect(bash(WRITE + 'g() { "$@"; }; f() { g "${@:-${X:-${Y}}}"; }; f sh @S@/s.sh')).toEqual(DENY)
  })
  it('a text that only passes the install root, run by a nested positional, passes as `sh FILE` does (mutants N2, N3)', () => {
    expect(bash(ANCESTOR + 'f() { sh "${1:-${2:-${3}}}"; }; f @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + "printf '#!/bin/sh\\nsh \"${1:-${2:-${3}}}\"\\n' > @S@/w5; chmod +x @S@/w5; @S@/w5 @S@/s.sh")).toEqual(ALLOW)
  })
})

describe('F6: a function chain of any length', () => {
  it.each([[5], [6], [12]])('a chain of %i is denied', (n) => { expect(bash(WRITE + chain(n))).toEqual(DENY) })
  it('a chain of 12 that only prints at its end: passes', () => {
    expect(bash(WRITE + chain(12).replace('f12() { "$@"; }', 'f12() { echo "$@"; }'))).toEqual(ALLOW)
  })
  it('a cycle (f calls g, g calls f) that runs its argument: denied, and it ends', () => {
    expect(bash(WRITE + 'f() { g "$@"; }; g() { f "$@"; sh "$1"; }; f @S@/s.sh')).toEqual(DENY)
  })
  it('a chain of 12 handed `sh FILE` with a text that only passes the install root passes, as `sh FILE` directly', () => {
    expect(bash(ANCESTOR + chain(12))).toEqual(ALLOW)
  })
})

describe('F6: bash --rcfile / --init-file', () => {
  it.each([
    ['bash --rcfile RC FILE', "printf 'true\\n' > @S@/rc; bash --rcfile @S@/rc @S@/s.sh"],
    ['bash --init-file RC FILE', "printf 'true\\n' > @S@/rc; bash --init-file @S@/rc @S@/s.sh"],
    ['bash --rcfile=RC FILE', "printf 'true\\n' > @S@/rc; bash --rcfile=@S@/rc @S@/s.sh"],
    ['the written file as the rc file', 'bash --rcfile @S@/s.sh -i'],
    ['the written file as the init file of an interactive shell', 'bash --init-file @S@/s.sh'],
    ['the written file as --rcfile=FILE of an interactive shell', 'bash --rcfile=@S@/s.sh -i'],
    ['a wrapper running bash --rcfile RC "$1"', "printf '#!/bin/sh\\nbash --rcfile /dev/null \"$1\"\\n' > @S@/w2; chmod +x @S@/w2; @S@/w2 @S@/s.sh"],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it('another file run the same way: passes', () => {
    expect(bash(WRITE + "printf 'echo ok\\n' > @S@/o.sh; bash --rcfile /dev/null @S@/o.sh")).toEqual(ALLOW)
  })
  it('a text that only passes the install root: `bash --rcfile RC FILE` passes as `bash FILE` does', () => {
    expect(bash(ANCESTOR + 'bash @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + 'bash --rcfile /dev/null @S@/s.sh')).toEqual(ALLOW)
  })
})

describe('textRunsPositional, F6 forms', () => {
  it.each([
    ['sh "${1:-${2:-${3}}}"', true], ['sh "${1:-${2:-${3:-${4:-${5}}}}}"', true], ['"${@:-${X:-${Y}}}"', true],
    ['bash --rcfile /dev/null "$1"', true], ['bash --init-file=/dev/null "$1"', true], ['bash --norc "$1"', true],
    ['echo "${1:-${2:-${3}}}"', false], ['sh "${#1}"', false], ['sh "${1:-${2:-${3}}}x"', false],
  ])('%j -> %s', (text, want) => { expect(textRunsPositional(text)).toBe(want) })
})
