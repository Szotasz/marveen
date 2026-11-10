import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, appendTaskRun, countTaskRunsBetween } from '../db.js'
import { DIRECT_DIGEST_RUN_STATUS } from '../web/heartbeat-direct-digest.js'

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => { getDb().prepare('DELETE FROM task_runs').run() })

describe('countTaskRunsBetween counts only runs that happened', () => {
  it('counts fired and error runs once each, and ignores skipped ticks, missed slots and a lost follow-up row', () => {
    const start = Date.now() - 1
    for (const s of ['fired', 'fired', 'error']) appendTaskRun('t-ran', 'agent-a', s)
    // A lost injection: the 'fired' row the watchdog closes, then its own 'lost' row.
    appendTaskRun('t-lost', 'agent-a', 'fired')
    appendTaskRun('t-lost', 'agent-a', 'lost')
    for (const s of ['skipped-precheck', 'skipped-precheck', 'skipped', 'skipped-usage-limit', 'skipped-desktop-lock', 'missed']) appendTaskRun('t-skip', 'agent-a', s)
    expect(countTaskRunsBetween(start)).toBe(4)
    expect(countTaskRunsBetween(start, Date.now() + 1000)).toBe(4)
  })

  it('still counts every run in a window with no skipped rows (unchanged for a busy install)', () => {
    const start = Date.now() - 1
    for (let i = 0; i < 5; i++) appendTaskRun('busy', 'agent-a')
    expect(countTaskRunsBetween(start)).toBe(5)
  })
})

describe('countTaskRunsBetween counts each run once: follow-up rows are not new runs', () => {
  it('counts every run-opening status', () => {
    const start = Date.now() - 1
    for (const s of ['fired', 'fired_late', 'fired_busy', DIRECT_DIGEST_RUN_STATUS, 'error']) appendTaskRun('t-open', 'agent-a', s)
    expect(countTaskRunsBetween(start)).toBe(5)
  })

  it('pins the direct digest status the allowlist names', () => {
    expect(DIRECT_DIGEST_RUN_STATUS).toBe('sent-direct')
  })

  it('a lost injection that gives up is one run, not three', () => {
    const start = Date.now() - 1
    appendTaskRun('t-giveup', 'agent-a', 'fired')
    appendTaskRun('t-giveup', 'agent-a', 'lost')
    appendTaskRun('t-giveup', 'agent-a', 'lost-giveup')
    expect(countTaskRunsBetween(start)).toBe(1)
  })

  it('a retry waiting on a missing session adds no run', () => {
    const start = Date.now() - 1
    appendTaskRun('t-missing', 'agent-a', 'fired')
    appendTaskRun('t-missing', 'agent-a', 'missing-retrying')
    expect(countTaskRunsBetween(start)).toBe(1)
  })

  it('a status no writer opens a run with is not counted', () => {
    const start = Date.now() - 1
    appendTaskRun('t-unknown', 'agent-a', 'some-future-status')
    expect(countTaskRunsBetween(start)).toBe(0)
  })
})
