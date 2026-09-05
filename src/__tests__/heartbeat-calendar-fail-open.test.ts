import { describe, it, expect } from 'vitest'
import { shouldNotify, buildAgentPrompt } from '../heartbeat.js'
import type { HeartbeatCalendarResult } from '../heartbeat.js'

// 5E0A32B0 #1159 review (Marveen): the code-side heartbeat prompt was the
// SECOND calendar source in the same round, and the one that lied -- a failed
// fetch collapsed to [] and rendered as "Nincs kozelgo esemeny.", while
// shouldNotify saw an empty list and, on a quiet weekday, skipped the round
// entirely: an expired token presented as SILENCE. These are the negative
// controls the review demanded: (a) a failed fetch must never wear the
// free-calendar sentence, (b) it must make an otherwise-quiet round notify.

function data(calendar: HeartbeatCalendarResult, ts: Date) {
  return {
    timestamp: ts,
    calendar,
    kanban: { urgent: 0, in_progress: 0, waiting: 0, urgentLabels: [], waitingLabels: [] },
    system: { dbSizeMB: 50, dbWarning: false },
    tasks: { count: 0, nextRun: null },
  }
}

// Wednesday 10:00 local -- daytime, weekday, nothing else notify-worthy.
const QUIET_WEEKDAY = new Date(2026, 8, 2, 10, 0)

describe('buildAgentPrompt: a failed calendar fetch never reads as a free calendar', () => {
  it('failed fetch: names the failure verbatim, no "Nincs kozelgo esemeny."', () => {
    const prompt = buildAgentPrompt(data({ ok: false, error: 'Token refresh failed: 400' }, QUIET_WEEKDAY))
    expect(prompt).not.toContain('Nincs kozelgo esemeny.')
    expect(prompt).toContain('NAPTAR-LEKERDEZES HIBARA FUTOTT: Token refresh failed: 400')
  })

  it('control: a MEASURED empty calendar still says so', () => {
    const prompt = buildAgentPrompt(data({ ok: true, events: [] }, QUIET_WEEKDAY))
    expect(prompt).toContain('Nincs kozelgo esemeny.')
    expect(prompt).not.toContain('NAPTAR-LEKERDEZES HIBARA FUTOTT')
  })
})

describe('shouldNotify: fail-open on a failed calendar query', () => {
  it('control: the quiet weekday round does NOT notify with a measured-empty calendar', () => {
    expect(shouldNotify(data({ ok: true, events: [] }, QUIET_WEEKDAY))).toBe(false)
  })

  it('the SAME round notifies when the calendar query failed', () => {
    expect(shouldNotify(data({ ok: false, error: 'Token refresh failed: 400' }, QUIET_WEEKDAY))).toBe(true)
  })

  it('the 22:00 curfew still holds: a broken token waits until morning (dbWarning-only window)', () => {
    const night = new Date(2026, 8, 2, 22, 30)
    expect(shouldNotify(data({ ok: false, error: 'Token refresh failed: 400' }, night))).toBe(false)
  })
})
