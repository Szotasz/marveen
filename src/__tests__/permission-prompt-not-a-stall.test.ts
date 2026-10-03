import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsPermissionDialog, permissionPromptSummary } from '../pane-state.js'
import { formatStuckSessionAlert } from '../web/message-router.js'

// Real panes, captured while a general-purpose sub-agent's Bash call waited for
// consent (paths and symbol names anonymised, layout untouched). Two of them
// differ in the REASON wording, which is why nothing here keys on that wording;
// the third has the prompt in the UPPER half with a blank tail, the shape a
// fresh session shows when its first tool call needs consent.
const load = (n: string) => readFileSync(join(__dirname, `fixtures/pane/${n}.txt`), 'utf8')
const PANE_GREP = load('permission-prompt-bash-grep')
const PANE_CD = load('permission-prompt-compound-cd')
const PANE_UPPER = load('permission-prompt-upper-half')

describe('the fixtures are real permission prompts', () => {
  it('are all recognised by the shared detector', () => {
    // detectsPermissionDialog lands on develop (PR #1190). These fixtures are
    // kept because they come from live sessions and the summary below is
    // measured against them, not because the detector needs re-testing here.
    expect(detectsPermissionDialog(PANE_GREP)).toBe(true)
    expect(detectsPermissionDialog(PANE_CD)).toBe(true)
    expect(detectsPermissionDialog(PANE_UPPER)).toBe(true)
  })

  it('share no reason wording, so a wording-anchored reader would miss one', () => {
    expect(PANE_GREP).toContain('deny rule is configured')
    expect(PANE_CD).toContain('Compound command contains cd')
  })
})

describe('what the prompt is asking, so the alert needs no pane visit', () => {
  it('extracts the tool card title and the full reason from every live capture', () => {
    const a = permissionPromptSummary(PANE_GREP)!
    expect(a.title).toBe('Bash command · from the general-purpose agent')
    // The pane hard-wraps the reason; the first line alone would read just
    // "grep on", so the block has to be rejoined to be useful.
    expect(a.reason).toContain('a Read() deny rule is configured')
    expect(a.reason).not.toBe('grep on')

    const b = permissionPromptSummary(PANE_CD)!
    expect(b.reason).toBe('Compound command contains cd with a relative file read while a Read() deny rule exists')

    // The upper-half shape must work too: that is the case where the operator
    // is least likely to have the pane open already.
    const c = permissionPromptSummary(PANE_UPPER)!
    expect(c.title).toBe('Bash command · from the general-purpose agent')
    expect(c.reason).toContain('Compound command contains cd')
  })

  it('returns null rather than half a question', () => {
    expect(permissionPromptSummary('')).toBeNull()
    expect(permissionPromptSummary('Do you want to proceed?\n 1. Yes')).toBeNull()
  })

  it('caps a long reason instead of flooding the alert', () => {
    const long = PANE_GREP.replace('deny rule is configured', 'deny rule is configured ' + 'x'.repeat(400))
    const s = permissionPromptSummary(long)!
    expect(s.reason.length).toBeLessThanOrEqual(220)
    expect(s.reason.endsWith('…')).toBe(true)
  })
})

describe('stuck-session alert for a permission prompt', () => {
  const alertFor = (awaiting: boolean, ask = permissionPromptSummary(PANE_GREP)) =>
    formatStuckSessionAlert('voicedev', 'jarvis', 'agent-voicedev', 11 * 60 * 1000, 1, 'unknown', awaiting, ask)

  it('tells the reader to answer, and explicitly not to restart or Escape', () => {
    const alert = alertFor(true)!
    expect(alert).toContain('TOOL-PERMISSION PROMPT')
    expect(alert).toMatch(/Do NOT restart/)
    expect(alert).toMatch(/do NOT send a blind Escape/)
    expect(alert).toContain('tmux attach -t agent-voicedev')
  })

  it('quotes the question so the pane does not have to be opened', () => {
    const alert = alertFor(true)!
    expect(alert).toContain('It asks: Bash command · from the general-purpose agent')
    expect(alert).toContain('deny rule is configured')
  })

  it('does NOT recommend a restart, which the old not-ready text did', () => {
    // The regression this guards: the not-ready text says "restart the agent
    // if it is wedged". Following that on a permission prompt discards the
    // running work and leaves the question unanswered.
    expect(alertFor(true)!).not.toMatch(/restart the agent if it is wedged/)
    expect(alertFor(false)!).toMatch(/restart the agent if it is wedged/)
  })

  it('stays usable when the question cannot be parsed', () => {
    const alert = alertFor(true, null)!
    expect(alert).toContain('TOOL-PERMISSION PROMPT')
    expect(alert).not.toContain('It asks:')
    expect(alert).toContain('tmux attach -t agent-voicedev')
  })

  it('still never alerts the main agent about itself', () => {
    expect(formatStuckSessionAlert('jarvis', 'jarvis', 'x', 1, 1, 'unknown', true, null)).toBeNull()
  })
})
