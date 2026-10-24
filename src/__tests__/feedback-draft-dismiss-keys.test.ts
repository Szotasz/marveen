// The feedback-draft card watches the prompt INPUT VALUE: it fires only when the
// input changes to exactly one digit, after a debounce, and ignores a digit typed
// right after it appears. A dismisser that types "0" can leave the digit in the
// input, and every later attempt then appends another one. These tests pin that
// the dismisser closes the card with C-u then Down, as two separate keystrokes,
// and never types a digit ("2" would even send the draft).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { panes, sent } = vi.hoisted(() => ({ panes: { queue: [] as string[], last: '' }, sent: [] as string[][] }))

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  // Each PLAIN capture-pane consumes the next scripted frame (the last one repeats);
  // a -e capture returns the current frame raw. Like tmux, a capture without -e
  // loses the escapes (and with them the dim styling).
  const nextPane = (args: string[]) => {
    if (!args.includes('-e') && panes.queue.length > 0) panes.last = panes.queue.shift() as string
    return args.includes('-e') ? panes.last : panes.last.replace(/\x1b\[[0-9;]*m/g, '')
  }
  return {
    ...actual,
    execFileSync: vi.fn((_file: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('capture-pane')) return nextPane(args)
      if (Array.isArray(args) && args.includes('send-keys')) sent.push(args.slice(args.indexOf('-t') + 2))
      return ''
    }),
  }
})

import { dismissFeedbackDraftModalIfPresent } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { feedbackDraftDismissPlan } from '../pane-state.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const BOX_TOP = '╭' + '─'.repeat(60) + '╮'
const BOX_BOTTOM = '╰' + '─'.repeat(60) + '╯'
const DRAFT_LINE = '│ ✻ Bug report drafted: the pane read idle while blocked   │'
const OPTIONS = '1 to review · 2 to send · 0 to dismiss'

function modalPane(rows: string[]): string {
  return ['some earlier transcript line', '', BOX_TOP, DRAFT_LINE, `│ ${OPTIONS.padEnd(58)}│`, BOX_BOTTOM, '', SEP, ...rows, SEP, FOOTER].join('\n')
}
const withInput = (input: string) => modalPane([`❯ ${input}`])
const CLEAR_PANE = ['some earlier transcript line', '', SEP, '❯ ', SEP, FOOTER].join('\n')
const OPTOUT_PANE = ['some earlier transcript line', '', 'Turn off Claude-drafted feedback? 0 to turn off · Esc to keep', '', SEP, '❯ ', SEP, FOOTER].join('\n')
const SUB = 'agent-sub'

describe('feedbackDraftDismissPlan', () => {
  it('no card: nothing to do', () => {
    expect(feedbackDraftDismissPlan(CLEAR_PANE, CLEAR_PANE, false)).toEqual({ act: 'none' })
  })
  it('an empty input: C-u then Down on a sub-agent, only Down on the main session', () => {
    expect(feedbackDraftDismissPlan(withInput(''), withInput(''), false)).toEqual({ act: 'keys', keys: ['C-u', 'Down'] })
    expect(feedbackDraftDismissPlan(withInput(''), withInput(''), true)).toEqual({ act: 'keys', keys: ['Down'] })
  })
  it('a leftover digit run is cleared on a sub-agent, never on the main session', () => {
    for (const d of ['0', '0000', '2']) {
      expect(feedbackDraftDismissPlan(withInput(d), withInput(d), false)).toEqual({ act: 'keys', keys: ['C-u', 'Down'] })
      expect(feedbackDraftDismissPlan(withInput(d), withInput(d), true)).toEqual({ act: 'hold', reason: 'input-occupied' })
    }
  })
  it('an input view that could not be captured: no keystroke', () => {
    expect(feedbackDraftDismissPlan(withInput(''), null, false)).toEqual({ act: 'hold', reason: 'input-unreadable' })
  })
  it('typed text is left alone, spaces included', () => {
    for (const t of ['hello', '2 2', '0 and more']) {
      expect(feedbackDraftDismissPlan(withInput(t), withInput(t), false)).toEqual({ act: 'hold', reason: 'input-occupied' })
    }
  })
  it('only the column-0 marker at the top of the box is UI', () => {
    // a continuation row that starts with a typed ❯ is text
    expect(feedbackDraftDismissPlan(modalPane(['❯ 0', '❯ more']), modalPane(['❯ 0', '❯ more']), false)).toEqual({ act: 'hold', reason: 'input-occupied' })
    // a blank row, then the real prompt row: still read
    expect(feedbackDraftDismissPlan(modalPane(['', '❯ 00']), modalPane(['', '❯ 00']), false)).toEqual({ act: 'keys', keys: ['C-u', 'Down'] })
  })
})

describe('dismissFeedbackDraftModalIfPresent', () => {
  beforeEach(() => { panes.queue = []; panes.last = ''; sent.length = 0 })

  it('a sub-agent with an empty box gets C-u, then Down, as two calls, and no digit', async () => {
    panes.queue = [withInput(''), CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([['C-u'], ['Down']])
    expect(sent.flat().some(k => /\d/.test(k))).toBe(false)
  })
  it('a leftover "000" is cleared the same way', async () => {
    panes.queue = [withInput('000'), CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([['C-u'], ['Down']])
  })
  it('the main session gets only Down', async () => {
    panes.queue = [withInput(''), CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(MAIN_CHANNELS_SESSION)
    expect(sent).toEqual([['Down']])
  })
  it('typed text gets no keystroke at all', async () => {
    panes.queue = [withInput('hello')]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([])
  })
  it('a dim autosuggest in an empty box reads as empty', async () => {
    panes.queue = [modalPane(['❯ \x1b[2msuggested earlier prompt\x1b[0m']), CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([['C-u'], ['Down']])
  })
  it('a card whose option line is rendered dim is still detected and dismissed', async () => {
    const dim = modalPane(['❯ ']).replace(OPTIONS, `\x1b[2m${OPTIONS}\x1b[0m`)
    expect(dim).toContain('\x1b[2m')
    panes.queue = [dim, CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([['C-u'], ['Down']])
  })
  it('the opt-out follow-up is answered with Escape, never a digit', async () => {
    panes.queue = [withInput(''), OPTOUT_PANE]
    await dismissFeedbackDraftModalIfPresent(SUB)
    expect(sent).toEqual([['C-u'], ['Down'], ['Escape']])
  })
})
