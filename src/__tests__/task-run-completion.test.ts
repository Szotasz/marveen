import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Completion bookkeeping for scheduled task runs (2026-08-26).
//
// Before this change `task_runs` only ever recorded how a run was DISPATCHED.
// On a live install that produced 3269 'fired' rows, 113 'skipped', and zero
// completions -- so "still running" and "finished twenty minutes ago" were the
// same row, and the stuck-task alert had nothing to compare against.
//
// The signal was never missing. The post-fire watchdog decides, every 15 s,
// whether the target session has gone idle after a turn -- which is exactly
// "the run finished". It just deleted the map entry instead of writing it down.
//
// These are source-level guards: the db functions need a real SQLite handle and
// the suite refuses to run against a live install, so the behaviour that can be
// pinned here without I/O is the CONTRACT -- that the two ending kinds stay
// distinct, that a run is closed exactly where it is known to have ended, and
// that a restart cannot leave rows open for ever.

const SRC = join(__dirname, '..')
const DB_SRC = readFileSync(join(SRC, 'db.ts'), 'utf-8')
const RUNNER_SRC = readFileSync(join(SRC, 'web', 'schedule-runner.ts'), 'utf-8')
const COMMAND_SRC = readFileSync(join(SRC, 'web', 'command-task.ts'), 'utf-8')

describe('task_runs schema: completion columns are additive', () => {
  it('adds completed_at and outcome without touching status', () => {
    expect(DB_SRC).toMatch(/ALTER TABLE task_runs ADD COLUMN completed_at INTEGER/)
    expect(DB_SRC).toMatch(/ALTER TABLE task_runs ADD COLUMN outcome TEXT/)
    // status keeps its original meaning and default; rewriting it would
    // invalidate every historical row and every existing query.
    expect(DB_SRC).toMatch(/ALTER TABLE task_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'fired'/)
  })

  it('indexes the open-run lookup the restart reconcile depends on', () => {
    expect(DB_SRC).toMatch(/idx_task_runs_open ON task_runs\(completed_at, ts\)/)
  })
})

describe('appendTaskRun returns an id', () => {
  it('hands back lastInsertRowid so a run can be closed later', () => {
    expect(DB_SRC).toMatch(/export function appendTaskRun\([^)]*\): number/)
    expect(DB_SRC).toMatch(/return Number\(info\.lastInsertRowid\)/)
  })
})

describe('markTaskRunCompleted is first-writer-wins', () => {
  it('refuses to overwrite an already-closed run', () => {
    // Without the completed_at IS NULL guard a reconcile racing a live sweep
    // could turn a real 'done' into 'interrupted' -- corrupting the very data
    // the change exists to produce.
    expect(DB_SRC).toMatch(/UPDATE task_runs SET completed_at = \?, outcome = \? WHERE id = \? AND completed_at IS NULL/)
  })
})

describe('the two ending kinds stay distinct', () => {
  it('done and abandoned are separate decisions, and clear is gone', () => {
    expect(RUNNER_SRC).toMatch(/export type TaskTimeoutDecision = 'done' \| 'abandoned' \| 'alert' \| 'escalate' \| 'hold' \| 'lost'/)
    // 'clear' merged success with giving-up. If it comes back, completions
    // become unreliable in the one direction that matters. Comment lines are
    // excluded on purpose: the file keeps the historical note explaining what
    // 'clear' used to mean, and that prose is worth more than a tidier regex.
    const codeLines = RUNNER_SRC.split('\n').filter(l => !l.trim().startsWith('//'))
    expect(codeLines.join('\n')).not.toMatch(/return 'clear'/)
  })

  it('max tracking age returns abandoned; idle-after-a-turn returns done', () => {
    expect(RUNNER_SRC).toMatch(/if \(elapsed >= opts\.maxTrackMs\) return 'abandoned'/)
    expect(RUNNER_SRC).toMatch(/if \(entry\.sawTurn\) return 'done'/)
  })
})

describe('every run that opens also closes', () => {
  it('the sweep closes the row it opened, for both ending kinds', () => {
    expect(RUNNER_SRC).toMatch(/decision === 'done' \|\| decision === 'abandoned'/)
    expect(RUNNER_SRC).toMatch(/markTaskRunCompleted\(entry\.runId, decision, now\)/)
  })

  it('the lost path closes the original row too, not just appends a lost one', () => {
    // Otherwise the injection's own row stays open for ever next to its 'lost'
    // sibling, which is the same leak in a different shape.
    expect(RUNNER_SRC).toMatch(/markTaskRunCompleted\(entry\.runId, 'lost', now\)/)
  })

  it('synchronous command tasks close immediately -- the pane watchdog never sees them', () => {
    expect(COMMAND_SRC).toMatch(/markTaskRunCompleted\(runId, "done"\)/)
  })

  it('a restart cannot leave rows open for ever', () => {
    expect(RUNNER_SRC).toMatch(/reconcileOpenTaskRuns\(TASK_FIRE_MAX_TRACK_MS\)/)
    expect(DB_SRC).toMatch(/outcome = 'interrupted'/)
    // 'interrupted', not 'done': after a restart we genuinely do not know.
    expect(DB_SRC).not.toMatch(/outcome = 'done'\s*\n\s*WHERE completed_at IS NULL/)
  })
})

describe('bookkeeping never blocks the task', () => {
  it('a failed completion write is logged, not thrown', () => {
    expect(RUNNER_SRC).toMatch(/Failed to record task-run completion/)
  })
})

describe('the alert can finally say what normal looks like', () => {
  it('the stuck-task alert quotes the median of this task own completed runs', () => {
    expect(DB_SRC).toMatch(/export function getTaskRunMedianDurationMs/)
    expect(RUNNER_SRC).toMatch(/getTaskRunMedianDurationMs\(entry\.taskName\)/)
    expect(RUNNER_SRC).toMatch(/korábbi befejezett futások mediánja/)
  })

  it('stays silent about the median until there is enough history', () => {
    expect(DB_SRC).toMatch(/if \(ds\.length < minSamples\) return null/)
  })
})

describe('history exposes the ending, so a finished run stops looking stuck', () => {
  it('listTaskRunHistory returns completed_at, outcome and duration', () => {
    expect(DB_SRC).toMatch(/completed_at: number \| null/)
    expect(DB_SRC).toMatch(/outcome: string \| null/)
    expect(DB_SRC).toMatch(/duration_ms: completedAt != null \? completedAt - row\.ts : null/)
  })
})
