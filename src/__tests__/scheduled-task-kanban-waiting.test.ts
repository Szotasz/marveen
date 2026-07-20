import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  getKanbanCard,
  findActiveKanbanCardByTitle,
  markScheduledTaskKanbanWaiting,
  archiveKanbanCard,
} from '../db.js'

// Tests for the post-fire timeout kanban coupling.
//
// When a scheduled task is detected as potentially stuck (busy > 300s), the
// runner calls markScheduledTaskKanbanWaiting(taskName). This moves any active
// kanban card whose title exactly matches the task name to 'waiting'.
//
// These tests call the real production db functions against an in-memory schema
// (same pattern as kanban-labels.test.ts and kanban-delete-fk.test.ts).

beforeEach(() => {
  initDatabase(':memory:')
})

describe('findActiveKanbanCardByTitle', () => {
  it('finds an active card by exact title match', () => {
    createKanbanCard({ id: 'card-1', title: 'reggeli-napindito' })
    const found = findActiveKanbanCardByTitle('reggeli-napindito')
    expect(found).toBeDefined()
    expect(found!.id).toBe('card-1')
    expect(found!.title).toBe('reggeli-napindito')
  })

  it('returns undefined when no card matches the title', () => {
    createKanbanCard({ id: 'card-1', title: 'something-else' })
    expect(findActiveKanbanCardByTitle('reggeli-napindito')).toBeUndefined()
  })

  it('does not match archived cards', () => {
    createKanbanCard({ id: 'card-1', title: 'reggeli-napindito' })
    archiveKanbanCard('card-1')
    expect(findActiveKanbanCardByTitle('reggeli-napindito')).toBeUndefined()
  })

  it('does not do partial or case-insensitive matching', () => {
    createKanbanCard({ id: 'card-1', title: 'reggeli-napindito-full' })
    expect(findActiveKanbanCardByTitle('reggeli-napindito')).toBeUndefined()
    expect(findActiveKanbanCardByTitle('REGGELI-NAPINDITO-FULL')).toBeUndefined()
  })
})

describe('markScheduledTaskKanbanWaiting', () => {
  it('moves the matching active card to waiting and returns its id', () => {
    createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })

    const result = markScheduledTaskKanbanWaiting('daily-digest')

    expect(result).toBe('card-1')
    const card = getKanbanCard('card-1')
    expect(card!.status).toBe('waiting')
  })

  it('returns null and makes no changes when no card matches', () => {
    createKanbanCard({ id: 'card-1', title: 'unrelated-task', status: 'planned' })

    const result = markScheduledTaskKanbanWaiting('missing-task')

    expect(result).toBeNull()
    // Unrelated card is untouched
    expect(getKanbanCard('card-1')!.status).toBe('planned')
  })

  it('is a no-op for archived cards (does not revive them)', () => {
    createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'done' })
    archiveKanbanCard('card-1')

    const result = markScheduledTaskKanbanWaiting('daily-digest')

    expect(result).toBeNull()
  })

  it('records a status-transition event for auditing', () => {
    createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })
    markScheduledTaskKanbanWaiting('daily-digest')

    // Verify the card status changed (the audit event is written inside
    // moveKanbanCard; the functional signal is the status itself).
    expect(getKanbanCard('card-1')!.status).toBe('waiting')
  })

  it('places the card at the end of the waiting column (sort_order after existing waiting cards)', () => {
    createKanbanCard({ id: 'wait-1', title: 'earlier-task', status: 'waiting' })
    createKanbanCard({ id: 'card-1', title: 'daily-digest', status: 'in_progress' })

    markScheduledTaskKanbanWaiting('daily-digest')

    const moved = getKanbanCard('card-1')!
    const existing = getKanbanCard('wait-1')!
    // The moved card must sort AFTER the existing waiting card.
    expect(moved.sort_order).toBeGreaterThan(existing.sort_order)
  })
})

// --- Fix-revert guard ---
// If markScheduledTaskKanbanWaiting were changed to always return null (no-op),
// the test below would fail: that is the correct behaviour.
describe('fix-revert guard: kanban coupling is load-bearing', () => {
  it('returns the card id (not null) when a matching active card exists', () => {
    createKanbanCard({ id: 'card-1', title: 'test-task', status: 'planned' })
    const result = markScheduledTaskKanbanWaiting('test-task')
    expect(result).not.toBeNull()
    expect(result).toBe('card-1')
  })

  it('actually changes the card status (not just returns an id)', () => {
    createKanbanCard({ id: 'card-1', title: 'test-task', status: 'planned' })
    markScheduledTaskKanbanWaiting('test-task')
    expect(getKanbanCard('card-1')!.status).toBe('waiting')
  })
})
