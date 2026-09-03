// Contract tests for the kanban status-change audit trail on the UPDATE path.
//
// moveKanbanCard (the dashboard's drag-and-drop) has always recorded a
// kanban_card_events row. updateKanbanCard -- the path behind PUT
// /api/kanban/:id, which is what every agent and every script uses -- recorded
// none. Measured 2026-08-29 on the live board: 8 events in the whole table, the
// newest 6 weeks old, so "when did this card become in_progress" could not be
// answered for essentially any card.
//
// These tests call the real production entry points on an in-memory database,
// the same way kanban-move-audit.test.ts does for the move path.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  getKanbanCard,
  getKanbanCardEvents,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('kanban update audit trail', () => {
  it('records one event with correct from/to status and actor on a status change', () => {
    createKanbanCard({ id: 'card-a', title: 'Audited card' })

    expect(updateKanbanCard('card-a', { status: 'in_progress' }, 'devy')).toBe(true)

    const events = getKanbanCardEvents('card-a')
    expect(events).toHaveLength(1)
    expect(events[0].card_id).toBe('card-a')
    expect(events[0].from_status).toBe('planned')
    expect(events[0].to_status).toBe('in_progress')
    expect(events[0].actor).toBe('devy')
    expect(typeof events[0].created_at).toBe('number')
  })

  it('records no event when a non-status field changes', () => {
    createKanbanCard({ id: 'card-b', title: 'Renamed card' })

    expect(updateKanbanCard('card-b', { title: 'New title', priority: 'high' }, 'devy')).toBe(true)
    expect(getKanbanCardEvents('card-b')).toHaveLength(0)
    expect(getKanbanCard('card-b')?.title).toBe('New title')
  })

  it('records no event when the caller echoes the unchanged status back', () => {
    // The dashboard's edit form PUTs the whole card, status included. Treating
    // that as a transition would bury the real ones in noise.
    createKanbanCard({ id: 'card-c', title: 'Full-card PUT' })

    expect(updateKanbanCard('card-c', { title: 'Edited', status: 'planned' }, 'devy')).toBe(true)
    expect(getKanbanCardEvents('card-c')).toHaveLength(0)
  })

  it('records no event when no row matches', () => {
    expect(updateKanbanCard('nonexistent-card', { status: 'done' }, 'devy')).toBe(false)
    expect(getKanbanCardEvents('nonexistent-card')).toHaveLength(0)
  })

  it('leaves actor null when none is supplied (existing callers pass two args)', () => {
    createKanbanCard({ id: 'card-d', title: 'No actor' })

    expect(updateKanbanCard('card-d', { status: 'waiting' })).toBe(true)

    const events = getKanbanCardEvents('card-d')
    expect(events).toHaveLength(1)
    expect(events[0].actor).toBeNull()
  })

  it('interleaves with move events into one chronological history per card', () => {
    // The two paths write the same table, so a card picked up by an agent (PUT)
    // and later dragged by the owner (move) reads as a single timeline.
    createKanbanCard({ id: 'card-e', title: 'Mixed path card' })

    updateKanbanCard('card-e', { status: 'in_progress' }, 'devy')
    moveKanbanCard('card-e', 'waiting', 0, 'zsolt')
    updateKanbanCard('card-e', { status: 'done' }, 'devy')

    const events = getKanbanCardEvents('card-e')
    expect(events.map((e) => e.to_status)).toEqual(['in_progress', 'waiting', 'done'])
    expect(events.map((e) => e.from_status)).toEqual(['planned', 'in_progress', 'waiting'])
    expect(events.map((e) => e.actor)).toEqual(['devy', 'zsolt', 'devy'])
    for (let i = 1; i < events.length; i++) {
      expect(events[i].created_at).toBeGreaterThanOrEqual(events[i - 1].created_at)
      expect(events[i].id).toBeGreaterThan(events[i - 1].id)
    }
  })

  it('answers how long a card has been in its current status', () => {
    // The question the empty table could not answer. Kept as a test so the
    // guarantee survives even if no dashboard ever renders it.
    createKanbanCard({ id: 'card-f', title: 'Timing card' })
    updateKanbanCard('card-f', { status: 'in_progress' }, 'devy')

    const events = getKanbanCardEvents('card-f')
    const enteredCurrent = events.filter((e) => e.to_status === 'in_progress').at(-1)
    expect(enteredCurrent).toBeDefined()
    expect(getKanbanCard('card-f')?.status).toBe('in_progress')
    expect(enteredCurrent!.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })
})
