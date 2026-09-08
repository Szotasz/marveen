// Giving up must not mean going quiet.
//
// When the watchdog hits the restart cap it alerts once and then returns 'skip'
// for ever: the counter only resets when the plugin is seen healthy, and that
// observation never comes because nothing restarts it any more. Finy sat in
// exactly that state from 2026-07-09, one alert and then five days of silence,
// with the dashboard showing 'running' the whole time. The self-sustaining
// deadlock is the bug -- a plugin nobody will retry and nobody will mention.
//
// Two changes are pinned here:
//   1. the give-up state re-announces itself on a cadence while it lasts, and
//   2. a persisted failure count goes stale, so a frozen counter cannot outlive
//      the incident that produced it.

import { describe, it, expect } from 'vitest'
import {
  decideDownAgentAction,
  isFailureCountStale,
  GIVE_UP_REALERT_MS,
  AGENT_FAILURE_COUNT_TTL_MS,
} from '../web/agent-restart-policy.js'

const MAX = 5
const HOUR = 60 * 60 * 1000

// Inputs that would otherwise produce a restart, so every verdict below is
// decided by the cap logic and nothing else.
function base(over: Record<string, unknown> = {}) {
  return {
    processAgeMs: 10 * 60 * 1000,
    msSinceLastRestart: 10 * 60 * 1000,
    startupGraceMs: 60_000,
    restartGraceMs: 90_000,
    msDown: 10 * 60 * 1000,
    downConfirmMs: 60_000,
    ...over,
  }
}

describe('decideDownAgentAction past the restart cap', () => {
  it('still alerts once when the cap is first reached', () => {
    expect(decideDownAgentAction(base({ consecutiveFailures: MAX }), MAX)).toBe('alert')
  })

  it('stays quiet right after that alert', () => {
    const d = decideDownAgentAction(
      base({ consecutiveFailures: MAX + 1, msSinceGiveUpAlert: 60_000 }),
      MAX,
    )
    expect(d).toBe('skip')
  })

  it('speaks again once the re-alert interval has passed', () => {
    const d = decideDownAgentAction(
      base({ consecutiveFailures: MAX + 1, msSinceGiveUpAlert: GIVE_UP_REALERT_MS }),
      MAX,
    )
    expect(d).toBe('alert')
  })

  it('keeps speaking on every later interval, not just the second time', () => {
    const d = decideDownAgentAction(
      base({ consecutiveFailures: MAX + 9, msSinceGiveUpAlert: 5 * GIVE_UP_REALERT_MS }),
      MAX,
    )
    expect(d).toBe('alert')
  })

  it('treats a missing alert timestamp as due -- an unknown last-alert must not buy silence', () => {
    const d = decideDownAgentAction(
      base({ consecutiveFailures: MAX + 1, msSinceGiveUpAlert: null }),
      MAX,
    )
    expect(d).toBe('alert')
  })

  it('re-alerts on the caller-supplied interval when one is given', () => {
    const input = base({ consecutiveFailures: MAX + 1, msSinceGiveUpAlert: 2 * HOUR, giveUpRealertMs: HOUR })
    expect(decideDownAgentAction(input, MAX)).toBe('alert')
    const notYet = base({ consecutiveFailures: MAX + 1, msSinceGiveUpAlert: 30 * 60 * 1000, giveUpRealertMs: HOUR })
    expect(decideDownAgentAction(notYet, MAX)).toBe('skip')
  })

  it('leaves the under-cap paths untouched', () => {
    expect(decideDownAgentAction(base({ consecutiveFailures: 0 }), MAX)).toBe('restart')
    expect(decideDownAgentAction(base({ consecutiveFailures: 1, msDown: 0, downConfirmMs: 60_000 }), MAX)).toBe('skip')
  })

  it('never reaches the give-up branch when the cap is disabled', () => {
    // maxRestartAttempts 0 turns the cap off entirely, so a high failure count
    // is governed by the exponential back-off instead -- 99 failures means a
    // grace window far longer than the elapsed time, hence 'skip'. What matters
    // here is that it is never 'alert': with no cap there is nothing to give up
    // on, so the re-alert cadence must not fire either.
    expect(decideDownAgentAction(base({ consecutiveFailures: 99, msSinceGiveUpAlert: null }), 0)).toBe('skip')
    expect(decideDownAgentAction(base({ consecutiveFailures: 0 }), 0)).toBe('restart')
  })
})

describe('isFailureCountStale', () => {
  const NOW = 1_760_000_000_000

  it('keeps a count that was written inside the window', () => {
    expect(isFailureCountStale(NOW - HOUR, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
  })

  it('drops a count nothing has touched for longer than the window', () => {
    expect(isFailureCountStale(NOW - AGENT_FAILURE_COUNT_TTL_MS - 1, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(true)
  })

  it('treats the boundary as still fresh', () => {
    expect(isFailureCountStale(NOW - AGENT_FAILURE_COUNT_TTL_MS, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
  })

  it('keeps the count when the file time is unreadable -- unknown age is not proof of staleness', () => {
    expect(isFailureCountStale(null, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
    expect(isFailureCountStale(Number.NaN, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
  })

  it('keeps a count whose timestamp is in the future (clock skew), rather than resetting the watchdog', () => {
    // Far enough ahead to exceed the window in absolute terms: a rule written
    // as |now - mtime| > ttl would call this stale, and a restored backup or a
    // corrected clock would silently re-arm restarts on a plugin already given
    // up on. Staleness is about AGE, which is one-directional.
    expect(isFailureCountStale(NOW + AGENT_FAILURE_COUNT_TTL_MS + HOUR, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
    expect(isFailureCountStale(NOW + HOUR, NOW, AGENT_FAILURE_COUNT_TTL_MS)).toBe(false)
  })
})
