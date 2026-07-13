// Contract tests for shouldGiveUpOnInject: an inter-agent tmux-inject failure
// must RETRY across ticks, not silently instant-fail.
//
// Root cause (2026-07-13 incident): message-router's delivery catch block marked
// a message 'failed' on the FIRST sendPromptToSession throw ("Failed to inject
// into tmux session"), with no retry and no signal. A transient throw (the pane
// momentarily un-ready mid-turn) permanently dropped the handoff -- FXShark's
// collector finding to DrCode was lost, and nobody was told, so inter-agent
// comms silently wedged.
//
// Fix: an inject throw is treated as transient -- the message stays pending and
// retries next tick -- and is only marked failed (and surfaced to the
// orchestrator) after MAX_INJECT_FAILURES consecutive throws.
// shouldGiveUpOnInject(failCount, maxFailures) is the pure decision extracted
// from the loop body; these tests pin it.

import { describe, it, expect } from 'vitest'
import { shouldGiveUpOnInject } from '../web/message-router.js'

const MAX = 3 // same as MAX_INJECT_FAILURES

describe('shouldGiveUpOnInject: retry transient inject throws before giving up', () => {
  it('keeps retrying (false) below the failure cap', () => {
    // The core invariant: the first throws must NOT drop the message -- this was
    // the bug (instant-fail on attempt 1).
    expect(shouldGiveUpOnInject(1, MAX)).toBe(false)
    expect(shouldGiveUpOnInject(2, MAX)).toBe(false)
  })

  it('gives up (true) once the cap is reached', () => {
    // Only after MAX consecutive throws is the message finally failed + surfaced.
    expect(shouldGiveUpOnInject(3, MAX)).toBe(true)
    expect(shouldGiveUpOnInject(4, MAX)).toBe(true)
  })

  it('reaching the cap is inclusive (>=, not strict >)', () => {
    // failCount === maxFailures gives up, so exactly MAX attempts are made.
    expect(shouldGiveUpOnInject(MAX, MAX)).toBe(true)
    expect(shouldGiveUpOnInject(MAX - 1, MAX)).toBe(false)
  })
})
