import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, shellWordAt } from '../../scripts/self-pace-gate.mjs'

// eabc253c: the script a shell is handed with -c is ONE shell word, and the gate now reads it
// the way the shell does. Measured 2026-10-04 on the gate with the wrapper reading: `bash -c
// $'crontab -r'` passed, and so did a nested `bash -c '...'` written with either escape form of
// an inner single quote, because only the first quoted part of the word was read. The cases
// below build the words with the generators' quoting, nest them to the gate's depth, and
// check the decoder against bash itself. Commands, units and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const Q = String.fromCharCode(39)
const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)
// the quoting a generator writes for one word
const closeEscQ = (s: string): string => Q + s.split(Q).join(`${Q}${BS}${Q}${Q}`) + Q // 'a'\''b'
const shlexQ = (s: string): string => Q + s.split(Q).join(`${Q}"${Q}"${Q}`) + Q // 'a'"'"'b' (Python shlex.quote)
const ansiQ = (s: string): string => `$${Q}` + s.split(BS).join(BS + BS).split(Q).join(BS + Q) + Q // $'a\'b'
const QUOTINGS: Array<[string, (s: string) => string]> = [
  ['the close-escape-reopen form', closeEscQ],
  ['shlex.quote', shlexQ],
  ['ANSI-C', ansiQ],
]
const nest = (q: (s: string) => string, levels: number, inner: string): string => {
  let c = inner
  for (let k = 0; k < levels; k++) c = `bash -c ${q(c)}`
  return c
}
// what bash itself makes of one word: the known answer for the generators and the decoder
const bashWord = (word: string): string => {
  const r = spawnSync('bash', ['-c', `printf %s ${word}`], { encoding: 'utf-8' })
  expect(r.status, word).toBe(0)
  return r.stdout
}
const SCHEDULERS = [
  'crontab -r',
  'at now',
  'systemd-run --user --on-active=60 /bin/true',
  'systemctl --user enable --now demo-guard.timer',
  'tmux send-keys -t demo go Enter',
]

describe('eabc253c: the escape forms and ANSI-C quoting are read, nested to the gate depth', () => {
  it('the three measured forms', () => {
    // the generators write exactly the measured forms
    expect(nest(ansiQ, 1, 'crontab -r')).toBe(`bash -c $${Q}crontab -r${Q}`)
    expect(nest(closeEscQ, 2, 'crontab -r')).toBe(`bash -c ${Q}bash -c ${Q}${BS}${Q}${Q}crontab -r${Q}${BS}${Q}${Q}${Q}`)
    expect(nest(shlexQ, 2, 'crontab -r')).toBe(`bash -c ${Q}bash -c ${Q}"${Q}"${Q}crontab -r${Q}"${Q}"${Q}${Q}`)
    expect(bash(nest(ansiQ, 1, 'crontab -r'))).toBe(true)
    expect(bash(nest(closeEscQ, 2, 'crontab -r'))).toBe(true)
    expect(bash(nest(shlexQ, 2, 'crontab -r'))).toBe(true)
  })
  it('every quoting, one to three levels, every scheduler at the bottom', () => {
    for (const [name, q] of QUOTINGS) {
      for (let levels = 1; levels <= 3; levels++) {
        for (const inner of SCHEDULERS) {
          expect(bash(nest(q, levels, inner)), `${name} x${levels}: ${inner}`).toBe(true)
        }
      }
    }
  })
  it('the quotings mixed across the levels', () => {
    for (const [a, qa] of QUOTINGS) {
      for (const [b, qb] of QUOTINGS) {
        for (const [c, qc] of QUOTINGS) {
          const cmd = `bash -c ${qa(`bash -c ${qb(`bash -c ${qc('crontab -r')}`)}`)}`
          expect(bash(cmd), `${a} / ${b} / ${c}`).toBe(true)
        }
      }
    }
  })
  it('the other shells, su and flock read the word the same way', () => {
    expect(bash(`sh -c ${ansiQ('crontab -r')}`)).toBe(true)
    expect(bash(`dash -c ${closeEscQ(`bash -c ${shlexQ('at now')}`)}`)).toBe(true)
    expect(bash(`su -c ${shlexQ(`bash -c ${ansiQ('crontab -r')}`)} root`)).toBe(true)
    expect(bash(`flock /tmp/demo.lock -c ${closeEscQ(`sh -c ${closeEscQ('crontab -r')}`)}`)).toBe(true)
  })
})

describe('eabc253c: what stays allowed', () => {
  it('a harmless command or a read behind the same nesting', () => {
    for (const [name, q] of QUOTINGS) {
      for (let levels = 1; levels <= 3; levels++) {
        expect(bash(nest(q, levels, 'echo ok')), `${name} x${levels}`).toBe(false)
      }
      expect(bash(nest(q, 2, 'crontab -l')), name).toBe(false)
    }
  })
  it('prose that quotes the forms: an echo, a commit message, a heredoc body', () => {
    const form = nest(closeEscQ, 2, 'crontab -r')
    expect(bash(`echo ${shlexQ(form)}`)).toBe(false)
    expect(bash(`git commit -m ${shlexQ(`gate: ${form}`)}`)).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}${form}${NL}${nest(ansiQ, 1, 'at now')}${NL}EOF`)).toBe(false)
  })
})

describe('eabc253c: the decoder reads a word as bash reads it', () => {
  it('the generators write words bash reads back as the original text', () => {
    for (const [name, q] of QUOTINGS) {
      for (const s of ['crontab -r', `a${Q}b`, `${Q}${Q}x${Q}`, `back${BS}slash`, `two  spaces and "dq"`, `$HOME and $(date)`]) {
        expect(bashWord(q(s)), `${name}: ${s}`).toBe(s)
      }
    }
  })
  it('shellWordAt gives what bash gives, for words built from every kind of part', () => {
    const words = [
      `${Q}a${Q}${BS}${Q}${Q}b${Q}`,
      `${Q}a${Q}"${Q}"${Q}b${Q}`,
      `$${Q}${BS}x41${BS}101${BS}u0042${BS}t${BS}${Q}${BS}${BS}${Q}`,
      `$${Q}${BS}q${BS}8${BS}x${Q}`,
      `"a${BS}"b${BS}$c${BS}d${BS}${BS}"`,
      `a${BS} b${BS}${Q}c`,
      `${Q}x${Q}"y"$${Q}z${Q}w`,
      `$"loc"`,
      `pre"mid"${Q}end${Q}`,
    ]
    for (const w of words) expect(shellWordAt(w, 0), w).toBe(bashWord(w))
  })
  it('the word ends where the shell ends it', () => {
    expect(shellWordAt(`${Q}a b${Q} c`, 0)).toBe('a b')
    expect(shellWordAt('abc;def', 0)).toBe('abc')
    expect(shellWordAt('a|b', 0)).toBe('a')
    expect(shellWordAt(`x${NL}y`, 0)).toBe('x')
    expect(shellWordAt('$(echo x) y', 0)).toBe('$(echo x)')
    expect(shellWordAt('pre$(a (b) c)post z', 0)).toBe('pre$(a (b) c)post')
    expect(shellWordAt('# a comment', 0)).toBe(null)
    for (const open of [`${Q}abc`, `$${Q}abc`, '"abc', '$(abc', '`abc']) expect(shellWordAt(open, 0), open).toBe(null)
  })
})

describe('eabc253c: the depth bound is passed down the recursion', () => {
  it('three levels are read and a fourth is not: the bound keeps the work per command finite', () => {
    for (const [name, q] of QUOTINGS) {
      expect(bash(nest(q, 3, 'crontab -r')), `${name} x3`).toBe(true)
      expect(bash(nest(q, 4, 'crontab -r')), `${name} x4`).toBe(false)
    }
  })
})

describe('eabc253c: the word is read in linear time (the hook fails open after 10 s)', () => {
  const timed = (command: string): { deny: boolean; ms: number } => {
    const t0 = performance.now()
    const deny = bash(command)
    return { deny, ms: performance.now() - t0 }
  }
  it('a long word of escape forms, an unclosed substitution, a run of backquotes', () => {
    for (const command of [
      `bash -c ${closeEscQ(`a${Q}`.repeat(20000))}`,
      `bash -c ${shlexQ(`a${Q}`.repeat(20000))}; crontab -r`,
      `bash -c ${'$('.repeat(30000)}`,
      `bash -c ${'`'.repeat(30001)}`,
      `bash -c $${Q}${`${BS}x41`.repeat(30000)}${Q}`,
    ]) {
      const r = timed(command)
      expect(r.ms, command.slice(0, 40)).toBeLessThan(1000)
    }
    expect(timed(`bash -c ${shlexQ(`a${Q}`.repeat(20000))}; crontab -r`).deny).toBe(true)
  })
})
