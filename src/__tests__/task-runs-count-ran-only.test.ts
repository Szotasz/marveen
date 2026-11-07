import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, appendTaskRun, countTaskRunsBetween } from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

describe('countTaskRunsBetween counts only runs that happened', () => {
  it('counts fired, error and lost runs, and ignores skipped and missed ticks', () => {
    const start = Date.now() - 1
    for (const s of ['fired', 'fired', 'error', 'lost']) appendTaskRun('t-ran', 'agent-a', s)
    for (const s of ['skipped-precheck', 'skipped-precheck', 'skipped', 'skipped-usage-limit', 'skipped-desktop-lock', 'missed']) appendTaskRun('t-skip', 'agent-a', s)
    expect(countTaskRunsBetween(start)).toBe(4)
    expect(countTaskRunsBetween(start, Date.now() + 1000)).toBe(4)
  })

  it('still counts every run in a window with no skipped rows (unchanged for a busy install)', () => {
    getDb().prepare('DELETE FROM task_runs').run()
    const start = Date.now() - 1
    for (let i = 0; i < 5; i++) appendTaskRun('busy', 'agent-a')
    expect(countTaskRunsBetween(start)).toBe(5)
  })
})
