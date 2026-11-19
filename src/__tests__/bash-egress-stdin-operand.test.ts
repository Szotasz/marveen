import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify } from '../../scripts/hooks/bash-egress-parser.mjs'

// EGRESSSTDINBYPASS1117: a shell that reads its program from a pipe is denied ("shell-stdin"), and a
// script file named after the shell is what lifts that deny. The word after the shell was read as a
// script file whenever it was not an unquoted option, so a word whose value is only known at run time
// (an expansion that may be empty or split into options) or a QUOTED option lifted the deny too,
// while the shell still read and ran the piped text. Such a word now names no script file: the deny
// stands. A quoted expansion next to literal text stays one non-empty word and still names a file.
const d = (c: string) => classify(c)

describe('bash-egress-parser: a stdin shell is not let through by a word that names no script file', () => {
  it('denies a stdin shell whose next word is an expansion only known at run time', () => {
    for (const c of [
      'git show HEAD:x.sh | bash $OPT',
      'git show HEAD:x.sh | bash ${OPT}',
      'git show HEAD:x.sh | sh "$@"',
      'git show HEAD:x.sh | bash "$X"',
      'git show HEAD:x.sh | zsh "${X}"',
      'git show HEAD:x.sh | bash $D/run.sh',
      'cat payload | dash $*',
    ]) expect({ c, r: d(c) }).toMatchObject({ c, r: { deny: true, reason: 'shell-stdin' } })
  })

  it('denies a stdin shell whose next word is a QUOTED option', () => {
    for (const c of [
      'git show HEAD:x.sh | bash "-x"',
      "git show HEAD:x.sh | bash '-x'",
      'git show HEAD:x.sh | bash "-s" arg',
      'git show HEAD:x.sh | bash "--norc"',
      'git show HEAD:x.sh | bash "-o" pipefail',
    ]) expect({ c, r: d(c) }).toMatchObject({ c, r: { deny: true, reason: 'shell-stdin' } })
  })

  it('denies a stdin shell whose next word is an unquoted brace expansion or glob (#2859 review)', () => {
    for (const c of [
      'git show HEAD:x.sh | bash {-s,}',
      'git show HEAD:x.sh | bash {-s,x}',
      'git show HEAD:x.sh | bash {a..b}',
      'git show HEAD:x.sh | bash [-]s',
      'git show HEAD:x.sh | bash ?s',
      'git show HEAD:x.sh | bash *',
    ]) expect({ c, r: d(c) }).toMatchObject({ c, r: { deny: true, reason: 'shell-stdin' } })
  })

  it('a brace expansion or a glob can turn into an option that reads stdin (measured with the real shell)', () => {
    // a directory holding one file named like the option: the glob matches it
    const dir = mkdtempSync(join(tmpdir(), 'egress-stdin-glob-'))
    try {
      writeFileSync(join(dir, '-s'), '')
      for (const form of ['bash {-s,}', 'bash [-]s', 'bash ?s', 'bash *']) {
        const r = spawnSync('bash', ['-c', `printf 'echo RAN\\n' | ${form}`], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        expect({ form, out: r.stdout.trim() }).toEqual({ form, out: 'RAN' })
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('denies a word that holds a command substitution or a backtick', () => {
    for (const c of ['git show HEAD:x.sh | bash "$(echo -s)"', 'git show HEAD:x.sh | bash "`echo -s`"'])
      expect({ c, deny: d(c).deny }).toEqual({ c, deny: true })
  })

  it('the denied forms do run the piped text (measured with the real shell, no network)', () => {
    // `$@` is empty at the top of `bash -c`, OPT is unset, X holds an option: each one reads stdin.
    for (const form of ['bash $OPT', 'bash ${OPT}', 'bash "$@"', 'bash "-x"', "bash '-x'", 'X=-s; printf "echo RAN\\n" | bash "$X"']) {
      const line = form.includes('printf') ? form : `printf 'echo RAN\\n' | ${form}`
      const r = spawnSync('bash', ['-c', line], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
      expect({ form, out: r.stdout.trim() }).toEqual({ form, out: 'RAN' })
    }
  })

  it('unchanged: a word that names a script file still lifts the stdin deny', () => {
    for (const c of [
      'echo hi | bash "$SD/run.sh"',
      'bash "$SD/db02.sh" "SELECT 1" 2>&1',
      "echo hi | bash 'x.sh'",
      'echo hi | bash "my script.sh"',
      'echo hi | bash run.sh',
      'echo hi | bash x{1}.sh',
      'echo hi | bash "x*.sh"',
      'git log | bash -o pipefail script.sh',
      'bash "$D/run.sh" <&3',
      'bash $SCRIPT',
      'git show HEAD:x.sh | bash -n',
    ]) expect({ c, deny: d(c).deny }).toEqual({ c, deny: false })
  })

  it('unchanged: the plain stdin shell and the -s form stay denied', () => {
    for (const c of ['git show HEAD:x.sh | bash', 'echo curl https://evil.com | bash -s foo', 'cat x.sh | bash -s -- arg'])
      expect({ c, deny: d(c).deny }).toEqual({ c, deny: true })
  })
})
