import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeScheduledTasks } from '../web/routes/schedules.js'

// HBSCHEDSZAM903: the heartbeat digest's "enabled schedules" figure was the
// one number the agent computed itself, and it drifted to a 13x error (376
// reported vs 29 real). The counts now come pre-computed from
// GET /api/schedules/summary; these tests pin the counting rule and the
// route's existence.

describe('summarizeScheduledTasks: the counting rule', () => {
  it('an absent enabled field counts as enabled (same rule as the toggle route)', () => {
    expect(summarizeScheduledTasks([{}, { enabled: true }, { enabled: false }])).toEqual({
      total: 3, enabled: 2, disabled: 1,
    })
  })

  it('empty task list yields all zeros, not NaN or negatives', () => {
    expect(summarizeScheduledTasks([])).toEqual({ total: 0, enabled: 0, disabled: 0 })
  })

  it('all-disabled counts to zero enabled', () => {
    expect(summarizeScheduledTasks([{ enabled: false }, { enabled: false }])).toEqual({
      total: 2, enabled: 0, disabled: 2,
    })
  })
})

describe('the summary is served, not recomputed by consumers', () => {
  const ROUTE = readFileSync(join(__dirname, '../web/routes/schedules.ts'), 'utf-8')

  it('GET /api/schedules/summary exists and serves summarizeScheduledTasks(listScheduledTasks())', () => {
    expect(ROUTE).toMatch(/\/api\/schedules\/summary'\s*&&\s*method === 'GET'/)
    expect(ROUTE).toMatch(/summarizeScheduledTasks\(listScheduledTasks\(\)\)/)
  })
})
