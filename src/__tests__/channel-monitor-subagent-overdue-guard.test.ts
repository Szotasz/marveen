import { describe, it, expect } from 'vitest'
import { shouldAlertStuckSubAgent, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS } from '../web/channel-monitor.js'
import type { StuckInputState } from '../pane-state.js'

// Sub-agent overdue-guard, level 1: sub-agent sessions get
// the same soft recovery as the main channel (recoverStuckInputForSession,
// MAIN_STUCK_THRESHOLDS) but had NO further escalation once that recovery
// exhausted -- a wedged sub-agent just sat silently until a human noticed.
// This decision function is the ALERT-ONLY gate added to close that gap
// (level 2, an automatic respawn-pane for sub-agents, was explicitly
// deferred -- a sub-agent restart has no resume path back to its
// in-progress delegated task).

const NO_SPELL: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
const MAX_ATTEMPTS = 4

function spell(attempts: number): StuckInputState {
  return { parkedSig: 'sig', firstSeenAt: 1_000, lastRecoverAt: 1_000, attempts }
}

describe('shouldAlertStuckSubAgent', () => {
  it('never alerts when there is no active spell', () => {
    expect(shouldAlertStuckSubAgent(NO_SPELL, MAX_ATTEMPTS, 0, 1_000_000, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(false)
  })

  it('does not alert while attempts are still below the soft-recovery cap', () => {
    expect(shouldAlertStuckSubAgent(spell(3), MAX_ATTEMPTS, 0, 1_000_000, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(false)
  })

  it('alerts once soft recovery is exhausted and no prior alert has fired', () => {
    expect(shouldAlertStuckSubAgent(spell(4), MAX_ATTEMPTS, 0, 1_000_000, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(true)
  })

  it('alerts past the cap too (attempts can exceed maxAttempts while still parked)', () => {
    expect(shouldAlertStuckSubAgent(spell(9), MAX_ATTEMPTS, 0, 1_000_000, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(true)
  })

  it('suppresses a repeat alert inside the rate-limit window', () => {
    const lastAlertedAt = 1_000_000
    const justInside = lastAlertedAt + SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS - 1
    expect(shouldAlertStuckSubAgent(spell(4), MAX_ATTEMPTS, lastAlertedAt, justInside, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(false)
  })

  it('allows a fresh alert once the rate-limit window has fully elapsed', () => {
    const lastAlertedAt = 1_000_000
    const justOutside = lastAlertedAt + SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS
    expect(shouldAlertStuckSubAgent(spell(4), MAX_ATTEMPTS, lastAlertedAt, justOutside, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS)).toBe(true)
  })
})
