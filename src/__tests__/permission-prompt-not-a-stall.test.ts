import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsPermissionPrompt, detectsBlockingMenu, detectPaneState, permissionPromptSummary } from '../pane-state.js'
import { formatStuckSessionAlert } from '../web/message-router.js'

// The fixture is a REAL pane, captured from agent-voicedev on 2026-09-03 while
// a general-purpose sub-agent's Bash grep waited for consent (paths and symbol
// names anonymised, structure untouched). Every rule below is measured against
// that shape rather than an invented one -- an invented prompt shape is how a
// detector ends up confidently wrong about a surface nobody has seen.
const REAL_PANE = readFileSync(
  join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'),
  'utf8',
)
// A SECOND live capture, taken while the first fix was in review. Same layout,
// DIFFERENT reason wording -- which is the point: it is the evidence that the
// detector must key on the question and the option list, never on the reason
// text, and that the summary extractor works on more than the shape it was
// written against.
const REAL_PANE_2 = readFileSync(
  join(__dirname, 'fixtures/pane/permission-prompt-compound-cd.txt'),
  'utf8',
)

describe('permission prompt is not a stalled session', () => {
  it('recognises both real captured prompts, whose reason wording differs', () => {
    expect(detectsPermissionPrompt(REAL_PANE)).toBe(true)
    expect(detectsPermissionPrompt(REAL_PANE_2)).toBe(true)
    // Guard the reason-independence explicitly: the two panes share no reason text.
    expect(REAL_PANE).toContain('deny rule is configured')
    expect(REAL_PANE_2).toContain('Compound command contains cd')
  })

  it('documents why it needs its own detector: the generic ones read it wrong', () => {
    // Both of these are the bug, not an accident of the fixture: the menu
    // detector matches (the footer says "Esc to cancel") and the pane state is
    // 'unknown', which is what routed the alert into the "restart it" text.
    expect(detectsBlockingMenu(REAL_PANE)).toBe(true)
    expect(detectPaneState(REAL_PANE)).toBe('unknown')
  })

  it('never fires on a busy pane, a live prompt quoting the question, or nothing', () => {
    const busy = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n✻ Thinking… (12s · 1.2k tokens · esc to interrupt)'
    const idleQuoting = '│ > │\n⏵⏵ bypass permissions on (shift+tab to cycle)\nI asked: Do you want to proceed?\n 1. Yes'
    expect(detectsPermissionPrompt(busy)).toBe(false)
    expect(detectsPermissionPrompt(idleQuoting)).toBe(false)
    expect(detectsPermissionPrompt('')).toBe(false)
  })

  it('needs BOTH the question and the option list, so prose alone cannot trigger it', () => {
    const questionOnly = 'Do you want to proceed?\n\nEsc to cancel · Tab to amend'
    const optionsOnly = '❯ 1. Yes\n  2. No\n\nEsc to cancel · Tab to amend'
    expect(detectsPermissionPrompt(questionOnly)).toBe(false)
    expect(detectsPermissionPrompt(optionsOnly)).toBe(false)
  })
})

describe('stuck-session alert for a permission prompt', () => {
  const alertFor = (awaiting: boolean) =>
    formatStuckSessionAlert('voicedev', 'jarvis', 'agent-voicedev', 11 * 60 * 1000, 1, 'unknown', awaiting)

  it('tells the reader to answer, and explicitly not to restart or Escape', () => {
    const alert = alertFor(true)!
    expect(alert).toContain('TOOL-PERMISSION PROMPT')
    expect(alert).toMatch(/Do NOT restart/)
    expect(alert).toMatch(/do NOT send a blind Escape/)
    expect(alert).toContain('tmux attach -t agent-voicedev')
  })

  it('does NOT recommend a restart, which the old not-ready text did', () => {
    // The regression this guards: the not-ready text says "restart the agent
    // if it is wedged". Following that on a permission prompt discards the
    // running work and leaves the question unanswered.
    expect(alertFor(true)!).not.toMatch(/restart the agent if it is wedged/)
    expect(alertFor(false)!).toMatch(/restart the agent if it is wedged/)
  })

  it('still never alerts the main agent about itself', () => {
    expect(formatStuckSessionAlert('jarvis', 'jarvis', 'x', 1, 1, 'unknown', true)).toBeNull()
  })
})

describe('what the prompt is asking, for an alert that needs no pane visit', () => {
  it('extracts the tool card title and the full reason from both live captures', () => {
    const a = permissionPromptSummary(REAL_PANE)!
    expect(a.title).toBe('Bash command · from the general-purpose agent')
    // The pane hard-wraps the reason; the first line alone would read just
    // "grep on", so the block has to be rejoined to be useful.
    expect(a.reason).toContain('a Read() deny rule is configured')
    expect(a.reason).not.toBe('grep on')

    const b = permissionPromptSummary(REAL_PANE_2)!
    expect(b.title).toBe('Bash command · from the general-purpose agent')
    expect(b.reason).toBe('Compound command contains cd with a relative file read while a Read() deny rule exists')
  })

  it('returns null rather than half a question', () => {
    expect(permissionPromptSummary('')).toBeNull()
    expect(permissionPromptSummary('Do you want to proceed?\n 1. Yes')).toBeNull()
  })

  it('caps a long reason instead of flooding the alert', () => {
    const long = REAL_PANE.replace('deny rule is configured', 'deny rule is configured ' + 'x'.repeat(400))
    const s = permissionPromptSummary(long)!
    expect(s.reason.length).toBeLessThanOrEqual(220)
    expect(s.reason.endsWith('…')).toBe(true)
  })

  it('puts the question into the stuck alert', () => {
    const ask = permissionPromptSummary(REAL_PANE)
    const alert = formatStuckSessionAlert('voicedev', 'jarvis', 'agent-voicedev', 11 * 60 * 1000, 1, 'unknown', true, ask)!
    expect(alert).toContain('It asks: Bash command · from the general-purpose agent')
    expect(alert).toContain('deny rule is configured')
  })

  it('still produces a usable alert when the question cannot be parsed', () => {
    const alert = formatStuckSessionAlert('voicedev', 'jarvis', 'agent-voicedev', 11 * 60 * 1000, 1, 'unknown', true, null)!
    expect(alert).toContain('TOOL-PERMISSION PROMPT')
    expect(alert).not.toContain('It asks:')
    expect(alert).toContain('tmux attach -t agent-voicedev')
  })
})
