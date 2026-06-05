import { describe, it, expect } from 'vitest'
import { resolveSpecialKey, literalKeyArgs, specialKeyArgs, loginSequence } from '../web/tmux-keys.js'

// Web-terminal keystroke mapping (Szabi 2026-06-03). The allow-list is the
// security boundary: only recognised special keys may be injected.
describe('resolveSpecialKey', () => {
  it('maps known keys', () => {
    expect(resolveSpecialKey('Enter')).toEqual(['Enter'])
    expect(resolveSpecialKey('Escape')).toEqual(['Escape'])
    expect(resolveSpecialKey('C-c')).toEqual(['C-c'])
    expect(resolveSpecialKey('S-Tab')).toEqual(['BTab'])
    expect(resolveSpecialKey('Backspace')).toEqual(['BSpace'])
  })

  it('returns null for an unknown / non-allow-listed key', () => {
    expect(resolveSpecialKey('C-x')).toBeNull()
    expect(resolveSpecialKey('rm -rf')).toBeNull()
    expect(resolveSpecialKey('')).toBeNull()
  })
})

describe('literalKeyArgs', () => {
  it('builds a literal send-keys with -l and the -- terminator', () => {
    expect(literalKeyArgs('agent-samu', 'hello')).toEqual(['send-keys', '-t', 'agent-samu', '-l', '--', 'hello'])
  })

  it('passes leading-dash text literally (after --)', () => {
    // The -- terminator means even "-Enter" is taken as text, not a flag.
    expect(literalKeyArgs('agent-x', '-Enter')).toEqual(['send-keys', '-t', 'agent-x', '-l', '--', '-Enter'])
  })

  it('returns null for empty text', () => {
    expect(literalKeyArgs('agent-x', '')).toBeNull()
  })
})

describe('specialKeyArgs', () => {
  it('builds send-keys for an allow-listed key', () => {
    expect(specialKeyArgs('agent-x', 'Enter')).toEqual(['send-keys', '-t', 'agent-x', 'Enter'])
  })
  it('returns null for a non-allow-listed key', () => {
    expect(specialKeyArgs('agent-x', 'C-x')).toBeNull()
  })
})

describe('loginSequence', () => {
  it('start phase: types /login, submits, accepts the highlighted subscription option', () => {
    const steps = loginSequence('start')
    expect(steps[0]).toMatchObject({ kind: 'literal', text: '/login' })
    expect(steps.filter(s => s.kind === 'special' && s.key === 'Enter').length).toBe(2)
    // every step carries a non-negative settle delay
    expect(steps.every(s => s.delayMs >= 0)).toBe(true)
  })

  it('confirm phase: sends the two trailing Enters', () => {
    const steps = loginSequence('confirm')
    expect(steps.length).toBe(2)
    expect(steps.every(s => s.kind === 'special' && s.key === 'Enter')).toBe(true)
  })
})
