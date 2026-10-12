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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatStuckSessionAlert, quotaWallEscalation, shouldEscalateStuckSession, type QuotaWallAlertRecord } from '../web/message-router.js'
import { detectPaneState, detectQuotaWall } from '../pane-state.js'

const MAIN = 'marveen'

const SEP = '─'.repeat(80)
const MIN = 60 * 1000

// Real pane shapes, run through detectPaneState rather than passing the
// 'busy' literal directly -- the escalation is only as good as the detection
// that feeds it, and a test that hands in the answer would pass even if the
// pane were read wrong.
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const IDLE_PANE = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

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

  it('says "working, do not restart" when the pane was busy', () => {
    // A busy-pane alert that reads like the wedged one gets acted on like the
    // wedged one. It has to name what it actually saw.
    const alert = formatStuckSessionAlert('prisma', MAIN, 'agent-prisma', 35 * MIN, 2, 'busy')!
    expect(alert).toContain('BUSY')
    expect(alert).toContain('Do NOT restart on this alert alone')
    expect(alert).not.toContain('restart the agent if it is wedged')
  })
})

// Card 41a0c3a3: the alert says WHICH of the four pane classes it saw --
// permission prompt, plan usage limit, busy, anything else -- so the diagnosis
// does not start from a guess. The wall comes from the live capture, read by
// the real detectors, not from a hand-made object.
const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const WALL = detectQuotaWall(WALL_PANE)
const ASK = { title: 'Bash command', reason: 'Dangerous rm operation on possibly-empty variable path' }

describe('formatStuckSessionAlert: one class per pane state (card 41a0c3a3)', () => {
  it('quota wall: names the limit and the reset time, and does not advise a restart', () => {
    expect(WALL).not.toBeNull()
    const alert = formatStuckSessionAlert('tester', MAIN, 'agent-tester', 12 * MIN, 3, detectPaneState(WALL_PANE), false, null, WALL)!
    expect(alert).toContain('[session-stuck]')
    expect(alert).toContain('PLAN USAGE LIMIT')
    expect(alert).toContain('resumes by itself at 6:20pm')
    expect(alert).toContain('Usage limit reached · limit resets 6:20pm')
    expect(alert).toContain('a restart on the same key does not lift the limit')
    expect(alert).not.toContain('restart the agent if it is wedged')
  })

  it('quota wall without a printed time says so instead of inventing one', () => {
    const alert = formatStuckSessionAlert('tester', MAIN, 'agent-tester', 12 * MIN, 1, 'idle', false, null, { banner: '⚠ Usage limit reached', resetsAt: null })!
    expect(alert).toContain('The banner does not say when it resets')
    expect(alert).not.toContain('resumes by itself at')
  })

  it('the four classes produce four different texts', () => {
    const permission = formatStuckSessionAlert('a', MAIN, 's', 12 * MIN, 1, 'unknown', true, ASK)!
    const wall = formatStuckSessionAlert('a', MAIN, 's', 12 * MIN, 1, 'idle', false, null, WALL)!
    const busy = formatStuckSessionAlert('a', MAIN, 's', 31 * MIN, 1, 'busy')!
    const other = formatStuckSessionAlert('a', MAIN, 's', 12 * MIN, 1, 'unknown')!
    expect(permission).toContain('TOOL-PERMISSION PROMPT')
    expect(permission).toContain('It asks: Bash command -- Dangerous rm operation')
    expect(wall).toContain('PLAN USAGE LIMIT')
    expect(busy).toContain('BUSY')
    expect(other).toContain('restart the agent if it is wedged')
    expect(new Set([permission, wall, busy, other]).size).toBe(4)
  })

  it('a permission prompt outranks a wall banner, and a busy pane outranks it too', () => {
    // A prompt needs an answer from a person whatever else is on the pane; a
    // spinner means the session is working, which the wall text would misdescribe.
    expect(formatStuckSessionAlert('a', MAIN, 's', 12 * MIN, 1, 'unknown', true, ASK, WALL)).toContain('TOOL-PERMISSION PROMPT')
    expect(formatStuckSessionAlert('a', MAIN, 's', 31 * MIN, 1, 'busy', false, null, WALL)).toContain('BUSY')
  })
})

describe('quotaWallEscalation: one alert per wall, today\'s cadence for everything else', () => {
  const T0 = Date.UTC(2026, 8, 30, 16, 14, 0)

  // Replays the router's cadence: an escalation check every 11 minutes (the
  // 10 min window plus the tick), the record kept exactly as the router keeps it.
  function replay(wallAt: (t: number) => typeof WALL, minutes: number, opts: { permission?: boolean; paneState?: 'idle' | 'busy' } = {}): number[] {
    let prev: QuotaWallAlertRecord | undefined
    const alerts: number[] = []
    for (let m = 0; m <= minutes; m += 11) {
      const now = T0 + m * MIN
      const step = quotaWallEscalation(wallAt(now), opts.permission ?? false, opts.paneState ?? 'idle', prev, now)
      if (step.kind === 'alert') { prev = { key: step.key, at: now }; alerts.push(m) }
      if (step.kind === 'none') alerts.push(m) // not the wall rule: today's alert at every escalation
    }
    return alerts
  }

  it('the same wall is alerted once, not every escalation window, until it has lasted 5 h', () => {
    const alerts = replay(() => WALL, 6 * 60)
    expect(alerts[0]).toBe(0)
    // Nothing in between: the next one only after the 5 h silence.
    expect(alerts.filter((m) => m < 300)).toEqual([0])
    expect(alerts.length).toBe(2)
    expect(alerts[1]).toBeGreaterThanOrEqual(300)
  })

  it('never more than one wall alert in any 30 minutes, even when the banner changes', () => {
    // A banner whose printed time changes on every check: the worst case for a key-based rule.
    let n = 0
    const alerts = replay(() => ({ banner: '⚠ Usage limit reached', resetsAt: `${(n++ % 12) + 1}pm` }), 6 * 60)
    for (let i = 1; i < alerts.length; i++) expect(alerts[i] - alerts[i - 1]).toBeGreaterThanOrEqual(30)
  })

  it('a new wall (another reset time) after 30 min is alerted', () => {
    const prev: QuotaWallAlertRecord = { key: '6:20pm', at: T0 }
    const next = { banner: '⚠ Usage limit reached · limit resets 11:40pm', resetsAt: '11:40pm' }
    expect(quotaWallEscalation(next, false, 'idle', prev, T0 + 20 * MIN).kind).toBe('silent')
    expect(quotaWallEscalation(next, false, 'idle', prev, T0 + 31 * MIN)).toEqual({ kind: 'alert', key: '11:40pm' })
  })

  it('a permission prompt keeps today\'s cadence: every escalation alerts, wall banner or not', () => {
    expect(replay(() => WALL, 60, { permission: true })).toEqual([0, 11, 22, 33, 44, 55])
  })

  it('a busy pane and a pane without a wall are not touched by the rule', () => {
    expect(quotaWallEscalation(WALL, false, 'busy', undefined, T0)).toEqual({ kind: 'none' })
    expect(quotaWallEscalation(null, false, 'idle', { key: '6:20pm', at: T0 }, T0 + MIN)).toEqual({ kind: 'none' })
  })
})

// A session mid-turn is not ready for a prompt for the same reason a wedged one
// is not, so the queue side alone cannot tell them apart. On 2026-07-31 that
// cost three false alarms in one day, each one a main-agent diagnosis round
// whose answer was "it is working".
describe('shouldEscalateStuckSession: a busy pane is work, not a stall', () => {
  it('does NOT escalate the 2026-07-31 18:56 atlas case (busy pane, 1 pending)', () => {
    // atlas: pane busy with `esc to interrupt` visible, one message queued,
    // not-ready past the 10 min threshold. Alerted; should not have.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 12 * MIN)).toBe(false)
  })

  it('does NOT escalate the 2026-07-31 19:27 prisma case (10 min orientation, 2 pending)', () => {
    // prisma: ten minutes into a long orientation turn, two messages queued.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 10 * MIN + 30_000)).toBe(false)
  })

  it('still escalates a busy pane once the long watchdog passes', () => {
    // A tool call can wedge with the spinner up. Half an hour of busy with mail
    // queued behind it is worth a look either way.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 31 * MIN)).toBe(true)
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 29 * MIN)).toBe(false)
  })

  it('keeps the normal threshold for a pane that is not busy', () => {
    // The 2026-07-27 case this alert exists for: not-ready while NOT working
    // (wedged at 100% context, idle-looking or unreadable pane).
    expect(shouldEscalateStuckSession(detectPaneState(IDLE_PANE), 11 * MIN)).toBe(true)
    expect(shouldEscalateStuckSession(detectPaneState(IDLE_PANE), 9 * MIN)).toBe(false)
  })

  it('treats an unreadable pane as a reason to look sooner, not later', () => {
    // capturePane returns null when the host is down or tmux is gone. Silence
    // is not evidence of work.
    expect(shouldEscalateStuckSession(null, 11 * MIN)).toBe(true)
  })

  it('does not let a quoted "esc to interrupt" in scrollback mute the alert', () => {
    // A watchdog report pasted into the pane must not read as busy -- that
    // would mute the alert on exactly the session discussing stalls.
    const quoted = [
      'The runbook says: "esc to interrupt" means the agent is still working.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldEscalateStuckSession(detectPaneState(quoted), 11 * MIN)).toBe(true)
  })
})
