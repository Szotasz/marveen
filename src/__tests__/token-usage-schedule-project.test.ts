import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  labelScheduleProjects, collectAndCorrelate, correlateWithKanban, parseJsonlFile,
} from '../web/token-usage.js'

/**
 * The second half of the attribution fix (#168).
 *
 * The first half wired the labeller to the timer, which took the 30-day window
 * from 76.5% unattributed to 44.0%. Measuring what was left showed the
 * remainder is not a labelling failure at all: 6542 of the 10402 rows with no
 * project carried a schedule marker naming a schedule that still exists. The
 * runner had said exactly which task each row belonged to; a schedule simply
 * had nowhere to say which project it bills to.
 *
 * So this is not another heuristic. It is the exact half of the pair that was
 * missing, and the rule it must never break is: a schedule that declares no
 * project leaves its rows unattributed.
 */

const T0 = 1_780_000_000

// initDatabase(':memory:') hands back the same handle within a process, so the
// tables are cleared explicitly -- otherwise these pass alone and fail together.
function freshDb() {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM token_usage; DELETE FROM kanban_cards;')
}

function insertUsage(over: {
  title?: string | null; project?: string | null; agent?: string; ts?: number
  source?: string | null; projectSource?: string | null
} = {}) {
  getDb().prepare(`INSERT INTO token_usage
    (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,
     model,task_title,task_source,project,project_source)
    VALUES (?,?,?,1,1,0,0,'claude-opus-5',?,?,?,?)`).run(
    over.agent ?? 'marveen', 's1', over.ts ?? T0,
    over.title ?? null, over.source ?? null, over.project ?? null, over.projectSource ?? null)
}

function rows() {
  return getDb().prepare('SELECT task_title, project, project_source, task_source FROM token_usage').all() as
    { task_title: string | null; project: string | null; project_source: string | null; task_source: string | null }[]
}

describe('labelling schedule-marked rows with their project', () => {
  beforeEach(freshDb)

  it('fills the project a schedule declares, and says where it came from', () => {
    insertUsage({ title: 'support-inbox-figyeles', source: 'schedule_marker' })
    const n = labelScheduleProjects({
      tasks: () => [{ name: 'support-inbox-figyeles', project: 'persistent-cart' }],
    })
    expect(n).toBe(1)
    expect(rows()[0].project).toBe('persistent-cart')
    expect(rows()[0].project_source).toBe('schedule_config')
  })

  it('leaves rows of a schedule that declares no project alone', () => {
    // The whole point: an unattributed row is a gap, an invented bucket is a
    // false line in a cost report. No default, no fallback, no "misc".
    insertUsage({ title: 'dream-engine', source: 'schedule_marker' })
    expect(labelScheduleProjects({ tasks: () => [{ name: 'dream-engine' }] })).toBe(0)
    expect(rows()[0].project).toBeNull()
    expect(rows()[0].project_source).toBeNull()

    expect(labelScheduleProjects({ tasks: () => [{ name: 'dream-engine', project: '   ' }] })).toBe(0)
    expect(rows()[0].project).toBeNull()
  })

  it('never overwrites a project a row already has', () => {
    insertUsage({ title: 'kanban-audit', project: 'marveen', projectSource: 'kanban_correlation' })
    expect(labelScheduleProjects({ tasks: () => [{ name: 'kanban-audit', project: 'peci.io' }] })).toBe(0)
    expect(rows()[0].project).toBe('marveen')
    expect(rows()[0].project_source).toBe('kanban_correlation')
  })

  it('matches the schedule name exactly, not as a substring', () => {
    // A card titled after a schedule ("kanban-audit riport atnezese") is not
    // that schedule's run, and must not inherit its project.
    insertUsage({ title: 'kanban-audit riport atnezese', source: 'kanban_correlation' })
    expect(labelScheduleProjects({ tasks: () => [{ name: 'kanban-audit', project: 'marveen' }] })).toBe(0)
    expect(rows()[0].project).toBeNull()
  })

  it('reports how many rows it filled, so a silent no-op is readable', () => {
    insertUsage({ title: 'memoria-heartbeat' })
    insertUsage({ title: 'memoria-heartbeat', ts: T0 + 60 })
    insertUsage({ title: 'idea-scout', ts: T0 + 120 })
    const n = labelScheduleProjects({
      tasks: () => [
        { name: 'memoria-heartbeat', project: 'marveen' },
        { name: 'idea-scout', project: 'idea-candidate' },
        { name: 'nem-letezo-schedule', project: 'marveen' },
      ],
    })
    expect(n).toBe(3)
  })
})

describe('the exact labeller runs before the guessing one', () => {
  beforeEach(freshDb)

  it('labels schedules first, then correlates the rest by time window', async () => {
    const order: string[] = []
    const res = await collectAndCorrelate({
      collect: async () => { order.push('collect'); return { inserted: 2, files: 1 } },
      labelSchedules: () => { order.push('schedule'); return 7 },
      correlate: () => { order.push('correlate') },
    })
    expect(order).toEqual(['collect', 'schedule', 'correlate'])
    expect(res).toEqual({ inserted: 2, files: 1, correlated: true, scheduleLabelled: 7 })
  })

  it('still collects and correlates when the schedule labeller throws', async () => {
    const order: string[] = []
    const res = await collectAndCorrelate({
      collect: async () => { order.push('collect'); return { inserted: 3, files: 2 } },
      labelSchedules: () => { throw new Error('config unreadable') },
      correlate: () => { order.push('correlate') },
    })
    expect(order).toEqual(['collect', 'correlate'])
    expect(res).toEqual({ inserted: 3, files: 2, correlated: true, scheduleLabelled: 0 })
  })
})

describe('the kanban correlation says its project is a guess', () => {
  beforeEach(freshDb)

  // The card has to have moved inside the span of the unlabelled rows -- that
  // window IS the correlation, so a card outside it is simply not a match.
  const MOVED = T0 + 10

  function insertCard(title: string, project: string | null) {
    getDb().prepare(`INSERT INTO kanban_cards (id,title,status,assignee,project,created_at,updated_at)
      VALUES (?,?,'in_progress','marveen',?,?,?)`).run(
      `c${title.length}${project ?? 'x'}`, title, project, T0, MOVED)
  }

  it('stamps kanban_correlation when it writes a project', () => {
    insertCard('Kartya projekttel', 'persistent-cart')
    insertUsage({ ts: MOVED })
    correlateWithKanban()
    expect(rows()[0].project).toBe('persistent-cart')
    expect(rows()[0].project_source).toBe('kanban_correlation')
  })

  it('leaves project_source empty when the card has no project', () => {
    // Otherwise the row would claim to be attributed-by-correlation while the
    // project column is empty -- a provenance for a value that is not there.
    insertCard('Kartya projekt nelkul', null)
    insertUsage({ ts: MOVED })
    correlateWithKanban()
    expect(rows()[0].task_title).toBe('Kartya projekt nelkul')
    expect(rows()[0].project).toBeNull()
    expect(rows()[0].project_source).toBeNull()
  })
})

const TMP = mkdtempSync(join(tmpdir(), 'marveen-tu-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('a harness-injected user line does not end a scheduled run', () => {
  let seq = 0

  function transcript(userTexts: string[]): string {
    // One scheduled prompt, then the given user lines, each followed by an
    // assistant turn -- so the label of every turn is observable.
    const lines: string[] = []
    let t = 0
    const assistant = () => JSON.stringify({
      type: 'assistant', sessionId: 's1',
      timestamp: new Date(Date.UTC(2026, 7, 9, 9, t++, 0)).toISOString(),
      message: { id: `msg_${t}`, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    })
    lines.push(JSON.stringify({
      type: 'user', sessionId: 's1',
      message: { content: 'The wrapper marks provenance, not distrust. <scheduled-task source="scheduled-task:memoria-heartbeat">\nrun\n</scheduled-task>' },
    }))
    lines.push(assistant())
    for (const text of userTexts) {
      lines.push(JSON.stringify({ type: 'user', sessionId: 's1', message: { content: text } }))
      lines.push(assistant())
    }
    const path = join(TMP, `t${seq++}.jsonl`)
    writeFileSync(path, lines.join('\n') + '\n')
    return path
  }

  it('keeps the label across a system-reminder and a task-notification', async () => {
    // Measured 2026-08-09: 44 rows in the 30-day window lost an exact schedule
    // attribution to one of these two tags, silently -- a dropped label logs
    // nothing and reads exactly like a person having taken over.
    const path = transcript([
      '<system-reminder>\nThe task tools have not been used recently.\n</system-reminder>',
      '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>',
    ])
    const { calls } = await parseJsonlFile(path, 'marveen', 0)
    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.taskTitle)).toEqual(
      ['memoria-heartbeat', 'memoria-heartbeat', 'memoria-heartbeat'])
  })

  it('still ends the run when a person takes over', async () => {
    const path = transcript(['<channel source="plugin:telegram:telegram" chat_id="1">szia</channel>'])
    const { calls } = await parseJsonlFile(path, 'marveen', 0)
    expect(calls.map(c => c.taskTitle)).toEqual(['memoria-heartbeat', null])
  })

  it('ends the run when the reminder is appended to a real message', async () => {
    // The harness appends these blocks to typed messages too. Anchoring the
    // match at the start is what keeps that case a person taking over.
    const path = transcript(['nezd meg a #168-at\n<system-reminder>context</system-reminder>'])
    const { calls } = await parseJsonlFile(path, 'marveen', 0)
    expect(calls.map(c => c.taskTitle)).toEqual(['memoria-heartbeat', null])
  })

  it('starts a new run when a later scheduled prompt arrives', async () => {
    const path = transcript([
      '<system-reminder>noise</system-reminder>',
      'x <scheduled-task source="scheduled-task:kanban-audit">\ngo\n</scheduled-task>',
    ])
    const { calls } = await parseJsonlFile(path, 'marveen', 0)
    expect(calls.map(c => c.taskTitle)).toEqual(
      ['memoria-heartbeat', 'memoria-heartbeat', 'kanban-audit'])
  })
})
