// KANBANSTUCKURES916 (#1531 review): the endpoint is only half the fix; the
// kanban-audit skill's step 3 has to CALL it. Reverting the step to the old
// status='in_progress' query used to leave the suite green. This pins the
// shipped SKILL.md: step 3 hits /api/kanban/stuck, the old query is gone from
// the whole skill, and step 3's own Python runs over a real endpoint answer
// (the fields it reads are the ones the endpoint writes).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { initDatabase, getDb, getStuckKanbanCards } from '../db.js'

const SKILL = readFileSync(join(__dirname, '..', '..', 'seed-scheduled-tasks', 'kanban-audit', 'SKILL.md'), 'utf-8')

function step3(): string {
  const start = SKILL.indexOf('3. **Beakadt task detection**')
  const end = SKILL.indexOf('\n4. **', start)
  if (start < 0 || end < 0) throw new Error('step 3 not found in kanban-audit SKILL.md')
  return SKILL.slice(start, end)
}

const OLD_QUERY = /status\s*=\s*'in_progress'|status\s*==\s*['"]in_progress['"]/

describe('kanban-audit step 3 is wired to /api/kanban/stuck', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('step 3 calls the endpoint, and the old in_progress-only query is nowhere in the skill', () => {
    expect(step3()).toContain('/api/kanban/stuck')
    expect(step3()).not.toMatch(OLD_QUERY)
    expect(SKILL).not.toMatch(/WHERE\s+k\.status\s*=\s*'in_progress'/)
  })

  it("step 3's Python reads a real endpoint answer (stuck and waiting groups)", () => {
    const db = getDb()
    const DAY = 86400
    const now = Math.floor(Date.now() / 1000)
    const ins = db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at, dispatched_at, due_date)
       VALUES (?, ?, ?, 'normal', 'Dev', ?, ?, ?, ?)`)
    ins.run('st1', 'beragadt', 'planned', now - 20 * DAY, now - 9 * DAY, now - 20 * DAY, null)
    ins.run('wt1', 'kesik', 'waiting', now - 20 * DAY, now - 20 * DAY, null, now - 3 * DAY)
    const answer = JSON.stringify(getStuckKanbanCards({ plannedDays: 7, activeDays: 3, creatorCommentWindowSec: 600 }))

    const py = step3().match(/python3 -c "\n([\s\S]*?)\n"\n/)
    expect(py, 'python block of step 3').toBeTruthy()
    // the block is written for a shell double-quoted string: undo its \" escapes
    const code = py![1].replace(/\\"/g, '"')
    const res = spawnSync('python3', ['-c', code], { input: answer, encoding: 'utf-8' })
    expect(res.stderr).toBe('')
    expect(res.stdout).toContain('Beakadás: vizsgált=1, találat=1')
    expect(res.stdout).toContain('st1')
    expect(res.stdout).toContain('Várakozó: 1, határidőn túl: 1, határidő nélkül: 0')
    expect(res.stdout).toMatch(/wt1 \| Dev \| 3 nap késés \| kesik/)
  })
})
