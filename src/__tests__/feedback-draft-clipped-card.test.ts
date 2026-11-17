// A tall feedback-draft card can push the input box's bottom rule and the idle
// footer below the pane: the capture then ends at the prompt row. The fixture is
// a measured `capture-pane -e -p` of a 24x80 sub-agent pane (Claude Code
// 2.1.312, 2026-11-02); the main session showed the same shape and sat behind an
// 'input-unreadable' hold for 3.5 hours. These tests pin that the dismisser
// reads that clipped box and closes it with a single "0" (Down leaves this card
// up, measured 2026-11-02 on agent-enigma), answers the opt-out question with
// Escape, and that a hold which never ends reaches the owner once.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { panes, sent, notify } = vi.hoisted(() => ({
  panes: { queue: [] as string[], last: '' },
  sent: [] as string[][],
  notify: { calls: [] as string[] },
}))

vi.mock('node:child_process', async (orig) => {
  const { execFileFromSync } = await import('./helpers/exec-file-from-sync.js')
  const actual = await orig<typeof import('node:child_process')>()
  const nextPane = (args: string[]) => {
    if (!args.includes('-e') && panes.queue.length > 0) panes.last = panes.queue.shift() as string
    return args.includes('-e') ? panes.last : panes.last.replace(/\x1b\[[0-9;]*m/g, '')
  }
  const mocked = {
    ...actual,
    execFileSync: vi.fn((_file: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('capture-pane')) return nextPane(args)
      if (Array.isArray(args) && args.includes('send-keys')) sent.push(args.slice(args.indexOf('-t') + 2))
      return ''
    }),
  }
  return { ...mocked, execFile: execFileFromSync(mocked.execFileSync) }
})

vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  notifyChannel: vi.fn(async (text: string) => { notify.calls.push(text) }),
}))

import { dismissFeedbackDraftModalIfPresent, FEEDBACK_HOLD_OWNER_AFTER_MS, decideFeedbackHoldEscalation, clearStaleParkedInput, mainParkedOwnerAlert, MAIN_PARKED_OWNER_AFTER } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { feedbackDraftDismissPlan, stripGhostSuggestion, detectsFeedbackDraftModal, detectPaneState } from '../pane-state.js'

const fixture = (name: string) => readFileSync(join(__dirname, `fixtures/pane/feedback-draft-card-${name}.txt`), 'utf8')
const CLIPPED = fixture('clipped-2.1.312')
// Measured 2026-11-04 on Claude Code 2.1.318 (throwaway session, keys sent by
// hand): the empty unclipped card (200x60 pane, transcript rows above the card
// trimmed), and both layouts with text in the prompt, where the card swaps its
// option line for "clear text to review, send, or dismiss".
const UNCLIPPED_318 = fixture('unclipped-2.1.318')
const UNCLIPPED_TYPED_318 = fixture('unclipped-typed-2.1.318')
const CLIPPED_TYPED_318 = fixture('clipped-typed-2.1.318')
const typedAs = (frame: string, text: string) => frame.replace('❯ a reply', `❯ ${text}`)
const plain = (colored: string) => colored.replace(/\x1b\[[0-9;]*m/g, '')
const withTyped = (text: string) => CLIPPED.replace(/❯[\u00a0 ]?(\n?)$/, `❯ ${text}$1`)
const SEP = '─'.repeat(80)
const OPTOUT_PANE = ['some earlier transcript line', '', 'Turn off Claude-drafted feedback? 0 to turn off · Esc to keep', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const CLEAR_PANE = ['some earlier transcript line', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

describe('feedbackDraftDismissPlan on a card that clips the input box', () => {
  it('the measured capture really is clipped: no footer, one rule below the card', () => {
    const tail = plain(CLIPPED).trimEnd().split('\n').slice(-3)
    expect(tail[1]).toMatch(/^─{10,}.*Enigma AI/)
    expect(tail[2]).toMatch(/^❯/)
    expect(plain(CLIPPED)).not.toMatch(/bypass permissions/)
  })
  it('an empty clipped box gets a single "0", on the main session and on a sub-agent', () => {
    for (const main of [true, false]) {
      expect(feedbackDraftDismissPlan(plain(CLIPPED), stripGhostSuggestion(CLIPPED), main)).toEqual({ act: 'keys', keys: ['0'] })
    }
  })
  it('anything typed in a clipped box is left alone: a "0" that did not fire holds, it never becomes "00"', () => {
    for (const t of ['hello', '0', '000']) {
      const p = withTyped(t)
      expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), false)).toEqual({ act: 'hold', reason: 'input-occupied' })
    }
  })
  it('a dim autosuggest in a clipped box reads as empty', () => {
    const p = withTyped('\x1b[2msuggested earlier prompt\x1b[0m')
    expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), false)).toEqual({ act: 'keys', keys: ['0'] })
  })
  it('two captures of different frames read as unreadable, not as a box', () => {
    expect(feedbackDraftDismissPlan(plain(CLIPPED), stripGhostSuggestion(CLIPPED) + '\nextra row', true)).toEqual({ act: 'hold', reason: 'input-unreadable' })
  })
  it('a rule followed by something other than the prompt is not a box', () => {
    const p = CLIPPED.replace(/❯[\u00a0 ]?(\n?)$/, 'not a prompt$1')
    expect(feedbackDraftDismissPlan(plain(p), stripGhostSuggestion(p), true)).toEqual({ act: 'none' })
  })
})

describe('the measured 2.1.318 frames', () => {
  it('an empty unclipped card gets the same single "0", never Down (Down left it up, measured)', () => {
    expect(detectPaneState(plain(UNCLIPPED_318))).toBe('idle')
    for (const main of [true, false]) {
      expect(feedbackDraftDismissPlan(plain(UNCLIPPED_318), stripGhostSuggestion(UNCLIPPED_318), main, 600)).toEqual({ act: 'keys', keys: ['0'] })
    }
    // On the main session only once the card was seen 600 ms earlier: a "0" inside
    // the card's ignore window would stay in a box that never gets C-u.
    expect(feedbackDraftDismissPlan(plain(UNCLIPPED_318), stripGhostSuggestion(UNCLIPPED_318), true, 0)).toEqual({ act: 'wait', ms: 600 })
    expect(feedbackDraftDismissPlan(plain(UNCLIPPED_318), stripGhostSuggestion(UNCLIPPED_318), false, 0)).toEqual({ act: 'keys', keys: ['0'] })
  })
  it('with text in the prompt the card is still seen, by its "clear text to ..." option line', () => {
    for (const f of [UNCLIPPED_TYPED_318, CLIPPED_TYPED_318]) {
      expect(plain(f)).toMatch(/│ clear text to review, send, or dismiss/)
      expect(detectsFeedbackDraftModal(plain(f))).toBe(true)
    }
  })
  it('typed text holds in both layouts; a lone leftover "0" holds on the main session and is cleared on a sub-agent', () => {
    for (const f of [UNCLIPPED_TYPED_318, CLIPPED_TYPED_318]) {
      expect(feedbackDraftDismissPlan(plain(f), stripGhostSuggestion(f), true)).toEqual({ act: 'hold', reason: 'input-occupied' })
      const zero = typedAs(f, '0')
      expect(feedbackDraftDismissPlan(plain(zero), stripGhostSuggestion(zero), true)).toEqual({ act: 'hold', reason: 'input-occupied' })
    }
    const zero = typedAs(UNCLIPPED_TYPED_318, '0')
    expect(feedbackDraftDismissPlan(plain(zero), stripGhostSuggestion(zero), false)).toEqual({ act: 'keys', keys: ['C-u', '0'] })
    // The clipped box is never cleared: its rows below the capture are unseen.
    const clippedZero = typedAs(CLIPPED_TYPED_318, '0')
    expect(feedbackDraftDismissPlan(plain(clippedZero), stripGhostSuggestion(clippedZero), false)).toEqual({ act: 'hold', reason: 'input-occupied' })
  })
})

describe('dismissFeedbackDraftModalIfPresent on the clipped card', () => {
  beforeEach(() => { panes.queue = []; panes.last = ''; sent.length = 0; notify.calls.length = 0 })

  it('the main session gets one "0", then Escape on the opt-out question that comes after the debounce', async () => {
    panes.queue = [CLIPPED, CLIPPED, CLIPPED, OPTOUT_PANE, CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent(MAIN_CHANNELS_SESSION)
    expect(sent).toEqual([['0'], ['Escape']])
  })
  it('no opt-out question: the "0" alone, never a second digit or a blind Escape', async () => {
    panes.queue = [CLIPPED, CLEAR_PANE]
    await dismissFeedbackDraftModalIfPresent('agent-sub')
    expect(sent).toEqual([['0']])
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

  const runFor = (session: string) => async (frame: string) => {
    panes.queue = [frame]
    const p = dismissFeedbackDraftModalIfPresent(session)
    await vi.runAllTimersAsync()
    await p
  }

  it('a keystroke plan between two holds starts a new episode: the first hold\'s start never pages', async () => {
    const run = runFor('agent-hold-reset')
    const held = withTyped('a reply the owner is writing')
    await run(held)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS - 60_000)
    await run(CLIPPED)
    expect(sent).toEqual([['0']])
    await run(held)
    vi.advanceTimersByTime(2 * 60_000)
    await run(held)
    expect(notify.calls).toHaveLength(0)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS)
    await run(held)
    expect(notify.calls).toHaveLength(1)
  })

  it('a lone "0" left in a clipped main box (2.1.318 frame) pages once, and the page says to clear it first', async () => {
    const run = runFor(MAIN_CHANNELS_SESSION)
    const zero = typedAs(CLIPPED_TYPED_318, '0')
    await run(zero)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS)
    await run(zero)
    await run(zero)
    expect(notify.calls).toHaveLength(1)
    expect(notify.calls[0]).toContain('csak egy 0 áll, előbb Ctrl-U')
    expect(sent).toEqual([])
  })

  it('text in an unclipped main box (2.1.318 frame) reads as a parked line: no feedback page, the MAIN_PARKED ladder owns it', async () => {
    expect(detectPaneState(plain(UNCLIPPED_TYPED_318))).toBe('typing')
    const run = runFor(MAIN_CHANNELS_SESSION)
    await run(CLEAR_PANE) // a fresh episode: the case above left this session's record notified
    await run(UNCLIPPED_TYPED_318)
    vi.advanceTimersByTime(FEEDBACK_HOLD_OWNER_AFTER_MS * 2)
    await run(UNCLIPPED_TYPED_318)
    await run(UNCLIPPED_TYPED_318)
    expect(notify.calls).toHaveLength(0)
    expect(sent).toEqual([])
  })
})

// When the dismisser's "0" lands inside the card's ignore window anyway, an
// unclipped main box reads 'typing' and the MAIN_PARKED ladder owns it, so the
// lone-0 hint has to ride on that page.
describe('the MAIN_PARKED owner page names a feedback card on the same frame', () => {
  beforeEach(() => { panes.queue = []; panes.last = ''; sent.length = 0; notify.calls.length = 0; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('the hint appears only with the card up, and carries no parked text on a redirected alert', () => {
    const withCard = mainParkedOwnerAlert('main', 6, '0', false, true)
    expect(withCard).toContain('visszajelzés-vázlat kártyája')
    expect(withCard).toContain('ha a parkolt sor csak egy 0')
    expect(withCard).toContain('A parkolt sor eleje: "0"')
    const noCard = mainParkedOwnerAlert('main', 6, '0', false, false)
    expect(noCard).not.toContain('kártya')
    expect(noCard).toContain('Ctrl-C és utána Ctrl-U')
    expect(mainParkedOwnerAlert('main', 6, 'titkos sor', true, true)).not.toContain('titkos sor')
  })

  it('a lone "0" in an unclipped main box under the card (2.1.318 frame): the owner page says it may be the card\'s leftover', async () => {
    const zero = typedAs(UNCLIPPED_TYPED_318, '0')
    expect(detectPaneState(plain(zero))).toBe('typing')
    panes.last = zero
    for (let i = 0; i < MAIN_PARKED_OWNER_AFTER + 1; i++) {
      const p = clearStaleParkedInput(MAIN_CHANNELS_SESSION)
      await vi.runAllTimersAsync()
      await p
      vi.advanceTimersByTime(31_000)
    }
    expect(notify.calls).toHaveLength(1)
    expect(notify.calls[0]).toContain('input-mezőjében')
    expect(notify.calls[0]).toContain('ha a parkolt sor csak egy 0')
    expect(sent).toEqual([])
  })
})
