// KANBANCTXDEAD824: paragraph-length card titles cost tokens in every agent
// that reads the board. The 2026-08-24 sweep moved the accumulated backlog
// (~1.3 MB of title text) into comments by hand; these triggers automate that
// exact transformation for future writes.
//
// Shape mandated in the GO (Marveen msg 15082): NOT a CHECK constraint --
// agents write this table with raw sqlite3 and rarely inspect exit codes, so
// a rejected INSERT would silently lose the card. The trigger relocates
// instead: full original title into a marked comment on the same card, then
// the title is cut to 300 chars. Known-positive AND known-negative probes are
// part of the contract: a long title must be cut + commented, a normal title
// must pass UNTOUCHED with NO comment.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, getKanbanCard } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const NOW = Math.floor(Date.now() / 1000)

function insertCard(id: string, title: string) {
  getDb()
    .prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at)
       VALUES (?, ?, 'planned', 'normal', ?, ?)`
    )
    .run(id, title, NOW, NOW)
}

function comments(cardId: string): { author: string; content: string }[] {
  return getDb()
    .prepare('SELECT author, content FROM kanban_comments WHERE card_id = ? ORDER BY id')
    .all(cardId) as { author: string; content: string }[]
}

describe('kanban_cards_title_gate triggers', () => {
  it('known positive: a 3000-char INSERT is cut to 300 and the FULL title lands in a marked comment', () => {
    const long = 'X'.repeat(2999) + 'Z' // distinct last char proves the comment holds the WHOLE thing
    insertCard('long-1', long)

    const card = getKanbanCard('long-1')!
    expect(card.title.length).toBe(300)
    expect(card.title.endsWith('…')).toBe(true)
    expect(card.title.startsWith('X'.repeat(299))).toBe(true)

    const cs = comments('long-1')
    expect(cs.length).toBe(1)
    expect(cs[0].author).toBe('cim-kapu (trigger)')
    expect(cs[0].content).toContain('CIM-KAPU TRIGGER')
    expect(cs[0].content).toContain('3000 karakteres')
    expect(cs[0].content.endsWith(long)).toBe(true) // verbatim, nothing lost
  })

  it('known negative: a 100-char INSERT passes untouched, with NO comment', () => {
    const short = 'y'.repeat(100)
    insertCard('short-1', short)

    expect(getKanbanCard('short-1')!.title).toBe(short)
    expect(comments('short-1')).toEqual([])
  })

  it('boundary: exactly 300 chars is untouched (the limit is >300, not >=300)', () => {
    const exact = 'b'.repeat(300)
    insertCard('exact-1', exact)
    expect(getKanbanCard('exact-1')!.title).toBe(exact)
    expect(comments('exact-1')).toEqual([])
  })

  it('UPDATE path: a raw SQL title rewrite over 300 chars is relocated the same way', () => {
    insertCard('upd-1', 'rendes rovid cim')
    const long = 'A'.repeat(500)
    getDb().prepare('UPDATE kanban_cards SET title = ? WHERE id = ?').run(long, 'upd-1')

    const card = getKanbanCard('upd-1')!
    expect(card.title.length).toBe(300)
    const cs = comments('upd-1')
    expect(cs.length).toBe(1)
    expect(cs[0].content.endsWith(long)).toBe(true)
  })

  it('UPDATE path negative: rewriting to a short title neither cuts nor comments', () => {
    insertCard('upd-2', 'elso cim')
    getDb().prepare('UPDATE kanban_cards SET title = ? WHERE id = ?').run('masodik cim', 'upd-2')
    expect(getKanbanCard('upd-2')!.title).toBe('masodik cim')
    expect(comments('upd-2')).toEqual([])
  })

  it('no-op UPDATE of an already-truncated title does not fire again (no duplicate comment)', () => {
    insertCard('noop-1', 'C'.repeat(400))
    const once = getKanbanCard('noop-1')!.title
    // Rewriting the SAME truncated value: WHEN requires NEW.title != OLD.title.
    getDb().prepare('UPDATE kanban_cards SET title = ? WHERE id = ?').run(once, 'noop-1')
    expect(comments('noop-1').length).toBe(1)
  })

  it('regression pin: a legacy long title survives a NON-title UPDATE untouched', () => {
    // The remaining legacy cards still carry >300-char titles (the backlog
    // migration ran BEFORE this trigger existed, and 73 long descriptive
    // titles stayed by decision). The `OF title` clause is the only thing
    // standing between them and a silent truncation on their next status
    // flip -- and it is ONE WORD. If a later edit turns `AFTER UPDATE OF
    // title` into a plain `AFTER UPDATE`, this test is what fails.
    getDb().exec('DROP TRIGGER kanban_cards_title_gate_insert')
    const legacy = 'L'.repeat(2000)
    insertCard('legacy-1', legacy) // insert-trigger dropped -> stays long, like a pre-gate row
    expect(getKanbanCard('legacy-1')!.title).toBe(legacy)

    // update-trigger still installed; a status flip must not touch the title.
    getDb().prepare("UPDATE kanban_cards SET status = 'done' WHERE id = ?").run('legacy-1')

    const card = getKanbanCard('legacy-1')!
    expect(card.status).toBe('done')
    expect(card.title).toBe(legacy)
    expect(comments('legacy-1')).toEqual([])
  })

  it('cannot loop even with recursive triggers enabled: the truncated value is exactly 300', () => {
    // The trigger's own UPDATE writes substr(...,1,299) || '…' = 300 chars,
    // deliberately NOT >300, so a re-fired WHEN clause is false. This test
    // pins the arithmetic that guarantees it.
    getDb().exec('PRAGMA recursive_triggers=ON')
    insertCard('loop-1', 'D'.repeat(1000))
    const card = getKanbanCard('loop-1')!
    expect(card.title.length).toBe(300)
    expect(comments('loop-1').length).toBe(1)
  })
})
