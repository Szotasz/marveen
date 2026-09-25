import { describe, it, expect } from 'vitest'
import { detectPaneState, shouldRetrySubmit } from '../pane-state.js'

// A RUNNING turn read as idle, because the pane had empty rows below it.
//
// #1205 fixed this shape for the prompt probes: every footer window counted back
// from the last LINE of the capture, so a pane drawn high with a blank tail pushed
// the footer out of the window. It converted the six probes that answer "is a
// prompt on screen". It did not convert the two windows in detectPaneState, nor
// the two in shouldRetrySubmit -- the functions that decide whether a pane may be
// written to.
//
// Measured 2026-09-06 on a real `tmux capture-pane` of a busy fleet agent: with an
// 18-line blank tail appended, detectPaneState flipped busy -> idle. The direction
// is the costly one. An idle verdict is a licence to deliver, so the router would
// have pushed a message into a live turn, which is the queue-interleaving this
// monitor exists to prevent.
//
// Both windows have to move together. `esc to interrupt` sits on the footer line,
// but the spinner ("✽ Metamorphosing… (2m 0s · ...)") is drawn several lines above
// it, inside the wider busy window and outside the narrow footer one -- so a fix to
// only one of them still misses whichever shape lands in the other.

/** Faithful to a real capture: spinner high, footer last, nothing after it. */
const BUSY_PANE = [
  '  Reading the sprint notes before the merge.',
  '',
  '✽ Metamorphosing… (2m 0s · ↓ 6.4k tokens · still thinking with high effort)',
  '  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s',
  '     current work',
  '',
  '───────────────────────────────────────────────────────────────── Samu ─',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…',
].join('\n')

const BLANK_TAIL = '\n'.repeat(18)

describe('a busy pane with a blank tail below it', () => {
  it('is still busy, exactly as it is without the tail', () => {
    // The control probe is the same pane untailed: without it a green assertion
    // would not distinguish "the tail is handled" from "this fixture never read busy".
    expect(detectPaneState(BUSY_PANE)).toBe('busy')
    expect(detectPaneState(BUSY_PANE + BLANK_TAIL)).toBe('busy')
  })

  it('suppresses a retry submit that would otherwise fire', () => {
    // The assertion has to be discriminating, and `expect(false)` on BUSY_PANE is not:
    // shouldRetrySubmit returns false there for several reasons at once, so reverting
    // the window would not move it. Measured -- that first version of this test
    // survived the mutation, which is the same decorative-assertion class the busy
    // check itself is about.
    //
    // This pane instead takes the retry's path 1: a pending-paste placeholder in the
    // input box, which returns true UNLESS the busy check stops it first. So the busy
    // verdict is the only thing standing between a live turn and a clear-and-resend.
    const hint = 'a payload hint long enough to clear the minimum'
    const busyWithPlaceholder = [
      '  Reading the sprint notes before the merge.',
      '',
      '✽ Brewing… (52s · ↓ 2.6k tokens)',
      '',
      '────────────────────────────────────────────────────────────────────────',
      '❯ [Pasted text #1 +214 lines]',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')

    // Control: the same pane with the spinner removed DOES retry, which is what makes
    // the two assertions below mean something.
    expect(shouldRetrySubmit(busyWithPlaceholder.replace('✽ Brewing… (52s · ↓ 2.6k tokens)', ''), hint)).toBe(true)

    expect(shouldRetrySubmit(busyWithPlaceholder, hint)).toBe(false)
    expect(shouldRetrySubmit(busyWithPlaceholder + BLANK_TAIL, hint)).toBe(false)
  })

  it('suppresses the same retry when the footer carries the signal instead', () => {
    // The retry has TWO live windows and they catch different shapes, so each needs
    // its own input class. Without this case, reverting the footer window alone left
    // the suite green -- the fixture above answers only for the spinner window.
    //
    // This is the shape of the real capture: no spinner line matched, and
    // `esc to interrupt` sitting on the footer line as the only evidence of a turn.
    const hint = 'a payload hint long enough to clear the minimum'
    const footerOnly = [
      '  Reading the sprint notes before the merge.',
      '',
      '────────────────────────────────────────────────────────────────────────',
      '❯ [Pasted text #1 +214 lines]',
      '────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for ag…',
    ].join('\n')

    expect(shouldRetrySubmit(footerOnly.replace(' · esc to interrupt · ← for ag…', ''), hint)).toBe(true)
    expect(shouldRetrySubmit(footerOnly, hint)).toBe(false)
    expect(shouldRetrySubmit(footerOnly + BLANK_TAIL, hint)).toBe(false)
  })

  it('stays busy when only the spinner carries the signal', () => {
    // Both windows have to move, not just the footer one. Here the footer carries
    // no `esc to interrupt`, so the verdict rests on the spinner line drawn several
    // rows higher -- inside the wider busy window, outside the narrow footer one.
    //
    // The spinner form here is the sub-minute one, `(52s · ↓ 2.6k tokens)`, and that
    // is deliberate. The real capture this fixture came from read
    // `(2m 0s · ↓ 6.4k tokens · still thinking with high effort)`, which BUSY_INDICATORS
    // does not match at all: the pattern requires `\(\s*\d+s` and a minute-form
    // duration puts `2m ` in between. That is a separate defect from the blank tail,
    // it is filed on its own, and it is not what this test measures -- using the
    // unmatched form here would have made this assertion pass for the wrong reason.
    const spinnerOnly = BUSY_PANE
      .replace('✽ Metamorphosing… (2m 0s · ↓ 6.4k tokens · still thinking with high effort)',
               '✽ Brewing… (52s · ↓ 2.6k tokens)')
      .replace(' · esc to interrupt · ← for ag…', '')
    expect(spinnerOnly).not.toContain('esc to interrupt')
    expect(detectPaneState(spinnerOnly)).toBe('busy')
    expect(detectPaneState(spinnerOnly + BLANK_TAIL)).toBe('busy')
  })
})
