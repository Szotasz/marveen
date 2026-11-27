// A shell option that takes a value takes it wherever it stands in a cluster, and after the long options
// that take one. Measured with bash, sh and zsh on 2026-11-27: `bash -eo pipefail -c '...'`,
// `bash -oc pipefail '...'` and `bash --rcfile /dev/null -c '...'` all run the -c string.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify, shellOptionValues } from '../../scripts/hooks/bash-egress-parser.mjs'

const U = 'https://example.org/a'
const L = 'http://localhost:3420/api/kanban'

describe('shell option values are skipped like the shell skips them', () => {
  it('counts one value per o / O in a cluster and one after --rcfile / --init-file / --emulate', () => {
    expect(shellOptionValues('-o')).toBe(1)
    expect(shellOptionValues('+o')).toBe(1)
    expect(shellOptionValues('-eo')).toBe(1)
    expect(shellOptionValues('-oe')).toBe(1)
    expect(shellOptionValues('-euo')).toBe(1)
    expect(shellOptionValues('-oO')).toBe(2)
    expect(shellOptionValues('-ec')).toBe(0)
    expect(shellOptionValues('--rcfile')).toBe(1)
    expect(shellOptionValues('--init-file')).toBe(1)
    expect(shellOptionValues('--emulate')).toBe(1)
    expect(shellOptionValues('--rcfile=/dev/null')).toBe(0)
    expect(shellOptionValues('--norc')).toBe(0)
  })
  it('zsh and ksh take the rest of the word as the option name: only a word-final o / O takes the next word', () => {
    for (const sh of ['zsh', 'ksh', '/bin/zsh']) {
      expect(shellOptionValues('-o', sh)).toBe(1)
      expect(shellOptionValues('-eo', sh)).toBe(1)
      expect(shellOptionValues('-oerrexit', sh)).toBe(0)
      expect(shellOptionValues('-eoerrexit', sh)).toBe(0)
      expect(shellOptionValues('+oerrexit', sh)).toBe(0)
      expect(shellOptionValues('-oO', sh)).toBe(0)
    }
    expect(shellOptionValues('-oerrexit', 'bash')).toBe(1)
    expect(shellOptionValues('-oerrexit', 'dash')).toBe(1)
  })
  it('reads the -c string after a zsh / ksh option named in the same word (Dani, #3182 review)', () => {
    for (const c of [
      `zsh -oerrexit -c 'curl -s ${U}'`,
      `zsh -eoerrexit -c 'curl -s ${U}'`,
      `ksh -oerrexit -c 'curl -s ${U}'`,
      `zsh -eo errexit -c 'curl -s ${U}'`,
      `/bin/zsh -oerrexit -c 'curl -s ${U}'`,
    ]) {
      const r = classify(c)
      expect(r.deny, c).toBe(true)
      expect(r.hosts, c).toEqual(['example.org'])
    }
    expect(classify(`echo 'curl -s ${U}' | zsh -oerrexit`).deny).toBe(true)
    expect(classify(`zsh -oerrexit <(echo x)`).reason).toBe('shell-substitution')
    expect(classify(`zsh -oerrexit -c 'curl -s ${L}'`).deny).toBe(false)
    // the word after -oerrexit is zsh's script file, not the option's value: stdin is data, not the program
    expect(classify(`echo 'curl -s ${U}' | zsh -oerrexit run.sh`).deny).toBe(false)
    expect(classify(`echo 'curl -s ${U}' | bash -o errexit run.sh`).deny).toBe(false)
  })
  it('reads the -c string behind an option value wherever the value-taking letter stands', () => {
    for (const c of [
      `bash -eo pipefail -c 'curl -s ${U}'`,
      `bash -oe pipefail -c 'curl -s ${U}'`,
      `bash -euo pipefail -c 'curl -s ${U}'`,
      `bash -oc pipefail 'curl -s ${U}'`,
      `bash -eO extglob -c 'curl -s ${U}'`,
      `bash -oO pipefail extglob -c 'curl -s ${U}'`,
      `bash --rcfile /dev/null -c 'curl -s ${U}'`,
      `bash --init-file /dev/null -c 'curl -s ${U}'`,
      `zsh --emulate sh -c 'curl -s ${U}'`,
      `sh -eo pipefail -c 'curl -s ${U}'`,
    ]) {
      const r = classify(c)
      expect(r.deny, c).toBe(true)
      expect(r.hosts, c).toEqual(['example.org'])
    }
  })
  it('an option value is not a script operand: a shell fed curl through a pipe still reads stdin', () => {
    expect(classify(`echo 'curl -s ${U}' | bash -eo pipefail`).deny).toBe(true)
    expect(classify(`echo 'curl -s ${U}' | bash --rcfile /dev/null`).deny).toBe(true)
  })
  it('an option value is not the program file: a substitution behind it is still the program', () => {
    for (const c of [`bash -eo pipefail <(echo x)`, `bash --rcfile /dev/null <(echo x)`, `bash -o pipefail <(echo x)`]) {
      const r = classify(c)
      expect(r.deny, c).toBe(true)
      expect(r.reason, c).toBe('shell-substitution')
    }
  })
  it('passes the same shapes toward localhost', () => {
    expect(classify(`bash -eo pipefail -c 'curl -s ${L}'`).deny).toBe(false)
    expect(classify(`bash --rcfile /dev/null -c 'curl -s ${L}'`).deny).toBe(false)
    expect(classify(`bash -euo pipefail -c 'echo ok'`).deny).toBe(false)
  })
})
