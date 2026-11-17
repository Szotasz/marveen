/**
 * "the rescue comment IS the bump".
 *
 * The audit's own procedure says: when you comment on a stuck card, carry the
 * fact of the stall into the comment, so the next round can read back what the
 * detector will no longer hand it. The reasoning is right; the side effect is
 * that the carrying-over bumps updated_at, and the card is not stuck next
 * round -- not because it moved, but because I wrote on it.
 *
 * Measured on three consecutive rounds (2026-10-05 16:03,
 * 10-06 16:12, 10-07 08:0x) each wrote the rescue comment and each reset the
 * idle clock, while the card's REAL age went from 7.0 to 9.6 days and the same
 * two things kept waiting for a human. The card never reached the "3+ stuck ->
 * escalate" threshold either.
 *
 * Two properties here:
 *   1. an `automated` comment does not count as work -- that is what makes a
 *      MARKED rescue comment safe, and it is the half the audit must use; and
 *   2. the real age is available as a second threshold, OFF by default, so
 *      turning it on stays a measured decision rather than a silent change in
 *      how many cards get pinged.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, getStuckKanbanCards } from '../db.js'

const DAY = 86400
const now = () => Math.floor(Date.now() / 1000)

function insertCard(opts: { id: string; status?: string; createdAt: number; updatedAt: number; assignee?: string }) {
  getDb().prepare(
    `INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at)
     VALUES (?, ?, ?, 'normal', ?, ?, ?)`
  ).run(opts.id, `card ${opts.id}`, opts.status ?? 'in_progress', opts.assignee ?? 'Dev', opts.createdAt, opts.updatedAt)
}

function insertComment(cardId: string, createdAt: number, opts: { author?: string; automated?: boolean } = {}) {
  getDb().prepare(`INSERT INTO kanban_comments (card_id, author, content, created_at, automated) VALUES (?, ?, 'note', ?, ?)`)
    .run(cardId, opts.author ?? 'dev', createdAt, opts.automated ? 1 : 0)
}

const OPTS = { plannedDays: 7, activeDays: 3, creatorCommentWindowSec: 600 }

beforeEach(() => { initDatabase(':memory:') })

describe('the audit’s own comment must not hide the card', () => {
  it('an UNMARKED rescue comment by the assignee clears the stall (the bug, pinned as-is)', () => {
    const t = now()
    insertCard({ id: 'c1', createdAt: t - 10 * DAY, updatedAt: t - 1 * DAY })
    insertComment('c1', t - 1 * DAY) // assignee, automated = 0 -> work trace
    const r = getStuckKanbanCards(OPTS)
    expect(r.stuck.map(c => c.id)).not.toContain('c1')
  })

  it('a MARKED (automated) rescue comment leaves the card visible -- this is the fix the audit uses', () => {
    const t = now()
    insertCard({ id: 'c2', createdAt: t - 10 * DAY, updatedAt: t - 1 * DAY })
    insertComment('c2', t - 1 * DAY, { automated: true })
    const r = getStuckKanbanCards(OPTS)
    const card = r.stuck.find(c => c.id === 'c2')
    expect(card).toBeDefined()
    expect(card!.stuck_reason).toBe('idle')
  })

  it('reports the real age next to the idle time, so a report can say both', () => {
    const t = now()
    insertCard({ id: 'c3', createdAt: t - 12 * DAY, updatedAt: t - 5 * DAY })
    const card = getStuckKanbanCards(OPTS).stuck.find(c => c.id === 'c3')!
    expect(card.idle_days).toBe(5)
    expect(card.age_days).toBe(12)
  })
})

describe('max_age_days -- the second threshold', () => {
  it('is OFF by default: a recently-touched old card stays off the list', () => {
    const t = now()
    insertCard({ id: 'c4', createdAt: t - 30 * DAY, updatedAt: t - 1 * 3600 })
    insertComment('c4', t - 1 * 3600)
    expect(getStuckKanbanCards(OPTS).stuck.map(c => c.id)).not.toContain('c4')
  })

  it('catches the same card once configured, and says WHY it is on the list', () => {
    const t = now()
    insertCard({ id: 'c5', createdAt: t - 30 * DAY, updatedAt: t - 1 * 3600 })
    insertComment('c5', t - 1 * 3600)
    const card = getStuckKanbanCards({ ...OPTS, maxAgeDays: 14 }).stuck.find(c => c.id === 'c5')
    expect(card).toBeDefined()
    expect(card!.stuck_reason).toBe('age')
    expect(card!.age_days).toBe(30)
  })

  it('an idle card keeps reading as idle even when both thresholds fire', () => {
    const t = now()
    insertCard({ id: 'c6', createdAt: t - 30 * DAY, updatedAt: t - 20 * DAY })
    const card = getStuckKanbanCards({ ...OPTS, maxAgeDays: 14 }).stuck.find(c => c.id === 'c6')!
    expect(card.stuck_reason).toBe('idle')
  })

  it('a young card is not caught by the age threshold', () => {
    const t = now()
    insertCard({ id: 'c7', createdAt: t - 2 * DAY, updatedAt: t - 1 * 3600 })
    insertComment('c7', t - 1 * 3600)
    expect(getStuckKanbanCards({ ...OPTS, maxAgeDays: 14 }).stuck.map(c => c.id)).not.toContain('c7')
  })
})
