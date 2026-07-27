// Contract tests for formatStuckSessionAlert: a session continuously not-ready
// past the escalation threshold must produce an ALERT the main agent receives,
// not only a warn log.
//
// Root cause (2026-07-27 incident, card 0a641b52): two messages to prisma sat
// pending for 2.5h while its session was wedged at 100% context. The router
// logged 'session STUCK' at warn level every escalation window -- but the log
// reaches nobody, so the stall was found by hand. The fix routes the same
// escalation into the main agent's inbox as a [session-stuck] message; the
// escalation-window reset in the tick doubles as the notification cooldown.
// formatStuckSessionAlert is the pure decision extracted from the notifier;
// these tests pin it.

import { describe, it, expect } from 'vitest'
import { formatStuckSessionAlert } from '../web/message-router.js'

const MAIN = 'marveen'

describe('formatStuckSessionAlert: silent stall becomes a main-agent alert', () => {
  it('produces a [session-stuck] alert naming agent, session, duration and queue depth', () => {
    const alert = formatStuckSessionAlert('prisma', MAIN, 'agent-prisma', 150 * 60 * 1000, 2)
    expect(alert).not.toBeNull()
    // The marker the main agent's triage keys on.
    expect(alert).toContain('[session-stuck]')
    // Enough to act without a second lookup: who, where, how long, how much is blocked.
    expect(alert).toContain("'prisma'")
    expect(alert).toContain('agent-prisma')
    expect(alert).toContain('150 min')
    expect(alert).toContain('2 pending message(s)')
    // Points at the runbook step rather than leaving "now what".
    expect(alert).toContain('delivery-stall diagnosis')
  })

  it('never alerts the main agent about itself (no self-loop)', () => {
    // Messages TO the main agent use the pull model and never enter the stuck
    // branch; this guards the invariant if that ever changes.
    expect(formatStuckSessionAlert(MAIN, MAIN, 'marveen-channels', 20 * 60 * 1000, 5)).toBeNull()
  })

  it('rounds the stall duration to whole minutes', () => {
    // 11 min 29 s -> 11 min; the alert is triage, not telemetry.
    expect(formatStuckSessionAlert('edina1', MAIN, 'agent-edina1', 689_000, 1)).toContain('11 min')
  })
})
