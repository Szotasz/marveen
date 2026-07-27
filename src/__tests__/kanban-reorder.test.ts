// Tests for the column-reorder path of moveKanbanCard (orderedIds parameter).
//
// Guards the bug where a dragged card always landed at the bottom of the column
// because only the moved card's sort_order was updated while every other card
// kept its original (potentially conflicting or negative) value.
//
// The fix: when the caller supplies orderedIds (the full column card list in
// desired visual order), moveKanbanCard renumbers ALL cards 0..N in a single
// transaction so the position is stable and unambiguous.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, moveKanbanCard, listKanbanCards, getKanbanCardEvents } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('kanban column reorder via orderedIds', () => {
  it('places the moved card at its target position, not the bottom', () => {
    // Four cards in 'planned', created in natural order; new cards get an
    // incrementing sort_order from the DB, so card-a=0, card-b=1, card-c=2,
    // card-d=3 initially.
    createKanbanCard({ id: 'card-a', title: 'Alpha', status: 'planned' })
    createKanbanCard({ id: 'card-b', title: 'Beta',  status: 'planned' })
    createKanbanCard({ id: 'card-c', title: 'Gamma', status: 'planned' })
    createKanbanCard({ id: 'card-d', title: 'Delta', status: 'planned' })

    // Move card-d from position 3 to position 1 (between card-a and card-b).
    // The frontend sends the full target-column order after the DOM reposition.
    const orderedIds = ['card-a', 'card-d', 'card-b', 'card-c']
    const moved = moveKanbanCard('card-d', 'planned', 1, undefined, orderedIds)
    expect(moved).toBe(true)

    const cards = listKanbanCards().filter(c => c.status === 'planned')
    cards.sort((a, b) => a.sort_order - b.sort_order)
    expect(cards.map(c => c.id)).toEqual(['card-a', 'card-d', 'card-b', 'card-c'])
    // sort_orders must be 0..N -- no gaps, no conflicts
    expect(cards.map(c => c.sort_order)).toEqual([0, 1, 2, 3])
  })

  it('works when cards have negative sort_orders (new-card MIN-1 pattern)', () => {
    // Simulate the real-world state: cards created via /api/kanban get
    // sort_order = MAX(sort_order)+1, which starts at -1 when no cards exist.
    // This used to cause moved cards to always land at the bottom.
    createKanbanCard({ id: 'card-x', title: 'X' })
    createKanbanCard({ id: 'card-y', title: 'Y' })
    // Force negative sort_orders to replicate the bug environment
    moveKanbanCard('card-x', 'planned', -2)
    moveKanbanCard('card-y', 'planned', -1)

    // Move card-y to the top (before card-x)
    const orderedIds = ['card-y', 'card-x']
    moveKanbanCard('card-y', 'planned', 0, undefined, orderedIds)

    const cards = listKanbanCards().filter(c => c.status === 'planned')
    cards.sort((a, b) => a.sort_order - b.sort_order)
    expect(cards.map(c => c.id)).toEqual(['card-y', 'card-x'])
    expect(cards.map(c => c.sort_order)).toEqual([0, 1])
  })

  it('cross-column move with orderedIds changes status and positions correctly', () => {
    createKanbanCard({ id: 'card-1', title: 'One',   status: 'planned' })
    createKanbanCard({ id: 'card-2', title: 'Two',   status: 'planned' })
    createKanbanCard({ id: 'card-3', title: 'Three', status: 'in_progress' })

    // Move card-1 to in_progress, between card-3 (existing) and nothing
    const orderedIds = ['card-3', 'card-1']
    const moved = moveKanbanCard('card-1', 'in_progress', 1, 'tester', orderedIds)
    expect(moved).toBe(true)

    const ipCards = listKanbanCards().filter(c => c.status === 'in_progress')
    ipCards.sort((a, b) => a.sort_order - b.sort_order)
    expect(ipCards.map(c => c.id)).toEqual(['card-3', 'card-1'])
    expect(ipCards.map(c => c.sort_order)).toEqual([0, 1])
  })

  it('records audit event on cross-column move but not on same-column reorder', () => {
    createKanbanCard({ id: 'card-audit', title: 'Audited', status: 'planned' })
    createKanbanCard({ id: 'card-peer',  title: 'Peer',    status: 'planned' })

    // Same-column reorder: no audit event
    moveKanbanCard('card-audit', 'planned', 1, 'tester', ['card-peer', 'card-audit'])
    expect(getKanbanCardEvents('card-audit')).toHaveLength(0)

    // Cross-column move: one audit event
    moveKanbanCard('card-audit', 'in_progress', 0, 'tester', ['card-audit'])
    const events = getKanbanCardEvents('card-audit')
    expect(events).toHaveLength(1)
    expect(events[0].from_status).toBe('planned')
    expect(events[0].to_status).toBe('in_progress')
  })

  it('legacy path (no orderedIds) still works for backward-compatible callers', () => {
    createKanbanCard({ id: 'card-legacy', title: 'Legacy', status: 'planned' })
    const moved = moveKanbanCard('card-legacy', 'waiting', 0, 'scheduler')
    expect(moved).toBe(true)
    const cards = listKanbanCards().filter(c => c.id === 'card-legacy')
    expect(cards[0].status).toBe('waiting')
    expect(cards[0].sort_order).toBe(0)
  })
})
