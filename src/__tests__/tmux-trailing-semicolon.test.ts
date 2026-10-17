/**
 * TMUXSEMI1001: tmux drops a trailing ';' of a send-keys argument (it parses
 * it as a command separator), even with -l. Measured 2026-10-01 on the host:
 * `send-keys -l 'abc;'` + `'def'` typed `abcdef`; `'abc\;'` typed `abc;`.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { protectTrailingSemicolon, literalKeyArgs } from '../web/tmux-keys.js'

describe('protectTrailingSemicolon', () => {
  it('escapes a trailing semicolon', () => {
    expect(protectTrailingSemicolon('a;b;')).toBe('a;b\\;')
  })
  it('leaves inner semicolons and other endings alone', () => {
    expect(protectTrailingSemicolon('a;b')).toBe('a;b')
    expect(protectTrailingSemicolon('')).toBe('')
  })
  it('escapes a trailing semicolon that already has a backslash in front (tmux eats exactly one)', () => {
    expect(protectTrailingSemicolon('a\\;')).toBe('a\\\\;')
    expect(protectTrailingSemicolon('find . -exec rm {} \\;')).toBe('find . -exec rm {} \\\\;')
    // only the LAST character counts: an inner escaped one is typed as is
    expect(protectTrailingSemicolon('a\\;b')).toBe('a\\;b')
  })
  it('literalKeyArgs carries the protected text', () => {
    // develop's exact-match target (`=s:`) since the tmux-target change; the protection is unchanged
    expect(literalKeyArgs('s', 'x;')).toEqual(['send-keys', '-t', '=s:', '-l', '--', 'x\\;'])
  })
})

let tmuxOk = false
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); tmuxOk = true } catch { /* no tmux */ }

describe.skipIf(!tmuxOk)('real tmux: the semicolon survives the protected send', () => {
  it('types every semicolon of a chunked line', () => {
    const sock = `semitest-${process.pid}`
    const sess = 'semi'
    const tmux = (...a: string[]) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf-8' })
    tmux('new-session', '-d', '-s', sess, 'cat')
    try {
      for (const chunk of ['b=t[4:];', 'print(1);', ';', 'end']) {
        tmux('send-keys', '-t', sess, '-l', protectTrailingSemicolon(chunk))
      }
      execFileSync('/bin/sleep', ['0.3'])
      expect(tmux('capture-pane', '-p', '-t', sess).split('\n')[0]).toBe('b=t[4:];print(1);;end')
    } finally {
      try { tmux('kill-server') } catch { /* ignore */ }
    }
  })

  it('an escaped trailing semicolon keeps its backslash (find -exec ... \\;)', () => {
    const sock = `semitest2-${process.pid}`
    const sess = 'semi'
    const tmux = (...a: string[]) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf-8' })
    tmux('new-session', '-d', '-s', sess, 'cat > /dev/null')
    try {
      tmux('send-keys', '-t', sess, '-l', protectTrailingSemicolon('find . -exec rm {} \\;'))
      execFileSync('/bin/sleep', ['0.3'])
      expect(tmux('capture-pane', '-p', '-t', sess).split('\n')[0]).toBe('find . -exec rm {} \\;')
    } finally {
      try { tmux('kill-server') } catch { /* ignore */ }
    }
  })
})
