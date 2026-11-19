import { describe, it, expect } from 'vitest'
import {
  shouldAlertStuckSubAgent, subAgentOverdueAlertText,
  SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS, SUBAGENT_OVERDUE_BUSY_CAP_MS,
} from '../web/channel-monitor.js'
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

// Busy guard (2026-09-11). Parked text behind a live turn is waiting, not
// wedged: suppressed unless the wait passes SUBAGENT_OVERDUE_BUSY_CAP_MS --
// the one case (a turn that long, or a frozen tool call) no sub-agent watchdog
// otherwise covers.
describe('shouldAlertStuckSubAgent: busy guard', () => {
  const I = SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS

  it('a working pane suppresses the alert even with the budget spent', () => {
    const now = 1_000 + SUBAGENT_OVERDUE_BUSY_CAP_MS - 1
    expect(shouldAlertStuckSubAgent(spell(4), MAX_ATTEMPTS, 0, now, I, true)).toBe(false)
  })

  it('a wait behind a live turn past the cap alerts, whatever the attempts', () => {
    const now = 1_000 + SUBAGENT_OVERDUE_BUSY_CAP_MS
    expect(shouldAlertStuckSubAgent(spell(0), MAX_ATTEMPTS, 0, now, I, true)).toBe(true)
  })

  it('the busy-cap alert still honours the rate limit', () => {
    const now = 1_000 + SUBAGENT_OVERDUE_BUSY_CAP_MS + 60_000
    expect(shouldAlertStuckSubAgent(spell(0), MAX_ATTEMPTS, now - I + 1, now, I, true)).toBe(false)
  })

  it('an idle pane keeps the attempts rule unchanged', () => {
    expect(shouldAlertStuckSubAgent(spell(4), MAX_ATTEMPTS, 0, 1_000_000, I, false)).toBe(true)
    expect(shouldAlertStuckSubAgent(spell(3), MAX_ATTEMPTS, 0, 1_000_000, I, false)).toBe(false)
  })
})

// The old text claimed "N automatic attempts" for spells whose every tick was
// a 'hold' (no keystroke at all -- 59 of 63 alerts measured on
// agent-cortex-router, 2026-09-10/11) and suggested `tmux respawn-pane -k`,
// which discards the sub-agent's delegated task in progress.
describe('subAgentOverdueAlertText', () => {
  const base = { label: 'cortex-router', session: 'agent-cortex-router', agentName: 'cortex-router', parkedMs: 5 * 60_000 }

  it('sends the reader to look first and names the managed restart', () => {
    const t = subAgentOverdueAlertText({ ...base, turnInFlight: false })
    expect(t).toContain('`tmux attach -t agent-cortex-router`')
    expect(t).toContain('dolgozik-e az ügynök')
    expect(t).toContain('POST /api/agents/cortex-router/restart')
  })

  it('never recommends respawn-pane -k -- names it only as the move to avoid', () => {
    const t = subAgentOverdueAlertText({ ...base, turnInFlight: false })
    expect(t).not.toMatch(/szükség esetén/)
    expect(t).toMatch(/`tmux respawn-pane -k` kerülendő/)
    expect(subAgentOverdueAlertText({ ...base, turnInFlight: true })).not.toMatch(/respawn-pane/)
  })

  it('states the wait in minutes and claims no attempt count', () => {
    const t = subAgentOverdueAlertText({ ...base, turnInFlight: false })
    expect(t).toContain('kb. 5 perce')
    expect(t).not.toMatch(/próbálkozás/)
  })

  it('the busy variant says the agent is working', () => {
    const t = subAgentOverdueAlertText({ ...base, parkedMs: 31 * 60_000, turnInFlight: true })
    expect(t).toContain('kb. 31 perce')
    expect(t).toContain('dolgozik')
  })

  it('falls back to the session name when the agent name is unknown', () => {
    const t = subAgentOverdueAlertText({ ...base, agentName: null, label: 'agent-x', session: 'agent-x', turnInFlight: false })
    expect(t).not.toContain('/api/agents/')
    expect(t).toContain('`tmux attach -t agent-x`')
  })
})
