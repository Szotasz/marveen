// KARTYAFRISSMEZO912: the updated_at bump trigger covered ONLY the status
// column. Measured instance (2026-09-12): MIOORSZEM831's title was rewritten
// (the title gate even logged a 371-char title and cut it to 300) while the
// card's updated_at stayed at 2026-09-08 -- a card edited today that the
// table dates four days back. Audits and cleanup rounds bucket on this very
// column, so the half-maintained field lied in both directions: an edited
// card looks stale, and a genuinely stuck card would look fresh after a mere
// title touch.
//
// The fix is kanban_cards_fields_bump_updated_at, the same self-healing shape
// as the status trigger. These tests pin the three properties that make it
// safe, not just the happy path: NULL-safe comparisons (IS NOT, because
// assignee/description are nullable and NULL != 'x' is NULL), respect for a
// writer that already set updated_at, and NO bump on the deliberately
// excluded columns (sort_order = drag reordering, archived_at = the archive
// sweep that MEASURES updated_at -- bumping there would feed it fake
// freshness).

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, getKanbanCard } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const DAY = 86400
const OLD = Math.floor(Date.now() / 1000) - 40 * DAY
const NOWISH = () => Math.floor(Date.now() / 1000) - 5

function insertCard(id: string): void {
  getDb()
    .prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES (?, 'old title', 'planned', 'normal', ?, ?)`
    )
    .run(id, OLD, OLD)
}

describe('kanban_cards_fields_bump_updated_at trigger', () => {
  it('bumps on a raw title edit that does not touch updated_at (the measured MIOORSZEM831 shape)', () => {
    insertCard('t-1')
    getDb().prepare("UPDATE kanban_cards SET title = 'new title' WHERE id = ?").run('t-1')
    expect(getKanbanCard('t-1')!.updated_at).toBeGreaterThanOrEqual(NOWISH())
  })

  it('bumps on a NULL -> value assignee edit (IS NOT, where != would silently skip)', () => {
    insertCard('t-2')
    getDb().prepare("UPDATE kanban_cards SET assignee = 'samu' WHERE id = ?").run('t-2')
    expect(getKanbanCard('t-2')!.updated_at).toBeGreaterThanOrEqual(NOWISH())
  })

  it('bumps on a value -> NULL description edit (the other NULL direction)', () => {
    getDb()
      .prepare(
        `INSERT INTO kanban_cards (id, title, description, status, priority, created_at, updated_at)
         VALUES ('t-3', 'x', 'has text', 'planned', 'normal', ?, ?)`
      )
      .run(OLD, OLD)
    getDb().prepare('UPDATE kanban_cards SET description = NULL WHERE id = ?').run('t-3')
    expect(getKanbanCard('t-3')!.updated_at).toBeGreaterThanOrEqual(NOWISH())
  })

  it('bumps on priority, project and due_date edits', () => {
    for (const [id, set] of [
      ['t-4', "priority = 'high'"],
      ['t-5', "project = 'mio'"],
      ['t-6', "due_date = '2026-10-01'"],
    ] as const) {
      insertCard(id)
      getDb().prepare(`UPDATE kanban_cards SET ${set} WHERE id = ?`).run(id)
      expect(getKanbanCard(id)!.updated_at, id).toBeGreaterThanOrEqual(NOWISH())
    }
  })

  it('does NOT bump a no-op write (same value written back)', () => {
    insertCard('t-7')
    getDb().prepare("UPDATE kanban_cards SET title = 'old title' WHERE id = ?").run('t-7')
    expect(getKanbanCard('t-7')!.updated_at).toBe(OLD)
  })

  it('respects a writer that sets updated_at itself (no double bump, same as the status trigger)', () => {
    insertCard('t-8')
    const chosen = OLD + 12345
    getDb()
      .prepare("UPDATE kanban_cards SET title = 'new', updated_at = ? WHERE id = ?")
      .run(chosen, 't-8')
    expect(getKanbanCard('t-8')!.updated_at).toBe(chosen)
  })

  it('does NOT bump on sort_order (drag reordering renumbers whole columns)', () => {
    insertCard('t-9')
    getDb().prepare('UPDATE kanban_cards SET sort_order = 42 WHERE id = ?').run('t-9')
    expect(getKanbanCard('t-9')!.updated_at).toBe(OLD)
  })

  it('does NOT bump on archived_at (the archive sweep measures updated_at -- fake freshness would feed the instrument)', () => {
    insertCard('t-10')
    getDb()
      .prepare('UPDATE kanban_cards SET archived_at = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), 't-10')
    // getKanbanCard may filter archived rows; read raw to be sure.
    const row = getDb()
      .prepare('SELECT updated_at FROM kanban_cards WHERE id = ?')
      .get('t-10') as { updated_at: number }
    expect(row.updated_at).toBe(OLD)
  })

  it('title-gate truncation path: one real edit with an over-limit title still lands on a fresh, sane timestamp', () => {
    insertCard('t-11')
    const long = 'x'.repeat(371)
    getDb().prepare('UPDATE kanban_cards SET title = ? WHERE id = ?').run(long, 't-11')
    const row = getDb()
      .prepare('SELECT title, updated_at FROM kanban_cards WHERE id = ?')
      .get('t-11') as { title: string; updated_at: number }
    // The gate cut the title AND the edit is dated today -- the measured
    // MIOORSZEM831 instance had exactly this shape with a four-day-old date.
    expect(row.title.length).toBeLessThanOrEqual(300)
    expect(row.updated_at).toBeGreaterThanOrEqual(NOWISH())
  })
})
