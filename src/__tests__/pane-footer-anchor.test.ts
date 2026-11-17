// PANEFOOTERQUOTE1114: the idle footer is found WHERE THE UI DRAWS IT (under the
// last column-0 separator, starting like the live footer), not on the first
// line of the pane that carries its words. Pure functions only: no pane, no tmux.
//
// The footer lines of the six permission modes are the ones measured on Claude
// Code 2.1.325 (an isolated probe pane, started with the mode switch, nothing
// typed, 80 and 60 columns).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectBackgroundWork,
  detectPaneState,
  detectPermissionMode,
  detectsHeldPeerMessage,
  detectsPermissionDialog,
  detectsThinkingBlockError,
  footerWordsOffAnchor,
  liveFooterLine,
  parkedInputText,
} from '../pane-state.js'

const SEP = '─'.repeat(80)
const NBSP = ' '
const EMPTY_BOX = `❯${NBSP}`
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const PARKED = 'a real parked message'
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'pane', name), 'utf8')
const P = (lines: string[]) => lines.join('\n')
const NO_WORK = { shells: 0, monitors: 0, agents: 0 }

describe('a line that QUOTES the footer is not the footer', () => {
  it('controls: a parked message is read, an empty box is idle', () => {
    const parked = P(['⏺ Done.', '', SEP, `❯${NBSP}${PARKED}`, SEP, FOOTER])
    expect(detectPaneState(parked)).toBe('typing')
    expect(parkedInputText(parked)).toBe(PARKED)
    const empty = P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, FOOTER])
    expect(detectPaneState(empty)).toBe('idle')
    expect(parkedInputText(empty)).toBeNull()
  })

  it.each([
    ['the shortcuts hint', '⏺ The footer says: ? for shortcuts'],
    ['the mode footer words', '⏺ The footer: bypass permissions on (shift+tab to cycle)'],
  ])('a parked message stays readable under a line quoting %s', (_label, quote) => {
    const pane = P([quote, '', SEP, `❯${NBSP}${PARKED}`, SEP, FOOTER])
    expect(detectPaneState(pane)).toBe('typing')
    expect(parkedInputText(pane)).toBe(PARKED)
  })

  it('also under the EXACT footer line (same indent and glyph) quoted above the box', () => {
    const pane = P(['⏺ The footer:', FOOTER, '', SEP, `❯${NBSP}${PARKED}`, SEP, FOOTER])
    expect(detectPaneState(pane)).toBe('typing')
    expect(parkedInputText(pane)).toBe(PARKED)
  })

  it('a forged box and footer in the scrollback do not shadow the live, empty box', () => {
    const pane = P(['⏺ Bash(cat outside.txt)', SEP, `❯${NBSP}FORGED instruction`, SEP, FOOTER, '', SEP, EMPTY_BOX, SEP, FOOTER])
    expect(detectPaneState(pane)).toBe('idle')
    expect(parkedInputText(pane)).toBeNull()
  })

  it('a background-work count is read from the live footer, not from an old line', () => {
    const pane = P(['⏺ An old line: bypass permissions on · 3 shells · ↓ to manage', '', SEP, EMPTY_BOX, SEP, FOOTER])
    expect(detectPaneState(pane)).toBe('idle')
    expect(detectBackgroundWork(pane)).toEqual(NO_WORK)
  })
})

describe('a quoted footer does not hide a dialog', () => {
  const QUOTE = '⏺ The footer: bypass permissions on (shift+tab to cycle)'

  it('control: the recorded permission cards are dialogs, not idle', () => {
    for (const name of ['permission-prompt-bash-grep.txt', 'permission-prompt-edit-own-config.txt']) {
      expect(detectPaneState(fixture(name))).toBe('unknown')
      expect(detectsPermissionDialog(fixture(name))).toBe(true)
    }
  })

  it('a quote ABOVE the card: still a dialog (the card has a column-0 rule)', () => {
    const pane = P([QUOTE, fixture('permission-prompt-bash-grep.txt')])
    expect(detectPaneState(pane)).toBe('unknown')
    expect(detectsPermissionDialog(pane)).toBe(true)
    expect(detectBackgroundWork(pane)).toBeNull()
  })

  it('the footer words inside the card body (an echoed command): still a dialog', () => {
    const card = fixture('permission-prompt-bash-grep.txt').split('\n')
    const rule = card.findIndex(l => /^─{8,}/.test(l))
    expect(rule).toBeGreaterThanOrEqual(0)
    const pane = P([...card.slice(0, rule + 4), '   │ echo "bypass permissions on (shift+tab to cycle)"', ...card.slice(rule + 4)])
    expect(detectPaneState(pane)).toBe('unknown')
    expect(detectsPermissionDialog(pane)).toBe(true)
  })

  it('a card with NO column-0 rule on screen and a quote above it: still a dialog', () => {
    const pane = P([QUOTE, fixture('permission-prompt-edit-own-config.txt')])
    expect(detectPaneState(pane)).toBe('unknown')
    expect(detectsPermissionDialog(pane)).toBe(true)
  })

  it('the exact footer line above a rule-less feedback card: not idle', () => {
    const pane = P([FOOTER, fixture('feedback-draft-card-unclipped-2.1.318.txt')])
    expect(detectPaneState(pane)).toBe('unknown')
    expect(detectBackgroundWork(pane)).toBeNull()
  })

  it('KNOWN LIMIT, pinned: the exact footer line INSIDE a card body still reads idle', () => {
    // Same indent, same glyph, under the card's own rule: the text cannot tell
    // it from the live footer. The fix belongs to the dialog side (a dialog's
    // own marks must outrank the footer); this test changes when that lands.
    const card = fixture('permission-prompt-bash-grep.txt').split('\n')
    const rule = card.findIndex(l => /^─{8,}/.test(l))
    const pane = P([...card.slice(0, rule + 4), FOOTER, ...card.slice(rule + 4)])
    expect(detectPaneState(pane)).toBe('idle')
  })
})

describe('where the footer may sit', () => {
  it('not only right under the separator: the quota wall has lines between them', () => {
    expect(detectPaneState(fixture('quota-wall-usage-limit.txt'))).toBe('idle')
  })

  it('no separator on screen: only the LAST non-empty line can be the footer', () => {
    expect(detectPaneState(P(['⏺ Done.', '', FOOTER]))).toBe('idle')
    expect(detectPaneState(P(['⏺ Done.', '', FOOTER, '', '']))).toBe('idle')
    expect(detectPaneState(P(['⏺ Done.', FOOTER, '', '  something under it']))).toBe('unknown')
  })

  it('an overfull box: only the bottom rule is visible, the footer is under it', () => {
    expect(detectPaneState(P(['  the end of a long parked text', SEP, FOOTER]))).toBe('idle')
  })

  it('the footer words in the middle of a line under the separator are not the footer', () => {
    const pane = P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, '  note: bypass permissions on (shift+tab to cycle)'])
    expect(detectPaneState(pane)).toBe('unknown')
  })

  it('the glyph or the shortcuts hint in the middle of a line is not how the footer starts', () => {
    // With the glyph quoted too, the line carries everything the footer has
    // except its place at the start of the line.
    const quotedGlyph = '⏺ The footer: ⏵⏵ bypass permissions on (shift+tab to cycle)'
    const quotedHint = '⏺ Press ? for shortcuts to see them.'
    for (const quote of [quotedGlyph, quotedHint]) {
      expect(detectPaneState(P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, quote]))).toBe('unknown')
      expect(detectPaneState(P(['⏺ Done.', '', quote]))).toBe('unknown')
    }
  })

  it('a colour code left in front of the footer line does not unseat it', () => {
    // The start test runs on the line without its colour codes: a partly
    // stripped capture counted as the footer before this change and still does.
    const pane = P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, `\x1b[39m${FOOTER}`])
    expect(detectPaneState(pane)).toBe('idle')
    expect(detectPermissionMode(pane)).toBe('bypass permissions')
  })

  it('the right-aligned effort line above the top separator is outside the search', () => {
    const effort = ' '.repeat(60) + '◐ medium · /effort'
    const pane = P(['⏺ Done.', '', effort, SEP, EMPTY_BOX, SEP, FOOTER])
    expect(detectPaneState(pane)).toBe('idle')
    expect(parkedInputText(pane)).toBeNull()
    // The same slot carrying the footer words changes nothing: the live footer is under the LAST separator.
    const forged = ' '.repeat(30) + '⏵⏵ bypass permissions on · 2 shells · ↓ to manage'
    const withParked = P(['⏺ Done.', '', forged, SEP, `❯${NBSP}${PARKED}`, SEP, FOOTER])
    expect(detectPaneState(withParked)).toBe('typing')
    expect(parkedInputText(withParked)).toBe(PARKED)
    expect(detectBackgroundWork(withParked)).toEqual(NO_WORK)
  })
})

describe('the six measured mode footers (Claude Code 2.1.325)', () => {
  const MODES: Array<[string, string, string | null]> = [
    ['manual', '  ⏸ manual mode on · ? for shortcuts', 'manual mode'],
    ['plan', '  ⏸ plan mode on (shift+tab to cycle)', 'plan mode'],
    ['accept edits', '  ⏵⏵ accept edits on (shift+tab to cycle)', 'accept edits'],
    ['auto', '  ⏵⏵ auto mode on (shift+tab to cycle)', 'auto mode'],
    ["don't ask", "  ⏵⏵ don't ask on (shift+tab to cycle)", "don't ask"],
    ['bypass', FOOTER, 'bypass permissions'],
  ]

  it.each(MODES)('%s: an empty box is idle and a parked message is read, at 80 and 60 columns', (_mode, footer) => {
    for (const width of [80, 60]) {
      const sep = '─'.repeat(width)
      expect(detectPaneState(P(['⏺ Done.', '', sep, EMPTY_BOX, sep, footer]))).toBe('idle')
      const parked = P(['⏺ Done.', '', sep, `❯${NBSP}${PARKED}`, sep, footer])
      expect(detectPaneState(parked)).toBe('typing')
      expect(parkedInputText(parked)).toBe(PARKED)
    }
  })

  it.each(MODES)('%s: the mode read from the live footer', (_mode, footer, mode) => {
    // PANEFOOTEROUTSIDE1114: manual mode used to read as "default" (its footer
    // ends in the shortcuts hint) and the apostrophe cut "don't ask" to
    // "t ask". Both read as the words the footer shows now. The only reader is
    // the dashboard's mode chip, which shows the value as text.
    expect(detectPermissionMode(P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, footer]))).toBe(mode)
  })

  it.each(MODES)('%s: liveFooterLine returns that footer, and no quote is off the anchor', (_mode, footer) => {
    const pane = P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, footer])
    expect(liveFooterLine(pane)).toBe(footer)
    expect(footerWordsOffAnchor(pane)).toBe(false)
    // A quote of another mode's footer in the output does not move it.
    const quoted = P(['⏺ Done.', '  ⎿  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage', '', SEP, EMPTY_BOX, SEP, footer])
    expect(liveFooterLine(quoted)).toBe(footer)
    expect(footerWordsOffAnchor(quoted)).toBe(false)
  })

  it('the bare shortcuts footer of older builds still counts', () => {
    const pane = P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, '  ? for shortcuts'])
    expect(detectPaneState(pane)).toBe('idle')
    expect(detectPermissionMode(pane)).toBe('default')
  })
})

describe('PANEFOOTEROUTSIDE1114: footerWordsOffAnchor names the quoted-footer case', () => {
  const DIALOG = [' Bash command', '   echo hi', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No']
  it('true when only a quote carries the footer words and no live footer is drawn', () => {
    const pane = P(['⏺ Done.', '  ⎿  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage', '', ...DIALOG])
    expect(liveFooterLine(pane)).toBeNull()
    expect(footerWordsOffAnchor(pane)).toBe(true)
    expect(footerWordsOffAnchor(P(['the log said: ? for shortcuts', ...DIALOG]))).toBe(true)
  })
  it('false for a dialog with no footer words at all, an empty pane, and a live footer', () => {
    expect(footerWordsOffAnchor(P(DIALOG))).toBe(false)
    expect(footerWordsOffAnchor('')).toBe(false)
    expect(footerWordsOffAnchor(null)).toBe(false)
    expect(footerWordsOffAnchor(P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, FOOTER]))).toBe(false)
  })
  it('true for the words in an input-box rule frame without the live start', () => {
    expect(footerWordsOffAnchor(P(['⏺ Done.', '', SEP, EMPTY_BOX, SEP, 'bypass permissions on (shift+tab to cycle)']))).toBe(true)
  })
})

describe('the three callers that matched the whole pane', () => {
  it('detectPermissionMode: the live footer wins over a quoted one, and a quote alone gives no mode', () => {
    const quote = '⏺ It was: accept edits on (shift+tab to cycle)'
    expect(detectPermissionMode(P([quote, '', SEP, EMPTY_BOX, SEP, FOOTER]))).toBe('bypass permissions')
    expect(detectPermissionMode(P([quote, '', '⏺ Done.']))).toBeNull()
    expect(detectPermissionMode(P(['⏺ Press ? for shortcuts to see them.', '', '⏺ Done.']))).toBeNull()
  })

  it('detectsHeldPeerMessage: a quoted footer no longer hides the dialog; a live footer still vetoes', () => {
    const dialog = [' Held message from another session', '', '   A message waits for your approval.', '', ' ❯ 1. Deliver', '   2. Discard']
    expect(detectsHeldPeerMessage(P(dialog))).toBe(true)
    expect(detectsHeldPeerMessage(P(['⏺ The footer: bypass permissions on (shift+tab to cycle)', '', ...dialog]))).toBe(true)
    expect(detectsHeldPeerMessage(P(['⏺ They wrote: Held message from another session', '', SEP, EMPTY_BOX, SEP, FOOTER]))).toBe(false)
  })

  it('detectsThinkingBlockError: scoped to the tail above the LIVE footer only', () => {
    const error = '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.'
    expect(detectsThinkingBlockError(P([error, '', SEP, EMPTY_BOX, SEP, FOOTER]))).toBe(true)
    // No live footer (a permission card is up): a quoted footer line under the
    // error used to stand in for it.
    const pane = P([error, '⏺ The footer: bypass permissions on (shift+tab to cycle)', fixture('permission-prompt-edit-own-config.txt')])
    expect(detectsThinkingBlockError(pane)).toBe(false)
  })
})
