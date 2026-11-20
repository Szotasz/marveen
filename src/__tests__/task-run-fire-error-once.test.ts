// TASKRUNERRDUP1109: a scheduled fire that throws AFTER its run row was written is one run, not two. The catch used
// to append a second 'error' row, so one failed attempt counted as two runs on the tasks-today tile.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb, appendTaskRun, countTaskRunsBetween, markTaskRunFireError } from '../db.js'
import { recordFireError } from '../web/schedule-runner.js'

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => { getDb().prepare('DELETE FROM task_runs').run() })

const rows = (name: string) =>
  getDb().prepare('SELECT status, completed_at FROM task_runs WHERE name = ? ORDER BY id').all(name) as Array<{ status: string; completed_at: number | null }>

describe('a failed fire is one error run (TASKRUNERRDUP1109)', () => {
  for (const opened of ['fired', 'fired_late', 'fired_busy']) {
    it(`a throw after the '${opened}' row: that row becomes the closed error, no second row`, () => {
      const start = Date.now() - 1
      const id = appendTaskRun('t-throw', 'agent-a', opened)
      recordFireError('t-throw', 'agent-a', id)
      const r = rows('t-throw')
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('error')
      expect(r[0].completed_at).not.toBeNull()
      expect(countTaskRunsBetween(start)).toBe(1)
    })
  }

  it('a throw before any row: one new error row, as before', () => {
    const start = Date.now() - 1
    recordFireError('t-early', 'agent-a', null)
    expect(rows('t-early').map((r) => r.status)).toEqual(['error'])
    expect(countTaskRunsBetween(start)).toBe(1)
  })

  it('a run id that no longer exists (pruned): falls back to a new error row, never loses the failure', () => {
    expect(markTaskRunFireError(987654321)).toBe(false)
    recordFireError('t-gone', 'agent-a', 987654321)
    expect(rows('t-gone').map((r) => r.status)).toEqual(['error'])
  })

  it('an already-closed row keeps its completed_at', () => {
    const id = appendTaskRun('t-closed', 'agent-a', 'fired')
    getDb().prepare('UPDATE task_runs SET completed_at = 1234 WHERE id = ?').run(id)
    expect(markTaskRunFireError(id)).toBe(true)
    expect(rows('t-closed')).toEqual([{ status: 'error', completed_at: 1234 }])
  })

  it('wiring: attemptFireTask declares firedRunId before its try, and the catch goes through recordFireError', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('async function attemptFireTask('), src.indexOf('export function recordFireError('))
    const decl = fn.indexOf('let firedRunId: number | null = null')
    const tryAt = fn.indexOf('\n  try {')
    expect(decl).toBeGreaterThan(0)
    expect(decl).toBeLessThan(tryAt)
    const catchBlock = fn.slice(fn.lastIndexOf('} catch (err) {'))
    expect(catchBlock).toContain('recordFireError(task.name, agentName, firedRunId)')
    expect(catchBlock).not.toContain("appendTaskRun(task.name, agentName, 'error')")
  })
})
