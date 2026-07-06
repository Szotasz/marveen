// Contract tests for the kanban status-change audit trail.
//
// moveKanbanCard records a kanban_card_events row on every REAL status
// transition (who moved the card, when, from/to status). A pure sort_order
// reorder within the same column, or a move that touches no row, records
// nothing. getKanbanCardEvents returns a card's events in chronological order.
//
// These tests call the real production entry points (moveKanbanCard,
// getKanbanCardEvents) on an in-memory database seeded with the production
// schema, the same way the other kanban db tests do.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, moveKanbanCard, getKanbanCardEvents } from '../db.js'

beforeEach(() => {
  // Re-init with an in-memory database for isolation.
  initDatabase(':memory:')
})

describe('kanban move audit trail', () => {
  it('records exactly one event with correct from/to status and actor on a status change', () => {
    createKanbanCard({ id: 'card-a', title: 'Audited card' })

    const moved = moveKanbanCard('card-a', 'in_progress', 1, 'marveen')
    expect(moved).toBe(true)

    const events = getKanbanCardEvents('card-a')
    expect(events).toHaveLength(1)
    expect(events[0].card_id).toBe('card-a')
    expect(events[0].from_status).toBe('planned')
    expect(events[0].to_status).toBe('in_progress')
    expect(events[0].actor).toBe('marveen')
    expect(typeof events[0].created_at).toBe('number')
  })

  it('records no event when the status is unchanged (pure reorder)', () => {
    createKanbanCard({ id: 'card-b', title: 'Reordered card' })

    // Same status (planned), only sort_order differs -> not a transition.
    const moved = moveKanbanCard('card-b', 'planned', 5, 'marveen')
    expect(moved).toBe(true)
    expect(getKanbanCardEvents('card-b')).toHaveLength(0)
  })

  it('records no event when no row matches', () => {
    const moved = moveKanbanCard('nonexistent-card', 'done', 0, 'marveen')
    expect(moved).toBe(false)
    expect(getKanbanCardEvents('nonexistent-card')).toHaveLength(0)
  })

  it('leaves actor null when none is supplied (backward-compatible callers)', () => {
    createKanbanCard({ id: 'card-c', title: 'No actor' })

    const moved = moveKanbanCard('card-c', 'waiting', 0)
    expect(moved).toBe(true)

    const events = getKanbanCardEvents('card-c')
    expect(events).toHaveLength(1)
    expect(events[0].actor).toBeNull()
  })

  it('returns events in chronological order across multiple moves', () => {
    createKanbanCard({ id: 'card-d', title: 'Multi-move card' })

    moveKanbanCard('card-d', 'in_progress', 0, 'marveen')
    moveKanbanCard('card-d', 'waiting', 0, 'samu')
    moveKanbanCard('card-d', 'done', 0, 'marveen')

    const events = getKanbanCardEvents('card-d')
    expect(events.map((e) => e.to_status)).toEqual(['in_progress', 'waiting', 'done'])
    expect(events.map((e) => e.from_status)).toEqual(['planned', 'in_progress', 'waiting'])
    // created_at is monotonically non-decreasing and the id ordering breaks ties.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].created_at).toBeGreaterThanOrEqual(events[i - 1].created_at)
      expect(events[i].id).toBeGreaterThan(events[i - 1].id)
    }
  })
})
