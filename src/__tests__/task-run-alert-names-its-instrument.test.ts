import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeInflightPaneAge } from '../web/schedule-runner.js'
import { initDatabase, getDb, appendTaskRun, getTaskRunStatus } from '../db.js'

// SCHEDSORZAR923 (2). The stuck-task alert is driven by the in-memory in-flight
// entry: elapsed = now - injectedAt, and it fires when the pane has been busy
// past the threshold. It knows nothing about the task's own work. The old text
// said "runs for N minutes -- possible hang", which reads as a statement about
// the task; on 2026-09-23 a 3.4-minute finding alerted at 25.5 minutes because
// the pane stayed busy afterwards, and a threshold was raised on such numbers.
// The alert now names its instrument and carries the task_runs row.

const ROOT = join(__dirname, '..', '..')
const RUNNER_SRC = readFileSync(join(ROOT, 'src', 'web', 'schedule-runner.ts'), 'utf-8')
const codeLines = RUNNER_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

describe('describeInflightPaneAge names the instrument and the row', () => {
  const entry = { taskName: 'alkuszoktatas-feedback-figyelo', agentName: 'geri', runId: 48997 }
  it('says the pane has been busy since the injection, that this is NOT the work time, and quotes the row id + status', () => {
    const s = describeInflightPaneAge(entry, 25.5 * 60_000, 'fired')
    expect(s).toContain('injektálása óta a pane 25 perce foglalt')
    expect(s).toContain('NEM a feladat munkaideje')
    expect(s).toContain('task_runs #48997 (fired)')
    expect(s).not.toMatch(/perce fut/)
    expect(s).not.toMatch(/beakadás/)
  })
  it('a busy-pane dispatch shows its status, a run without a row says so', () => {
    expect(describeInflightPaneAge(entry, 60_000, 'fired_busy')).toContain('task_runs #48997 (fired_busy)')
    expect(describeInflightPaneAge({ ...entry, runId: null }, 60_000, null)).toContain('task_runs sor nélkül')
    expect(describeInflightPaneAge(entry, 60_000, null)).toContain('task_runs #48997.')
  })
})

describe('both alert builders use it, and the old wording is gone', () => {
  it('the main-agent notice and the owner alert both call describeInflightPaneAge', () => {
    const notice = codeLines.slice(codeLines.indexOf('function sendTaskInflightMainAgentNotice('), codeLines.indexOf('function sendTaskTimeoutAlert('))
    const alert = codeLines.slice(codeLines.indexOf('function sendTaskTimeoutAlert('), codeLines.indexOf('export const SCHEDULE_TICK_MS'))
    expect(notice).toContain('describeInflightPaneAge(entry, elapsedMs, runStatusOf(entry))')
    expect(alert).toContain('describeInflightPaneAge(entry, elapsedMs, runStatusOf(entry))')
    expect(notice).not.toMatch(/perce fut -- lehetséges beakadás/)
    expect(alert).not.toMatch(/perce fut -- lehetséges beakadás/)
  })
  it('the median line says it is pane time, and still names the median of completed runs', () => {
    expect(codeLines).toMatch(/korábbi befejezett futások mediánja; ez is PANE-IDŐ/)
  })
})

describe('getTaskRunStatus', () => {
  beforeAll(() => { initDatabase(':memory:') })
  beforeEach(() => { getDb().prepare('DELETE FROM task_runs').run() })
  it('returns the dispatch status of the row, null for an unknown id', () => {
    const id = appendTaskRun('t', 'a', 'fired_busy')
    expect(getTaskRunStatus(id)).toBe('fired_busy')
    expect(getTaskRunStatus(id + 1000)).toBeNull()
  })
})
