// Contract tests for the PULL-delivery carve-out.
//
// Root cause, measured on this install 2026-09-20: an agent that runs on its
// OWN machine and claims its messages over the HTTP API has no tmux session
// here, so sessionExistsOnHost() is false forever. The router's abandon gate
// therefore fired on EVERY message to it after the 60-minute window and set
// the row to `failed` -- which removes it from the `status=pending` inbox the
// agent polls. Messages 293, 294, 300, 307 and 308 were all lost this way, and
// the owner had to nudge the recipient over a chat channel each time. The ones
// that did arrive were simply the ones fetched inside that one hour.
//
// The fix leaves such rows pending. The risk it introduces is the mirror image
// -- a queue nobody polls, growing in silence -- so a stale pull row must still
// SAY something, without closing the row. shouldWarnPullStale() is that
// decision, and these tests pin both halves.

import { describe, it, expect } from 'vitest'
import { shouldWarnPullStale, PULL_STALE_WARN_MS } from '../web/message-router.js'

const W = PULL_STALE_WARN_MS
const CREATED = 1_700_000_000_000

describe('shouldWarnPullStale: report a queue nobody polls, without closing the row', () => {
  it('stays quiet inside the window, even with no activity at all', () => {
    // A pull agent is allowed to be away: that is the whole point of the
    // queue. Warning early would just re-create the false alarm the
    // handoff-failure notice used to be.
    expect(shouldWarnPullStale(0, CREATED, null, W)).toBe(false)
    expect(shouldWarnPullStale(W - 1, CREATED, null, W)).toBe(false)
  })

  it('stays quiet at the exact boundary (strict greater-than)', () => {
    expect(shouldWarnPullStale(W, CREATED, null, W)).toBe(false)
  })

  it('warns past the window when the agent has never been seen', () => {
    expect(shouldWarnPullStale(W + 1, CREATED, null, W)).toBe(true)
  })

  it('warns past the window when the last activity predates the message', () => {
    // The agent was alive once, but not since this row was written -- so it
    // has never had the row in front of it.
    expect(shouldWarnPullStale(W + 1, CREATED, CREATED - 1, W)).toBe(true)
    expect(shouldWarnPullStale(W * 10, CREATED, CREATED - 86_400_000, W)).toBe(true)
  })

  it('stays quiet when the agent used the API after the message was written', () => {
    // Evidence of polling. What it then does with the row is its own business:
    // an agent that has seen its inbox and chose not to answer is not a
    // delivery fault, and reporting it as one would be the same invented
    // failure this carve-out removes.
    expect(shouldWarnPullStale(W + 1, CREATED, CREATED + 1, W)).toBe(false)
    expect(shouldWarnPullStale(W * 100, CREATED, CREATED + 1000, W)).toBe(false)
  })

  it('treats activity at the exact creation moment as NOT after it', () => {
    // Same-second activity cannot prove the row was already visible; the
    // conservative reading warns rather than assuming it was seen.
    expect(shouldWarnPullStale(W + 1, CREATED, CREATED, W)).toBe(true)
  })
})
