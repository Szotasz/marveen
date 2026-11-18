import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideBlockedAlert,
  shouldAnnounceBlockedRecovery,
  describeBlockedTasks,
  emptyBlockedSpell,
  BLOCKED_ALERT_REMINDER_MS,
  type BlockedSpellState,
} from '../web/schedule-runner.js'

// SCHEDBLOCKED1015.
//
// The first half of that card made the bookkeeping honest: a round whose prompt
// was answered by the CLI's own canned refusal (quota limit, API error) is
// recorded 'blocked', not 'done'. The second half is this: somebody has to be
// TOLD. Measured 2026-10-10..10-14 on this install: 133 rounds hit the weekly
// quota wall, 2874 canned replies, three days with zero real turns, and no
// message ever left the machine.
//
// The alert is scoped to the SPELL, not to the round, because a quota limit
// takes every task at once: per-round alerting would have sent 133 messages.

const SRC = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')

function spell(over: Partial<BlockedSpellState> = {}): BlockedSpellState {
  return { ...emptyBlockedSpell(), ...over }
}

describe('decideBlockedAlert', () => {
  it('the first blocked round of a spell always speaks', () => {
    expect(decideBlockedAlert(spell({ firstAt: 1000, count: 1 }), 1000)).toBe('first')
  })

  it('stays silent inside the reminder window, however many rounds fail', () => {
    const s = spell({ firstAt: 0, count: 42, lastAlertAt: 0 })
    expect(decideBlockedAlert(s, BLOCKED_ALERT_REMINDER_MS - 1)).toBe('silent')
  })

  it('reminds once the window has passed, and only then', () => {
    const s = spell({ firstAt: 0, count: 42, lastAlertAt: 0 })
    expect(decideBlockedAlert(s, BLOCKED_ALERT_REMINDER_MS)).toBe('reminder')
    expect(decideBlockedAlert(s, BLOCKED_ALERT_REMINDER_MS * 3)).toBe('reminder')
  })

  // NEGATIVE CONTROL. The defect this guards is not "no alert" but "too many":
  // the measured spell was 133 rounds over four days. With a per-round rule the
  // same window produces 133 messages; with this one it produces the first plus
  // one per six hours. The test fails if someone removes the throttle.
  it('a 133-round, 4-day spell produces a handful of messages, not 133', () => {
    const ORA = 3600_000
    let s = spell()
    let kuldott = 0
    for (let i = 0; i < 133; i++) {
      const now = i * (4 * 24 * ORA / 133)
      if (s.firstAt == null) s.firstAt = now
      s.count += 1
      const d = decideBlockedAlert(s, now)
      if (d !== 'silent') {
        kuldott += 1
        s.lastAlertAt = now
      }
    }
    expect(kuldott).toBeGreaterThan(0)
    expect(kuldott).toBeLessThanOrEqual(4 * 24 / 6 + 1)
    expect(kuldott).toBeLessThan(133)
  })
})

describe('shouldAnnounceBlockedRecovery', () => {
  it('says nothing when there was no spell', () => {
    expect(shouldAnnounceBlockedRecovery(spell())).toBe(false)
  })

  it('says nothing about a spell the owner was never told about', () => {
    // Cannot happen today (the first blocked round always alerts), but if the
    // throttle ever grows a "quiet start", the recovery must not report an
    // outage nobody heard of.
    expect(shouldAnnounceBlockedRecovery(spell({ firstAt: 1, count: 1 }))).toBe(false)
  })

  it('closes a spell it opened', () => {
    expect(shouldAnnounceBlockedRecovery(spell({ firstAt: 1, count: 9, lastAlertAt: 2 }))).toBe(true)
  })
})

describe('describeBlockedTasks', () => {
  it('leads with the worst-hit task and counts repeats', () => {
    const s = describeBlockedTasks({ 'memoria-heartbeat': 7, 'nap-indito': 1 })
    expect(s.startsWith('memoria-heartbeat (7x)')).toBe(true)
    expect(s).toContain('nap-indito')
    expect(s).not.toContain('nap-indito (1x)')
  })

  it('does not print an unbounded list', () => {
    const sok: Record<string, number> = {}
    for (let i = 0; i < 12; i++) sok[`t${i}`] = 12 - i
    const s = describeBlockedTasks(sok, 5)
    expect(s).toContain('es meg 7 feladat')
  })
})

describe('the alert is actually wired to the outcomes (source contract)', () => {
  it('the blocked branch notifies after it records the outcome', () => {
    const i = SRC.indexOf("markTaskRunCompleted(entry.runId, 'blocked', now)")
    const j = SRC.indexOf('noteBlockedRun(entry.taskName')
    expect(i, 'blocked bookkeeping not found').toBeGreaterThan(0)
    expect(j, 'blocked alert call not found').toBeGreaterThan(i)
  })

  it('a genuine done closes the spell, and abandoned does not', () => {
    const i = SRC.indexOf("if (decision === 'done') {")
    const j = SRC.indexOf('noteSuccessfulRun(entry.taskName')
    expect(i).toBeGreaterThan(0)
    expect(j).toBeGreaterThan(i)
    // the call sits inside the done-only branch, before its closing brace
    const branch = SRC.slice(i, SRC.indexOf('\n        }', j))
    expect(branch).toContain('noteSuccessfulRun')
  })

  // The task-timeout alert skips heartbeats on purpose: a long-running
  // heartbeat is self-healing. A quota-blocked one is NOT -- the next
  // occurrence hits the same wall, which is exactly how memoria-heartbeat went
  // missing for four days. This pins that the exclusion was not copied here.
  it('does not exclude heartbeats from the blocked alert', () => {
    const i = SRC.indexOf('export function noteBlockedRun')
    const vege = SRC.indexOf('\n}', SRC.indexOf('sendBlockedSpellMessage(text', i))
    const fn = SRC.slice(i, vege)
    expect(fn).not.toContain("taskType === 'heartbeat'")
  })
})
