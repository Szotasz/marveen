// A card whose hex id happens to contain only digits must stay commentable.
//
// resolveKanbanCardRef treats an all-digit ref as a #seq (rowid) because that
// is how humans write card references. Card ids are 8 hex characters, so about
// one id in forty-three is all digits -- and for those cards the seq branch
// looks up a rowid that cannot exist, returns null, and addKanbanComment throws
// "unknown kanban card". The owner hit this on 2026-08-06 with card id
// 03466831: the dashboard showed "Szerver hiba" on every comment attempt, on
// that card only.
//
// The fix keeps seq-first (so "#253" still means the 253rd card) and falls back
// to an exact id match when the seq lookup finds nothing.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, addKanbanComment, getKanbanComments, resolveKanbanCardRef } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('numeric-looking card ids', () => {
  it('resolves an all-digit card id to that card, not to a rowid', () => {
    createKanbanCard({ id: 'aa11bb22', title: 'Első' })
    createKanbanCard({ id: '03466831', title: 'Csak számjegyekből álló id' })

    expect(resolveKanbanCardRef('03466831')).toBe('03466831')
  })

  it('accepts a comment on such a card instead of throwing', () => {
    createKanbanCard({ id: '03466831', title: 'Csak számjegyekből álló id' })

    expect(() => addKanbanComment('03466831', 'marveen', 'megjegyzés')).not.toThrow()
    expect(getKanbanComments('03466831')).toHaveLength(1)
  })

  it('still resolves a short numeric ref as a seq, not as an id', () => {
    // The first created card is rowid 1, so "#1" must mean that card even
    // though no card carries the literal id "1".
    createKanbanCard({ id: 'aa11bb22', title: 'Első' })

    expect(resolveKanbanCardRef('1')).toBe('aa11bb22')
    expect(resolveKanbanCardRef('#1')).toBe('aa11bb22')
  })

  it('prefers the seq reading when both readings could match', () => {
    // Card at rowid 1 has a hex id; a second card is given the literal id "1".
    // "#1" is a human reference to the first card, and must stay that way.
    createKanbanCard({ id: 'aa11bb22', title: 'Első' })
    createKanbanCard({ id: '1', title: 'Furcsa id' })

    expect(resolveKanbanCardRef('1')).toBe('aa11bb22')
  })

  it('returns null for a ref that matches neither reading', () => {
    createKanbanCard({ id: 'aa11bb22', title: 'Első' })

    expect(resolveKanbanCardRef('99999999')).toBeNull()
    expect(resolveKanbanCardRef('nincsilyen')).toBeNull()
  })
})
