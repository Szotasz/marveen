import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { correlateWithKanban } from '../web/token-usage.js'

/**
 * `task_title` is written by two things with very different reliability.
 *
 * The transcript parser reads a marker the runner puts into the prompt, so it
 * states what the run was. correlateWithKanban() attributes by time window:
 * every row in a span gets whatever card moved during it, whether or not the
 * work concerned that card. Both land in one column, and a reader cannot tell
 * an exact attribution from a guess -- which is how a heuristic figure ends up
 * inside a cost report presented as fact.
 *
 * `task_source` records which one wrote the label.
 */

const T0 = 1_780_000_000

/**
 * initDatabase(':memory:') does not reliably hand back an empty database when
 * called repeatedly in one process, so rows survive into the next case. That
 * made these tests pass alone and fail together -- the worst failure mode,
 * because it looks like flakiness rather than a setup bug.
 */
function freshDb() {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM token_usage; DELETE FROM kanban_cards;')
}

function insertUsage(over: {
  agent?: string; session?: string; ts?: number; title?: string | null; source?: string | null
} = {}) {
  getDb().prepare(`INSERT INTO token_usage
    (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model,task_title,task_source)
    VALUES (?,?,?,1,1,0,0,'claude-opus-5',?,?)`).run(
    over.agent ?? 'marveen', over.session ?? 's1', over.ts ?? T0,
    over.title ?? null, over.source ?? null)
}

function insertCard(over: { title: string; assignee?: string; updated?: number; project?: string | null }) {
  getDb().prepare(`INSERT INTO kanban_cards (id,title,status,assignee,project,created_at,updated_at)
    VALUES (?,?,'in_progress',?,?,?,?)`).run(
    `c${Math.random().toString(36).slice(2, 9)}`, over.title,
    over.assignee ?? 'marveen', over.project ?? null, over.updated ?? T0, over.updated ?? T0)
}

describe('the column exists and starts empty', () => {
  beforeEach(freshDb)

  it('is added to token_usage', () => {
    const cols = getDb().prepare('PRAGMA table_info(token_usage)').all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('task_source')
  })

  it('is null for a row nobody has attributed', () => {
    insertUsage()
    const r = getDb().prepare('SELECT task_source FROM token_usage').get() as { task_source: string | null }
    expect(r.task_source).toBeNull()
  })
})

describe('kanban correlation stamps its own provenance', () => {
  beforeEach(freshDb)

  it('marks the rows it labels as a correlation, not as fact', () => {
    // The card must move inside the span of the agent's usage rows, or
    // correlateWithKanban() finds no candidate and the test proves nothing.
    insertUsage({ session: 'x', ts: T0 + 10 })
    insertCard({ title: 'Some card', updated: T0 + 10 })
    correlateWithKanban()
    // Scoped to this row: an unscoped .get() picks whichever row is first and
    // would report a leftover from another case instead of this one.
    const r = getDb().prepare("SELECT task_title, task_source FROM token_usage WHERE session_id='x'").get() as
      { task_title: string | null; task_source: string | null }
    expect(r.task_title).toBe('Some card')
    expect(r.task_source).toBe('kanban_correlation')
  })

  it('leaves a marker-labelled row completely alone', () => {
    // Its WHERE already guards on task_title IS NULL. Pinned because losing
    // that guard would let a time-window guess overwrite an exact label, and
    // the row would still look attributed.
    // A second, unlabelled row is needed so the correlation actually runs --
    // otherwise the agent has no uncorrelated span, no card is even fetched,
    // and the assertion would pass without exercising anything.
    insertUsage({ session: 'a', ts: T0 + 10, title: 'memoria-heartbeat', source: 'schedule_marker' })
    insertUsage({ session: 'b', ts: T0 + 20 })
    // The card must move inside the span of the UNLABELLED rows: that span is
    // what correlateWithKanban() computes its candidate window from.
    insertCard({ title: 'Some card', updated: T0 + 20 })
    correlateWithKanban()

    const marker = getDb().prepare("SELECT task_title, task_source FROM token_usage WHERE session_id='a'").get() as
      { task_title: string; task_source: string }
    expect(marker.task_title).toBe('memoria-heartbeat')
    expect(marker.task_source).toBe('schedule_marker')
    // and the correlation did fire on the row that was free to take it
    const other = getDb().prepare("SELECT task_source FROM token_usage WHERE session_id='b'").get() as
      { task_source: string }
    expect(other.task_source, 'the correlation never ran, so this proved nothing').toBe('kanban_correlation')
  })

  it('makes the two kinds separable without matching on task names', () => {
    // The point of the column: before it, telling them apart meant checking
    // whether a title happened to be one of the schedule directory names --
    // which silently misfiles any card that shares a name with a schedule.
    insertUsage({ session: 'a', ts: T0 + 10, title: 'memoria-heartbeat', source: 'schedule_marker' })
    insertUsage({ session: 'b', ts: T0 + 20 })
    insertCard({ title: 'memoria-heartbeat', updated: T0 + 20 })
    correlateWithKanban()
    const rows = getDb().prepare(
      "SELECT task_source, COUNT(*) n FROM token_usage WHERE session_id IN ('a','b') GROUP BY task_source ORDER BY task_source").all() as
      Array<{ task_source: string; n: number }>
    expect(rows).toEqual([
      { task_source: 'kanban_correlation', n: 1 },
      { task_source: 'schedule_marker', n: 1 },
    ])
  })
})
