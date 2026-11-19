// GATEPATHNORM1118 F5 (Dani 81856, his cases9.json): forms the develop still let through, none a regression of F4.
// A braced positional may hold one nested braced expansion (${1:-${2}}) and may be two digits (${10}). A shell function
// the command defines that hands its positional arguments to another defined function runs what that function runs.
// A shell option that takes an argument (-o NAME, +o NAME, -O NAME, +O NAME, also at the end of a flag cluster) is not
// the script word, in a direct shell run and in a wrapper alike. Decisions only; the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, textRunsPositional } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-f5-')))
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

describe('F5: a nested or two-digit braced positional', () => {
  it.each([
    ['sh "${1:-${2}}"', "printf '#!/bin/sh\\nsh \"${1:-${2}}\"\\n' > @S@/w1; chmod +x @S@/w1; @S@/w1 @S@/s.sh"],
    ['sh "${10}"', "printf '#!/bin/sh\\nsh \"${10}\"\\n' > @S@/w2; chmod +x @S@/w2; @S@/w2 a b c d e f g h i @S@/s.sh"],
    ['f() { sh "${1:-${2:-x}}"; }', 'f() { sh "${1:-${2:-x}}"; }; f @S@/s.sh'],
    // a lone brace in the modifier: the F4 reading still applies (mutant P3)
    ['f() { sh "${1#{}"; }', 'f() { sh "${1#{}"; }; f @S@/s.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
})

describe('F5: a function that hands its arguments to another defined function', () => {
  it.each([
    ['g() { "$@"; }; f() { g "$@"; }; f sh FILE', 'g() { "$@"; }; f() { g "$@"; }; f sh @S@/s.sh'],
    ['g() { sh "$1"; }; f() { g "$1"; }; f FILE', 'g() { sh "$1"; }; f() { g "$1"; }; f @S@/s.sh'],
    ['three levels', 'h() { "$@"; }; g() { h "$@"; }; f() { g "$@"; }; f sh @S@/s.sh'],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it('the called function only prints its arguments: passes', () => {
    expect(bash(WRITE + 'g() { echo "$@"; }; f() { g "$@"; }; f sh @S@/s.sh')).toEqual(ALLOW)
  })
  it('the caller hands the called runner no positional argument: passes', () => {
    expect(bash(WRITE + 'g() { "$@"; }; f() { g ls; }; f sh @S@/s.sh')).toEqual(ALLOW)
  })
  it('a function that calls itself is read once (no loop) and still decides', () => {
    expect(bash(WRITE + 'f() { f "$@"; "$@"; }; f sh @S@/s.sh')).toEqual(DENY)
  })
  it('a chain handed `sh FILE` with a text that only passes the install root passes, as `sh FILE` directly', () => {
    expect(bash(ANCESTOR + 'g() { "$@"; }; f() { g "$@"; }; f sh @S@/s.sh')).toEqual(ALLOW)
  })
})

describe('F5: a shell option that takes an argument is not the script word', () => {
  it.each([
    ['sh -o errexit FILE', 'sh -o errexit @S@/s.sh'],
    ['bash +o posix FILE', 'bash +o posix @S@/s.sh'],
    ['bash -O extglob FILE', 'bash -O extglob @S@/s.sh'],
    ['bash -eo pipefail FILE', 'bash -eo pipefail @S@/s.sh'],
    ['a wrapper running sh -o errexit "$1"', "printf '#!/bin/sh\\nsh -o errexit \"$1\"\\n' > @S@/w3; chmod +x @S@/w3; @S@/w3 @S@/s.sh"],
    ['a function running bash -O extglob "$1"', 'f() { bash -O extglob "$1"; }; f @S@/s.sh'],
    ['a written wrapper run as sh -o errexit WRAPPER FILE', "printf '#!/bin/sh\\nsh \"$1\"\\n' > @S@/w4.sh; sh -o errexit @S@/w4.sh @S@/s.sh"],
  ])('%s is denied', (_, tail) => { expect(bash(WRITE + tail)).toEqual(DENY) })
  it('another file run the same way: passes', () => {
    expect(bash(WRITE + "printf 'echo ok\\n' > @S@/o.sh; sh -o errexit @S@/o.sh")).toEqual(ALLOW)
  })
  it('a text that only passes the install root: `sh -o errexit FILE` passes as `sh FILE` does', () => {
    expect(bash(ANCESTOR + 'sh @S@/s.sh')).toEqual(ALLOW)
    expect(bash(ANCESTOR + 'sh -o errexit @S@/s.sh')).toEqual(ALLOW)
  })
})

describe('textRunsPositional, F5 forms', () => {
  it.each([
    ['sh "${1:-${2}}"', true], ['sh "${10}"', true], ['sh ${12:-x}', true], ['sh -o errexit "$1"', true], ['bash +O extglob "$1"', true], ['sh +x "$1"', true],
    ['echo "${10}"', false], ['sh "${0}"', false], ['echo "${1:-${2}}"', false],
    // the old reading stays: a positional right after -o is still read as the script word (no new allow)
    ['sh -o "$1"', true],
  ])('%j -> %s', (text, want) => { expect(textRunsPositional(text)).toBe(want) })
})
