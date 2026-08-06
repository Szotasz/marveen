// Regression tests for the 2026-08-04 "queued messages read as idle" misread.
//
// Claude Code holds prompts typed during a running turn in a QUEUE: the queued
// lines render above the input box and the box itself shows the DIM hint
// "Press up to edit queued messages". Before this fix that shape classified as
// 'typing' (parked text), and idleConsideringDimGhost -- which exists to
// tolerate the dim autocomplete ghost -- stripped the hint and rescued the pane
// to 'idle'. Every writer (inbox-nudge watcher, scheduler, router, keepalive)
// then treated a session with unprocessed input as free and typed another line
// into the same queue.
//
// Observed: the main agent ran a single 32-minute turn while three inbox nudges
// were "sent" into it five minutes apart. All three queued unprocessed, and the
// watcher escalated to the OWNER claiming a broken drain hook / wedged session.
// Nothing was broken and no message was lost -- the session was simply busy.
//
// The captures below are trimmed from the real pane.

import { describe, it, expect } from 'vitest'
import { detectPaneState, paneLooksIdle, idleConsideringDimGhost } from '../pane-state.js'

// Live turn + one queued message. Note where the spinner sits: with the queued
// block rendered it is pushed up, which is why the busy-spinner check alone
// cannot be relied on to catch this state.
const QUEUED_WHILE_BUSY = [
  '           őségét mérlegelnéd. Amit így kaptam: 25 nyitott Lieferschein',
  '',
  '❯ [inbox-wakeup: pending inter-agent messages]',
  '',
  '  Running 1 shell command…',
  '',
  '✳ Forming… (32m 37s · ↓ 76.1k tokens)',
  '  ⎿  Tip: Use /clear to start fresh when switching topics and free up context',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ Press up to edit queued messages',
  '────────────────────────────────────────────────────────────────────────────────',
  '  Opus 5 · ctx 406k/1.0M · 41%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

// Same shape with the spinner scrolled out of the busy window entirely -- the
// state must still be busy on the strength of the queue hint alone.
const QUEUED_NO_SPINNER = [
  '  ⎿  … tool output …',
  '',
  '❯ [inbox-wakeup: pending inter-agent messages]',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ Press up to edit queued messages',
  '────────────────────────────────────────────────────────────────────────────────',
  '  Opus 5 · ctx 406k/1.0M · 41%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

const GENUINELY_IDLE = [
  '  ⎿  … tool output …',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  Opus 5 · ctx 406k/1.0M · 41%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

// SELF-CONTAMINATION control: an incident report (or this very test file, or a
// chat log) quoting the hint lands in the scrollback of some agent's pane. That
// pane is idle and MUST stay idle -- the check is box-scoped for this reason.
const IDLE_WITH_HINT_QUOTED_IN_SCROLLBACK = [
  '  ⎿  jelentes: a doboz ilyenkor a "Press up to edit queued messages"',
  '     szoveget mutatja, ezert olvasta tetlennek a felugyelo.',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────',
  '  Opus 5 · ctx 406k/1.0M · 41%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n')

describe('queued messages are not idle', () => {
  it('classifies a live turn with a queued message as busy', () => {
    expect(detectPaneState(QUEUED_WHILE_BUSY)).toBe('busy')
    expect(paneLooksIdle(QUEUED_WHILE_BUSY)).toBe(false)
  })

  it('stays busy even when the spinner is out of the busy window', () => {
    expect(detectPaneState(QUEUED_NO_SPINNER)).toBe('busy')
  })

  // The heart of the bug: the hint is dim, so the ghost-tolerant readiness
  // check used to strip it and call the session ready. Passing an
  // already-stripped view must NOT rescue a queued pane.
  it('is not rescued by the dim-ghost tolerance', () => {
    const dimStripped = QUEUED_NO_SPINNER.replace('❯ Press up to edit queued messages', '❯ ')
    expect(idleConsideringDimGhost(QUEUED_NO_SPINNER, dimStripped)).toBe(false)
  })

  it('leaves a genuinely idle pane idle', () => {
    expect(detectPaneState(GENUINELY_IDLE)).toBe('idle')
    expect(idleConsideringDimGhost(GENUINELY_IDLE, null)).toBe(true)
  })

  it('does not pin a pane busy because the hint appears in scrollback', () => {
    expect(detectPaneState(IDLE_WITH_HINT_QUOTED_IN_SCROLLBACK)).toBe('idle')
    expect(idleConsideringDimGhost(IDLE_WITH_HINT_QUOTED_IN_SCROLLBACK, null)).toBe(true)
  })
})
