// The 2026-09-07 lelet: kanban_cards.created_at / updated_at were not all the
// same TYPE. Twelve cards and fifteen comments from one evening carried
// '2026-08-29 18:29:48' -- the output of datetime('now') -- in columns declared
// INTEGER NOT NULL, because SQLite's INTEGER affinity converts a numeric string
// but leaves a datetime string as TEXT.
//
// Why that is worth a trigger: SQLite compares TEXT with INTEGER by type order,
// not by value, so a TEXT row lands on the same side of EVERY sweep and audit
// comparison. It always looks fresh, never looks stuck, and drops out of the
// stale-card detectors with no exception and no log line. The measured proof of
// the mechanism is pinned below, so the reason for the gate cannot be forgotten
// and quietly reverted.
//
// Shape follows the two triggers already on this table: self-healing, NOT a
// CHECK constraint -- agents write here with raw sqlite3 and rarely inspect
// exit codes, so a rejected INSERT would lose the card silently.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const NOW = Math.floor(Date.now() / 1000)

function types(id: string): { created: string; updated: string; created_at: number; updated_at: number } {
  const row = getDb()
    .prepare(`SELECT typeof(created_at) c, typeof(updated_at) u, created_at, updated_at FROM kanban_cards WHERE id = ?`)
    .get(id) as { c: string; u: string; created_at: number; updated_at: number }
  return { created: row.c, updated: row.u, created_at: row.created_at, updated_at: row.updated_at }
}

describe('why the gate exists: a TEXT timestamp is not merely ugly', () => {
  it('compares on the wrong side of every sweep -- text always outranks a number', () => {
    const db = getDb()
    // The exact comparison every stale-card detector makes.
    const stale = db.prepare(`SELECT ('2026-08-29 18:29:48' < strftime('%s','now','-8 minutes')) AS looksStale`)
      .get() as { looksStale: number }
    expect(stale.looksStale).toBe(0)   // an eight-day-old row does NOT look stale
    const realStale = db.prepare(`SELECT (? < strftime('%s','now','-8 minutes')) AS looksStale`)
      .get(NOW - 86400) as { looksStale: number }
    expect(realStale.looksStale).toBe(1) // the same age as an integer does
  })
})

describe('kanban_cards_timestamp_type_gate triggers', () => {
  it('known positive on INSERT: a datetime(\'now\')-shaped write is normalised to an integer', () => {
    getDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-1', 'raw sql card', 'planned', 'normal', datetime('now'), datetime('now'))`
    ).run()

    const t = types('ts-1')
    expect(t.created).toBe('integer')
    expect(t.updated).toBe('integer')
    // and it is the RIGHT integer: datetime('now') is UTC, so it must land
    // within a few seconds of now, not off by a timezone or a Julian day.
    expect(Math.abs(t.created_at - NOW)).toBeLessThan(120)
  })

  it('known positive on UPDATE: an ad-hoc `SET updated_at = datetime(\'now\')` is normalised too', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-2', 'card', 'planned', 'normal', ?, ?)`
    ).run(NOW, NOW)
    db.prepare(`UPDATE kanban_cards SET updated_at = datetime('now') WHERE id = 'ts-2'`).run()

    const t = types('ts-2')
    expect(t.updated).toBe('integer')
    expect(Math.abs(t.updated_at - NOW)).toBeLessThan(120)
  })

  it('known negative: an ordinary integer write is left byte-identical, no trigger, no drift', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-3', 'card', 'planned', 'normal', ?, ?)`
    ).run(1788721449, 1788721449)
    const after = types('ts-3')
    expect(after).toMatchObject({ created: 'integer', updated: 'integer', created_at: 1788721449, updated_at: 1788721449 })

    // A number must never be handed to strftime: read as a Julian day it would
    // become a date tens of thousands of years out, which is the failure mode
    // a naive "just normalise everything" gate would introduce.
    db.prepare(`UPDATE kanban_cards SET updated_at = ? WHERE id = 'ts-3'`).run(1788800000)
    expect(types('ts-3').updated_at).toBe(1788800000)
  })

  it('a numeric STRING was never the problem -- affinity already converts it', () => {
    getDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-4', 'card', 'planned', 'normal', strftime('%s','now'), strftime('%s','now'))`
    ).run()
    expect(types('ts-4').created).toBe('integer')
  })

  it('unparseable text falls back to now() rather than to NULL, which the column would reject', () => {
    getDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-5', 'card', 'planned', 'normal', 'not a date at all', 'not a date at all')`
    ).run()
    const t = types('ts-5')
    expect(t.created).toBe('integer')
    expect(Math.abs(t.created_at - NOW)).toBeLessThan(120)
  })

  it('does not fight the status trigger: a status flip still bumps updated_at exactly once', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES ('ts-6', 'card', 'planned', 'normal', ?, ?)`
    ).run(NOW - 5000, NOW - 5000)
    db.prepare(`UPDATE kanban_cards SET status = 'done' WHERE id = 'ts-6'`).run()
    const t = types('ts-6')
    expect(t.updated).toBe('integer')
    expect(Math.abs(t.updated_at - NOW)).toBeLessThan(120)
  })
})

// The same defect from the same evening lived in kanban_comments too: fifteen
// TEXT rows beside the twelve card rows. Gating only the cards would leave the
// protection half-built -- and a comment timestamp is what orders a card's
// history, so a TEXT one sorts above every integer sibling and the "newest"
// comment becomes whichever one went in wrong.
describe('kanban_comments_timestamp_type_gate triggers', () => {
  function commentType(id: number): { t: string; created_at: number } {
    const row = getDb().prepare('SELECT typeof(created_at) t, created_at FROM kanban_comments WHERE id = ?')
      .get(id) as { t: string; created_at: number }
    return row
  }

  it('known positive on INSERT: a datetime(\'now\')-shaped comment is normalised', () => {
    const info = getDb().prepare(
      `INSERT INTO kanban_comments (card_id, author, content, created_at)
       VALUES ('c-1', 'agent', 'raw sql comment', datetime('now'))`
    ).run()
    const row = commentType(Number(info.lastInsertRowid))
    expect(row.t).toBe('integer')
    expect(Math.abs(row.created_at - NOW)).toBeLessThan(120)
  })

  it('known positive on UPDATE, and known negative: an integer comment is left alone', () => {
    const db = getDb()
    const info = db.prepare(
      `INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('c-2', 'agent', 'x', ?)`
    ).run(1788721449)
    const id = Number(info.lastInsertRowid)
    expect(commentType(id)).toMatchObject({ t: 'integer', created_at: 1788721449 })

    db.prepare(`UPDATE kanban_comments SET created_at = datetime('now') WHERE id = ?`).run(id)
    const after = commentType(id)
    expect(after.t).toBe('integer')
    expect(Math.abs(after.created_at - NOW)).toBeLessThan(120)
  })

  // The ordering consequence, pinned: this is WHY a comment timestamp's type
  // matters, not just that it is untidy.
  it('a TEXT comment would sort above every integer sibling -- the gate is what stops it', () => {
    const db = getDb()
    db.prepare(`INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('c-3', 'a', 'old', ?)`)
      .run(NOW - 100)
    db.prepare(`INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('c-3', 'a', 'raw', datetime('now', '-30 days'))`)
      .run()
    const newest = db.prepare(
      `SELECT content FROM kanban_comments WHERE card_id = 'c-3' ORDER BY created_at DESC LIMIT 1`
    ).get() as { content: string }
    // Without the gate the 30-day-old raw row would win this ordering.
    expect(newest.content).toBe('old')
  })
})
