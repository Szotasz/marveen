import { describe, it, expect } from 'vitest'
import { detectPaneState, parkedInputText } from '../pane-state.js'
import { parkedClearLevel } from '../web/agent-process.js'

// The stale-parked-input janitor (clearStaleParkedInput in agent-process.ts,
// gated by the message-router) clears a stranded input box ONLY when the pane
// is in the idle 'typing' state. The actual clear does live tmux I/O, but its
// SAFETY CONTRACT is decided entirely by detectPaneState, so we pin that here:
//   - the wedge case (a weak model parked its heartbeat reply) -> 'typing' -> act
//   - an actively processing session                          -> 'busy'   -> skip
//   - a clean idle prompt                                      -> 'idle'   -> no-op
// This is the exact scenario that silenced the DGX darwin channel: a heartbeat
// left "Csendes heartbeat." in the input box, isSessionReadyForPrompt stayed
// false, and every inbound message stranded as pending.

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// The real wedge: a heartbeat response typed into the box but never submitted.
const HEARTBEAT_PARKED = ['', SEP, '❯ Csendes heartbeat.', SEP, FOOTER].join('\n')

// A session actively processing a turn (spinner in the footer region). The
// janitor MUST NOT touch this -- clearing it would clobber real work.
const PROCESSING = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '', SEP, '❯ ', SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// A clean idle prompt: empty box, ready to receive -> nothing to clear.
const IDLE_EMPTY = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

describe('stale-parked-input janitor safety contract', () => {
  it('treats a parked heartbeat line as typing (janitor acts to un-wedge)', () => {
    expect(detectPaneState(HEARTBEAT_PARKED)).toBe('typing')
    expect(parkedInputText(HEARTBEAT_PARKED)).toBe('Csendes heartbeat.')
  })

  it('treats an actively processing session as busy (janitor must skip)', () => {
    expect(detectPaneState(PROCESSING)).toBe('busy')
  })

  it('treats a clean empty prompt as idle (nothing to clear)', () => {
    expect(detectPaneState(IDLE_EMPTY)).toBe('idle')
    expect(parkedInputText(IDLE_EMPTY)).toBeNull()
  })
})

// A box that resists the gentle Ctrl-U / C-a-C-k clear must not back off forever
// (the channel then stays silently wedged). After enough consecutive failed
// windows the un-wedge escalates to the HARD clear (Escape + Backspace burst).
describe('parked-input clear escalation', () => {
  it('uses the gentle clear for the first windows', () => {
    expect(parkedClearLevel(0)).toBe('normal')
    expect(parkedClearLevel(1)).toBe('normal')
  })

  it('escalates to hard clear once the box has resisted enough windows', () => {
    expect(parkedClearLevel(2)).toBe('hard')
    expect(parkedClearLevel(5)).toBe('hard')
  })

  it('honours a custom hardAfter threshold', () => {
    expect(parkedClearLevel(2, 3)).toBe('normal')
    expect(parkedClearLevel(3, 3)).toBe('hard')
  })
})
