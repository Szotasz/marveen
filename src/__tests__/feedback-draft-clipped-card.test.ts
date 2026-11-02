// A tall feedback-draft card can push the input box's bottom rule and the idle
// footer below the pane: the capture then ends at the prompt row. The fixture is
// a measured `capture-pane -e -p` of a 24x80 sub-agent pane (Claude Code
// 2.1.312, 2026-11-02); the main session showed the same shape and sat behind an
// 'input-unreadable' hold for 3.5 hours. These tests pin that the dismisser
// reads that clipped box, closes the card with Down alone, and that a hold which
// never ends reaches the owner once.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { panes, sent, notify } = vi.hoisted(() => ({
  panes: { queue: [] as string[], last: '' },
  sent: [] as string[][],
  notify: { calls: [] as string[] },
}))

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
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

vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  notifyChannel: vi.fn(async (text: string) => { notify.calls.push(text) }),
}))

import { dismissFeedbackDraftModalIfPresent, FEEDBACK_HOLD_OWNER_AFTER_MS, decideFeedbackHoldEscalation } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { feedbackDraftDismissPlan, stripGhostSuggestion } from '../pane-state.js'

const CLIPPED = readFileSync(join(__dirname, 'fixtures/pane/feedback-draft-card-clipped-2.1.312.txt'), 'utf8')
const plain = (colored: string) => colored.replace(/\x1b\[[0-9;]*m/g, '')
const withTyped = (text: string) => CLIPPED.replace(/❯[\u00a0 ]?(\n?)$/, `❯ ${text}$1`)
const SEP = '─'.repeat(80)
const CLEAR_PANE = ['some earlier transcript line', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

describe('feedbackDraftDismissPlan on a card that clips the input box', () => {
  it('the measured capture really is clipped: no footer, one rule below the card', () => {
    const tail = plain(CLIPPED).trimEnd().split('\n').slice(-3)
    expect(tail[1]).toMatch(/^─{10,}.*Enigma AI/)
    expect(tail[2]).toMatch(/^❯/)
    expect(plain(CLIPPED)).not.toMatch(/bypass permissions/)
  })
  it('an empty clipped box gets Down alone, on the main session and on a sub-agent', () => {
    for (const main of [true, false]) {
      expect(feedbackDraftDismissPlan(plain(CLIPPED), stripGhostSuggestion(CLIPPED), main)).toEqual({ act: 'keys', keys: ['Down'] })
    }
  })
  it('anything typed in a clipped box is left alone, a digit leftover too (rows below are unseen)', () => {
    for (const t of ['hello', '0', '000']) {
      const p = withTyped(t)
      expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), false)).toEqual({ act: 'hold', reason: 'input-occupied' })
    }
  })
  it('a dim autosuggest in a clipped box reads as empty', () => {
    const p = withTyped('\x1b[2msuggested earlier prompt\x1b[0m')
    expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), false)).toEqual({ act: 'keys', keys: ['Down'] })
  })
  it('two captures of different frames read as unreadable, not as a box', () => {
    expect(feedbackDraftDismissPlan(plain(CLIPPED), stripGhostSuggestion(CLIPPED) + '\nextra row', true)).toEqual({ act: 'hold', reason: 'input-unreadable' })
  })
  it('a rule followed by something other than the prompt is not a box', () => {
    const p = CLIPPED.replace(/❯[\u00a0 ]?(\n?)$/, 'not a prompt$1')
    expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), true)).toEqual({ act: 'none' })
  })
})

describe('dismissFeedbackDraftModalIfPresent on the clipped card', () => {
  beforeEach(() => { panes.queue = []; panes.last = ''; sent.length = 0; notify.calls.length = 0 })

  it('the main session gets Down and no digit', async () => {
    panes.queue = [CLIPPED, CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(MAIN_CHANNELS_SESSION)
    expect(sent).toEqual([['Down']])
  })
})

describe('a hold that never ends reaches the owner once', () => {
  beforeEach(() => { panes.queue = []; panes.last = ''; sent.length = 0; notify.calls.length = 0; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('decideFeedbackHoldEscalation fires at the window, never twice', () => {
    expect(decideFeedbackHoldEscalation(0, FEEDBACK_HOLD_OWNER_AFTER_MS - 1, false)).toBe(false)
    expect(decideFeedbackHoldEscalation(0, FEEDBACK_HOLD_OWNER_AFTER_MS, false)).toBe(true)
    expect(decideFeedbackHoldEscalation(0, FEEDBACK_HOLD_OWNER_AFTER_MS * 5, true)).toBe(false)
  })

  it('typed text on the main box: no keystroke, one owner alert after the window, a new episode after the card clears', async () => {
    const session = 'agent-hold-test'
    const held = withTyped('a reply the owner is writing')
    const run = async (frame: string) => {
      panes.queue = [frame]
      const p = dismissFeedbackDraftModalIfPresent(session)
      await vi.runAllTimersAsync()
      await p
    }
    await run(held)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS - 1000)
    await run(held)
    expect(notify.calls).toHaveLength(0)
    vi.advanceTimersByTime(2000)
    await run(held)
    await run(held)
    expect(notify.calls).toHaveLength(1)
    expect(notify.calls[0]).toContain(`tmux attach -t ${session}`)
    expect(sent).toEqual([])

    await run(CLEAR_PANE)
    await run(held)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS)
    await run(held)
    expect(notify.calls).toHaveLength(2)
    expect(sent).toEqual([])
  })
})
