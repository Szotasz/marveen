import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, appendTaskRun, markTaskRunCompleted, reconcileOpenTaskRuns, getTaskRunMedianDurationMs } from '../db.js'

// SCHEDSORZAR923. The scheduler's in-flight map is in memory, so a dashboard
// restart loses every open task_run it was tracking and NOTHING else can close
// those rows. The startup reconcile used to close only rows older than the
// 6 h tracking ceiling, so a run that was minutes old at the restart stayed
// open for ever (measured 2026-09-23: hermes-soak-orszem fired 08:34:48, the
// dashboard restarted 08:43:12, the row was still open 4 hours later and fed
// the stuck-run alert). And it stamped completed_at = now, which produced
// 14-16 day "durations" in the 2026-09-10 sweep that a threshold was later
// derived from. Two rules, both asserted here: every open dispatch row is
// closed regardless of age, and the stamp is completed_at = ts (zero
// duration), outcome 'interrupted'.

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => { getDb().prepare('DELETE FROM task_runs').run() })

function backdate(id: number, ageMs: number, now: number): void {
  getDb().prepare('UPDATE task_runs SET ts = ? WHERE id = ?').run(now - ageMs, id)
}
function row(id: number): { ts: number; completed_at: number | null; outcome: string | null; status: string } {
  return getDb().prepare('SELECT ts, completed_at, outcome, status FROM task_runs WHERE id = ?').get(id) as any
}

describe('reconcileOpenTaskRuns closes every orphaned dispatch, regardless of age', () => {
  it('a minutes-old open run is closed too (the case that used to stay open for ever)', () => {
    const now = Date.now()
    const young = appendTaskRun('hermes-soak-orszem', 'samu', 'fired')
    backdate(young, 8 * 60_000, now)
    const old = appendTaskRun('some-task', 'geri', 'fired_late')
    backdate(old, 7 * 3600_000, now)
    const busy = appendTaskRun('busy-task', 'iris', 'fired_busy')
    backdate(busy, 90_000, now)
    expect(reconcileOpenTaskRuns(now)).toBe(3)
    for (const id of [young, old, busy]) {
      const r = row(id)
      expect(r.completed_at, `row ${id} closed`).not.toBeNull()
      expect(r.outcome, `row ${id} outcome`).toBe('interrupted')
    }
  })

  it('the stamp is completed_at = ts: a zero duration, never a "now" that looks measured', () => {
    const now = Date.now()
    const id = appendTaskRun('hermes-soak-orszem', 'samu', 'fired')
    backdate(id, 4 * 3600_000, now)
    reconcileOpenTaskRuns(now)
    const r = row(id)
    expect(r.completed_at).toBe(r.ts)
    expect(r.completed_at! - r.ts).toBe(0)
  })

  it('rows that already closed are untouched, and terminal markers have nothing to close', () => {
    const now = Date.now()
    const done = appendTaskRun('t', 'a', 'fired')
    markTaskRunCompleted(done, 'done', now)
    const before = row(done)
    const lost = appendTaskRun('t', 'a', 'lost')
    expect(reconcileOpenTaskRuns(now)).toBe(0)
    expect(row(done)).toEqual(before)
    expect(row(lost).outcome).not.toBe('interrupted')
  })

  it('an interrupted row never enters the duration median (it is a zero, not a measurement)', () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      const id = appendTaskRun('m', 'a', 'fired')
      backdate(id, 10 * 60_000, now - i * 1000)
      markTaskRunCompleted(id, 'done', now - i * 1000)
    }
    const orphan = appendTaskRun('m', 'a', 'fired')
    backdate(orphan, 30_000, now)
    reconcileOpenTaskRuns(now)
    expect(getTaskRunMedianDurationMs('m')).toBe(10 * 60_000)
  })
})
