// Contract tests for the owner guard and the assignee audit trail.
//
// A card the owner holds is one THEY are expected to act on. Most writers of
// PUT /api/kanban/:id send the whole card back, so an assignee can ride along
// from a stale copy and quietly take the card off the owner. updateKanbanCard
// drops such a change unless the caller asks for it explicitly (`reassign`),
// and records every assignee change -- accepted or refused -- in
// kanban_card_events, so the next occurrence names its actor.
//
// The tests drive the real production entry points on an in-memory database
// seeded with the production schema, like the other kanban db tests.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, updateKanbanCard, moveKanbanCard, getKanbanCard, getKanbanCardEvents } from '../db.js'
import { OWNER_NAME } from '../config.js'

const OWNER = OWNER_NAME

beforeEach(() => {
  initDatabase(':memory:')
})

describe('owner guard', () => {
  it('keeps the owner when an update carries a different assignee', () => {
    createKanbanCard({ id: 'card-a', title: 'Owner card', assignee: OWNER })

    expect(updateKanbanCard('card-a', { assignee: 'prisma' })).toBe(true)

    expect(getKanbanCard('card-a')!.assignee).toBe(OWNER)
  })

  it('still applies the rest of the update it refused the assignee from', () => {
    // The typical caller sends `{...card, parent_id}` -- the assignee is the
    // accident, the other field is the point. Failing the whole write would
    // turn a stray field into a failed edit.
    createKanbanCard({ id: 'card-b', title: 'Owner card', assignee: OWNER })

    updateKanbanCard('card-b', { assignee: 'prisma', title: 'Renamed', priority: 'high' })

    const card = getKanbanCard('card-b')!
    expect(card.assignee).toBe(OWNER)
    expect(card.title).toBe('Renamed')
    expect(card.priority).toBe('high')
  })

  it('hands the card over when the caller says reassign', () => {
    createKanbanCard({ id: 'card-c', title: 'Owner card', assignee: OWNER })

    expect(updateKanbanCard('card-c', { assignee: 'prisma' }, { reassign: true })).toBe(true)

    expect(getKanbanCard('card-c')!.assignee).toBe('prisma')
  })

  it('matches the owner case-insensitively', () => {
    // The board holds both 'marveen' and 'Marveen'; a guard that misses on
    // casing is no guard.
    createKanbanCard({ id: 'card-d', title: 'Owner card', assignee: OWNER.toUpperCase() })

    updateKanbanCard('card-d', { assignee: 'prisma' })

    expect(getKanbanCard('card-d')!.assignee).toBe(OWNER.toUpperCase())
  })

  it('leaves cards the owner does not hold alone', () => {
    createKanbanCard({ id: 'card-e', title: 'Agent card', assignee: 'prisma' })

    updateKanbanCard('card-e', { assignee: 'polaris' })

    expect(getKanbanCard('card-e')!.assignee).toBe('polaris')
  })

  it('does not block an update that leaves the assignee alone', () => {
    createKanbanCard({ id: 'card-f', title: 'Owner card', assignee: OWNER })

    updateKanbanCard('card-f', { status: 'in_progress' })

    const card = getKanbanCard('card-f')!
    expect(card.assignee).toBe(OWNER)
    expect(card.status).toBe('in_progress')
    expect(getKanbanCardEvents('card-f')).toHaveLength(0)
  })
})

describe('assignee audit trail', () => {
  it('records an accepted change with both sides and the actor', () => {
    createKanbanCard({ id: 'card-g', title: 'Agent card', assignee: 'prisma' })

    updateKanbanCard('card-g', { assignee: 'polaris' }, { actor: 'marveen' })

    const events = getKanbanCardEvents('card-g')
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('assignee')
    expect(events[0].from_assignee).toBe('prisma')
    expect(events[0].to_assignee).toBe('polaris')
    expect(events[0].actor).toBe('marveen')
  })

  it('records a refused take-over, naming who tried and for whom', () => {
    // The point of the audit: if the phenomenon recurs, the row names it.
    createKanbanCard({ id: 'card-h', title: 'Owner card', assignee: OWNER })

    updateKanbanCard('card-h', { assignee: 'prisma' }, { actor: 'marveen' })

    const events = getKanbanCardEvents('card-h')
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('assignee_blocked')
    expect(events[0].from_assignee).toBe(OWNER)
    expect(events[0].to_assignee).toBe('prisma')
    expect(events[0].actor).toBe('marveen')
  })

  it('records the status the card was in, without inventing a transition', () => {
    // An assignee row is not a column move: a reader looking only at the
    // status pair must see no transition.
    createKanbanCard({ id: 'card-i', title: 'Agent card', status: 'in_progress', assignee: 'prisma' })

    updateKanbanCard('card-i', { assignee: 'polaris' })

    const [event] = getKanbanCardEvents('card-i')
    expect(event.from_status).toBe('in_progress')
    expect(event.to_status).toBe('in_progress')
  })

  it('records an assignee cleared to nobody', () => {
    createKanbanCard({ id: 'card-j', title: 'Agent card', assignee: 'prisma' })

    updateKanbanCard('card-j', { assignee: null })

    const [event] = getKanbanCardEvents('card-j')
    expect(event.kind).toBe('assignee')
    expect(event.to_assignee).toBeNull()
    expect(getKanbanCard('card-j')!.assignee).toBeNull()
  })

  it('keeps status moves labelled as status events', () => {
    // Regression: the added `kind` column must not relabel the existing trail.
    createKanbanCard({ id: 'card-k', title: 'Agent card', assignee: 'prisma' })

    moveKanbanCard('card-k', 'in_progress', 1, 'marveen')

    const [event] = getKanbanCardEvents('card-k')
    expect(event.kind).toBe('status')
    expect(event.from_assignee).toBeNull()
  })
})
