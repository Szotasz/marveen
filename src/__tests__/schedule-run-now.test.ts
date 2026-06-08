import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the "Run now" feature: an operator can fire a scheduled
// task immediately from the dashboard, instead of waiting for its cron (or
// hand-editing the cron to the next minute). It reuses the runner's fire path
// (attemptFireTask), so a stopped agent is auto-started and the prompt is
// queued for delivery just like a real cron fire.

const RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
const ROUTE = readFileSync(join(__dirname, '../web/routes/schedules.ts'), 'utf-8')
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

describe('Run now: runner exports an immediate-fire entry point', () => {
  it('schedule-runner exports runScheduledTaskNow', () => {
    expect(RUNNER).toMatch(/export function runScheduledTaskNow\(/)
  })

  it('a manual run delivers regardless of skipIfBusy (always enqueues on starting/busy)', () => {
    const fn = RUNNER.slice(RUNNER.indexOf('export function runScheduledTaskNow('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    // Reuses the real fire path...
    expect(body).toMatch(/attemptFireTask\(/)
    // ...and queues delivery for both an auto-started ('starting') and a busy
    // session, WITHOUT consulting task.skipIfBusy (that's a cron-cadence knob).
    expect(body).toMatch(/insertPendingTaskRetryIfNew/)
    expect(body).not.toMatch(/task\.skipIfBusy/)
  })
})

describe('Run now: REST route', () => {
  it('schedules route handles POST /api/schedules/{name}/run', () => {
    // The route matcher ends in `/run$/` and delegates to the runner.
    expect(ROUTE).toMatch(/\/run\$\//)
    expect(ROUTE).toMatch(/runScheduledTaskNow/)
  })
})

describe('Run now: dashboard button', () => {
  it('schedule row has a run action wired to the run endpoint', () => {
    expect(APP).toMatch(/data-action="run"/)
    expect(APP).toMatch(/\/api\/schedules\/\$\{encodeURIComponent\(task\.name\)\}\/run/)
  })
})
