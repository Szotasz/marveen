import { describe, it, expect } from 'vitest'
import { classifyInputBox, stripGhostSuggestion, stripAllAnsi } from '../pane-state.js'

// The all-agent input-state report (GET /api/agents/input-state) must tell a
// REAL parked input from a dim ghost suggestion. Measured 2026-10-11: after a
// host restart an idle remote agent's input box showed a dim suggestion; read
// through a colour-less capture it looked like an "unsent prompt", and the
// agent was cleared by hand although nothing had been parked. These fixtures
// follow that pane's real shape (coloured capture, `capture-pane -e -p`).

const SEP = '\x1b[38;5;244m' + '─'.repeat(80)
const FOOTER = '\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m'
const TAIL = [
  '● Done -- the card is updated.',
  '',
  '\x1b[38;5;174m✻\x1b[39m \x1b[38;5;246mWorked for 23s\x1b[39m',
]

const pane = (box: string, above: string[] = TAIL): string =>
  [...above, SEP, box, SEP, FOOTER].join('\n')

// One coloured capture seen the two ways captureInputBoxViews returns it.
const views = (coloured: string) => classifyInputBox(stripGhostSuggestion(coloured), stripAllAnsi(coloured))

describe('classifyInputBox', () => {
  it('a dim (SGR-2) suggestion in an idle box is a GHOST, not a parked input', () => {
    const r = views(pane('\x1b[39m❯\xa0\x1b[2mreview the remaining testing cards\x1b[0m\x1b[39m\x1b[49m'))
    expect(r.state).toBe('ghost')
    expect(r.chars).toBeGreaterThan(0)
  })

  it('the same text NOT dimmed is a real PARKED input (what an Enter would submit)', () => {
    const r = views(pane('\x1b[39m❯\xa0review the remaining testing cards\x1b[39m'))
    expect(r.state).toBe('parked')
    expect(r.chars).toBe('review the remaining testing cards'.length)
  })

  it('an empty idle box is EMPTY', () => {
    expect(views(pane('\x1b[39m❯\xa0\x1b[39m')).state).toBe('empty')
  })

  it('a running turn is BUSY (a message delivered mid-turn waits it out -- not a wedge)', () => {
    const busy = ['● Working on it', '', '\x1b[38;5;174m✻\x1b[39m Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)']
    expect(views(pane('\x1b[39m❯\xa0\x1b[39m', busy)).state).toBe('busy')
  })

  it('REAL text in the box DURING a running turn is BUSY, not PARKED (mid-turn message waits the turn out)', () => {
    const busy = ['● Working on it', '', '\x1b[38;5;174m✻\x1b[39m Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)']
    const r = views(pane('\x1b[39m❯\xa0TEAM MEMBER NOTICE -- delivered mid-turn\x1b[39m', busy))
    expect(r).toEqual({ state: 'busy', chars: 0 })
  })

  it('a parked [Pasted text #N] placeholder is PASTE', () => {
    expect(views(pane('\x1b[39m❯\xa0[Pasted text #1 +42 lines]\x1b[39m')).state).toBe('paste')
  })

  it('a pane that is not a Claude Code prompt is UNKNOWN, never EMPTY', () => {
    const r = classifyInputBox('$ ls\nfoo bar\n$ ', '$ ls\nfoo bar\n$ ')
    expect(r.state).toBe('unknown')
  })

  it('real text with a dim ghost continuation is PARKED (the real part would be submitted)', () => {
    const r = views(pane('\x1b[39m❯\xa0review the\x1b[2m remaining testing cards\x1b[0m\x1b[39m'))
    expect(r.state).toBe('parked')
    expect(r.chars).toBe('review the'.length)
  })

  it('a permission prompt (no input box) is never reported as EMPTY or PARKED', () => {
    const perm = [
      '● Bash(rm -rf /tmp/x)',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)',
    ].join('\n')
    const r = classifyInputBox(perm, perm)
    expect(['unknown', 'busy']).toContain(r.state)
  })

  it('never returns the parked TEXT -- only its length', () => {
    const r = views(pane('\x1b[39m❯\xa0secret-looking parked text\x1b[39m')) as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual(['chars', 'state'])
  })
})
