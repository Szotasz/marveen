// Contract tests for the card<->card "blocked by" join table.
//
// Same shape as kanban-labels.test.ts: the real db.js entry points against an
// in-memory database seeded with the production schema.
//
// The two behaviours worth locking down are the ones a plain join table does
// NOT give you for free: a link that could never clear (a cycle) must be
// refused, and deleting a card must clear the links pointing AT it, not just
// the ones hanging off it.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, deleteKanbanCard, moveKanbanCard,
  addCardBlocker, removeCardBlocker, getBlockersForCard, getBlockedByCard,
  getBlockersForAllCards, blockerWouldCycle,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('blocker links', () => {
  it('records that A is blocked by B, and the reverse view agrees', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')

    expect(getBlockersForCard('card-a').map((c) => c.id)).toEqual(['card-b'])
    expect(getBlockedByCard('card-b').map((c) => c.id)).toEqual(['card-a'])
    // The reverse of the reverse is empty -- the link has a direction.
    expect(getBlockersForCard('card-b')).toHaveLength(0)
    expect(getBlockedByCard('card-a')).toHaveLength(0)
  })

  it('carries the blocker title and status, so the panel can render a link', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'Ship the thing' })
    addCardBlocker('card-a', 'card-b')
    moveKanbanCard('card-b', 'in_progress', 0)

    expect(getBlockersForCard('card-a')[0]).toMatchObject({
      id: 'card-b', title: 'Ship the thing', status: 'in_progress',
    })
  })

  it('is idempotent -- adding the same link twice keeps one row', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')
    addCardBlocker('card-a', 'card-b')
    expect(getBlockersForCard('card-a')).toHaveLength(1)
  })

  it('removes a single link and reports whether anything was removed', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')

    expect(removeCardBlocker('card-a', 'card-b')).toBe(true)
    expect(getBlockersForCard('card-a')).toHaveLength(0)
    expect(removeCardBlocker('card-a', 'card-b')).toBe(false)
  })

  it('bulk lookup groups blockers by the blocked card', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    createKanbanCard({ id: 'card-c', title: 'C' })
    addCardBlocker('card-a', 'card-b')
    addCardBlocker('card-a', 'card-c')
    addCardBlocker('card-b', 'card-c')

    const map = getBlockersForAllCards()
    expect(map.get('card-a')?.map((c) => c.id).sort()).toEqual(['card-b', 'card-c'])
    expect(map.get('card-b')?.map((c) => c.id)).toEqual(['card-c'])
    expect(map.has('card-c')).toBe(false)
  })
})

describe('cycle guard', () => {
  it('refuses a card blocking itself', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    expect(blockerWouldCycle('card-a', 'card-a')).toBe(true)
  })

  it('refuses a direct back-link (A waits on B, B waits on A)', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')
    expect(blockerWouldCycle('card-b', 'card-a')).toBe(true)
  })

  it('refuses a transitive loop (A->B->C, then C->A)', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    createKanbanCard({ id: 'card-c', title: 'C' })
    addCardBlocker('card-a', 'card-b')
    addCardBlocker('card-b', 'card-c')
    expect(blockerWouldCycle('card-c', 'card-a')).toBe(true)
  })

  it('allows a diamond -- two paths to the same blocker are not a cycle', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    createKanbanCard({ id: 'card-c', title: 'C' })
    createKanbanCard({ id: 'card-d', title: 'D' })
    addCardBlocker('card-a', 'card-b')
    addCardBlocker('card-a', 'card-c')
    addCardBlocker('card-b', 'card-d')
    expect(blockerWouldCycle('card-c', 'card-d')).toBe(false)
  })

  it('terminates on data that already contains a cycle', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    createKanbanCard({ id: 'card-c', title: 'C' })
    // Written straight to the table, bypassing the guard, as a corrupted or
    // hand-edited database could be. The walk must not spin forever on it.
    addCardBlocker('card-a', 'card-b')
    addCardBlocker('card-b', 'card-a')
    expect(blockerWouldCycle('card-c', 'card-a')).toBe(false)
  })
})

describe('deleting a card clears its links in BOTH directions', () => {
  it('drops the links the deleted card owned', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')

    expect(deleteKanbanCard('card-a')).toBe(true)
    expect(getBlockedByCard('card-b')).toHaveLength(0)
  })

  it('drops the links that pointed AT the deleted card', () => {
    // The half that a naive "delete where card_id = ?" would miss: card-a would
    // stay marked "blocked by" a card that no longer exists, and nothing in the
    // UI could clear it.
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    addCardBlocker('card-a', 'card-b')

    expect(deleteKanbanCard('card-b')).toBe(true)
    expect(getBlockersForCard('card-a')).toHaveLength(0)
  })
})
