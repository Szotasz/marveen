/**
 * NUDGESHORT1031 follow-up: a short scheduled pointer parked in a box that FITS the pane.
 *
 * 2026-10-31 02:15 (agent-bit, 80x24): the bit-21nap-hang-r2-indito pointer was
 * typed, its Enter did not submit it, and nothing re-pressed Enter. Both
 * recoveries matched typed text against the capture verbatim, and the TUI wraps
 * the box at the pane width with an indented continuation:
 *   - shouldRetrySubmit looks for the first 96 chars, which never fit one row;
 *   - isScheduledPromptStuck looks for the marker, which wrapped as
 *     "[Heartbeat:" / "bit-21nap-hang-r2-indito]".
 * The long prompts before the pointer were taller than the pane and the overfull
 * path caught them, so the blind spot only showed once the prompt got short.
 */
import { describe, it, expect } from 'vitest'
import { decideSubmitFollowup, detectPaneState, shouldRetrySubmit } from '../pane-state.js'
import { isScheduledPromptStuck } from '../web/schedule-runner.js'
import { scheduledTaskReferencePrompt } from '../prompt-safety.js'
import { paneOneLine } from '../web/pane-text.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const MARKER = '[Heartbeat: bit-21nap-hang-r2-indito]'
const TYPED = paneOneLine(scheduledTaskReferencePrompt(
  MARKER,
  '/Users/macmini/marveen/store/scheduled-runs/20261031-021546-bit-21nap-hang-r2-indito-3b6a.md',
  'd4dceb2b65c81c712f5334696d1951c84ece183faca2bddd323b62716af489a4',
  2226,
))
// What sendPromptToSession hands decideSubmitFollowup.
const HINT = TYPED.slice(0, 96)

// Word wrap at the box width, the first row behind the prompt glyph, the rest indented;
// a token longer than a row is cut, as the TUI does.
function box(text: string, width = 76): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    let w = word
    while (w.length > width) { if (row) { rows.push(row); row = '' } rows.push(w.slice(0, width)); w = w.slice(width) }
    if (row && (row + ' ' + w).length > width) { rows.push(row); row = w } else row = row ? row + ' ' + w : w
  }
  if (row) rows.push(row)
  return rows.map((r, i) => (i === 0 ? '❯ ' : '  ') + r)
}

const parked = (rows: string[]) => ['  ● OK', '', SEP, ...rows, SEP, FOOTER, ''].join('\n')
const PARKED = parked(box(TYPED))

describe('a short scheduled pointer parked in a box that fits the pane', () => {
  it('the fixture is the measured shape: parked text, fits 24 rows, the marker split across two rows', () => {
    expect(detectPaneState(PARKED)).toBe('typing')
    expect(PARKED.split('\n').length).toBeLessThanOrEqual(24)
    expect(PARKED).not.toContain(MARKER)
    expect(PARKED).toContain('[Heartbeat:\n  bit-21nap-hang-r2-indito]')
    expect(PARKED).not.toContain(HINT)
  })

  it('the submit retry sees our text and presses Enter again', () => {
    expect(shouldRetrySubmit(PARKED, HINT)).toBe(true)
    expect(decideSubmitFollowup(PARKED, HINT, 0, 3)).toBe('retry-enter')
  })

  it('the resubmit loop reads it as our parked prompt', () => {
    expect(isScheduledPromptStuck(PARKED, MARKER)).toBe(true)
  })

  it('the same when the text starts on the row under an empty prompt row (as seen 02:15)', () => {
    const rows = box(TYPED).map((r, i) => (i === 0 ? '  ' + r.slice(2) : r))
    const pane = parked(['❯ ', ...rows])
    expect(shouldRetrySubmit(pane, HINT)).toBe(true)
    expect(isScheduledPromptStuck(pane, MARKER)).toBe(true)
  })

  it('controls: an empty box, another task, and a human draft that is not our text', () => {
    const empty = parked(['❯ '])
    expect(shouldRetrySubmit(empty, HINT)).toBe(false)
    expect(isScheduledPromptStuck(empty, MARKER)).toBe(false)
    expect(isScheduledPromptStuck(PARKED, '[Heartbeat: memoria-heartbeat]')).toBe(false)
    const draft = parked(box('I was reading the SCHEDULED TASK NOTICE in the log and the block below it looks odd to me'))
    expect(shouldRetrySubmit(draft, HINT)).toBe(false)
    expect(isScheduledPromptStuck(draft, MARKER)).toBe(false)
  })

  it('a busy pane is still left alone', () => {
    const busy = ['  ● OK', '', SEP, ...box(TYPED), SEP, FOOTER + ' · esc to interrupt', ''].join('\n')
    expect(shouldRetrySubmit(busy, HINT)).toBe(false)
    expect(isScheduledPromptStuck(busy, MARKER)).toBe(false)
  })
})
