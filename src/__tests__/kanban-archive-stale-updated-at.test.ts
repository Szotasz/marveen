// kanban 0664aadf: a raw SQL status write that only touches the `status`
// column (no updated_at) leaves the card's OLD updated_at in place. Since
// listKanbanCards()'s auto-archive sweep archives 'done' cards purely by
// comparing updated_at to a cutoff, a card that was just moved to 'done'
// this way looks like it has been sitting untouched for weeks and gets
// archived on the very next page load -- before anyone sees it.
//
// The fix is a self-healing trigger (kanban_cards_status_bumps_updated_at):
// any status-changing UPDATE that leaves updated_at unchanged gets it bumped
// to now. These tests exercise the trigger directly, then the archive sweep
// end-to-end on both sides: a card that just changed via raw SQL (must NOT
// archive) and a genuinely old done card that never changed status this way
// (must still archive -- otherwise this "fix" would just be turning the
// feature off).

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, listKanbanCards, getKanbanCard, createKanbanCard } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const DAY = 86400
const OLD = Math.floor(Date.now() / 1000) - 40 * DAY // older than the 30-day default cutoff

describe('kanban_cards_status_bumps_updated_at trigger', () => {
  it('bumps updated_at when a raw SQL UPDATE changes status without touching updated_at', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('raw-1', 'raw card', 'planned', 'normal', ?, ?)`
    ).run(OLD, OLD)

    db.prepare("UPDATE kanban_cards SET status = 'done' WHERE id = ?").run('raw-1')

    const card = getKanbanCard('raw-1')!
    expect(card.status).toBe('done')
    expect(card.updated_at).toBeGreaterThan(OLD)
    expect(card.updated_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5)
  })

  it('does not touch updated_at when a raw SQL UPDATE sets status to its current value (no-op)', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('raw-2', 'raw card', 'planned', 'normal', ?, ?)`
    ).run(OLD, OLD)

    db.prepare("UPDATE kanban_cards SET status = 'planned' WHERE id = ?").run('raw-2')

    expect(getKanbanCard('raw-2')!.updated_at).toBe(OLD)
  })

  it('does not touch updated_at when the same statement already sets it (normal write path)', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('raw-3', 'raw card', 'planned', 'normal', ?, ?)`
    ).run(OLD, OLD)

    // Mirrors updateKanbanCard/moveKanbanCard: status and updated_at land in
    // the same UPDATE. The trigger's WHEN clause (updated_at unchanged) must
    // not fire here, or it would just be racing production's own timestamp.
    db.prepare("UPDATE kanban_cards SET status = 'done', updated_at = ? WHERE id = ?").run(now, 'raw-3')

    expect(getKanbanCard('raw-3')!.updated_at).toBe(now)
  })
})

describe('listKanbanCards auto-archive vs. raw SQL status writes', () => {
  it('does NOT archive a card moved to done via raw SQL this run, even though its old updated_at predates the cutoff', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('freshly-done', 'old card, just closed', 'planned', 'normal', ?, ?)`
    ).run(OLD, OLD)

    // The exact shape of the bug: status-only raw SQL write, no updated_at.
    db.prepare("UPDATE kanban_cards SET status = 'done' WHERE id = ?").run('freshly-done')

    listKanbanCards()

    expect(getKanbanCard('freshly-done')!.archived_at).toBeNull()
  })

  it('POZ. KONTROLL: still archives a genuinely old done card that never had a status UPDATE', () => {
    const db = getDb()
    // Written 'done' directly at INSERT time (e.g. a seed/import), so the
    // trigger (which only fires on UPDATE OF status) never touched it --
    // this is the case the sweep exists to catch, and must keep catching.
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('genuinely-old', 'old and done', 'done', 'normal', ?, ?)`
    ).run(OLD, OLD)

    listKanbanCards()

    expect(getKanbanCard('genuinely-old')!.archived_at).not.toBeNull()
  })

  it('does not archive a done card moved via the production entry point (createKanbanCard + status: done)', () => {
    createKanbanCard({ id: 'prod-done', title: 'created done today', status: 'done' })

    listKanbanCards()

    expect(getKanbanCard('prod-done')!.archived_at).toBeNull()
  })
})
