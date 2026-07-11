import { describe, it, expect } from 'vitest'
import { sanitizeLiteralKeys } from '../web/routes/agent-terminal.js'

describe('sanitizeLiteralKeys', () => {
  it('passes a single keystroke through untouched (incl. a deliberate space)', () => {
    expect(sanitizeLiteralKeys('a')).toBe('a')
    expect(sanitizeLiteralKeys(' ')).toBe(' ')
    expect(sanitizeLiteralKeys('')).toBe('')
  })

  it('trims leading/trailing whitespace on a paste', () => {
    expect(sanitizeLiteralKeys('  hello  ')).toBe('hello')
    expect(sanitizeLiteralKeys('\t/login token\t')).toBe('/login token')
  })

  it('strips a trailing newline so a pasted line does not pre-submit', () => {
    expect(sanitizeLiteralKeys('https://claude.ai/auth?code=abc123\n')).toBe('https://claude.ai/auth?code=abc123')
    expect(sanitizeLiteralKeys('code-xyz\r\n')).toBe('code-xyz')
  })

  it('drops embedded CR/LF from a multi-line paste (login code/URL is single-line)', () => {
    expect(sanitizeLiteralKeys('abc\ndef')).toBe('abcdef')
    expect(sanitizeLiteralKeys('  http://x\r\n?y=1  ')).toBe('http://x?y=1')
  })

  it('strips xterm bracketed-paste markers', () => {
    expect(sanitizeLiteralKeys('\x1b[200~pasted-token\x1b[201~')).toBe('pasted-token')
    expect(sanitizeLiteralKeys('\x1b[200~  spaced  \n\x1b[201~')).toBe('spaced')
  })

  it('collapses an all-whitespace paste to empty (no-op send)', () => {
    expect(sanitizeLiteralKeys('   \n\t ')).toBe('')
  })
})
