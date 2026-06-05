// Contract tests for deleteKanbanCard transactional FK safety.
//
// Root cause: the pre-fix deleteKanbanCard issued two independent DML
// statements (DELETE comments, DELETE card). When foreign-key enforcement
// is enabled (`PRAGMA foreign_keys = ON`), deleting a parent card that
// still has children with a non-null parent_id fails with
// SQLITE_CONSTRAINT_FOREIGNKEY. Even with FK off (the better-sqlite3
// default), orphaned children with a dangling parent_id are a data bug:
// they do not appear under any parent in hierarchy views and cannot be
// reached via the parent relationship.
//
// Fix: wrap all three mutations in db.transaction():
//   1. DELETE comments referencing the card.
//   2. UPDATE children: SET parent_id = NULL (promote to root-level).
//   3. DELETE the card.
//
// These tests call deleteKanbanCard (the real production entry point) on
// an in-memory database seeded with the production schema.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, addKanbanComment, getKanbanComments, deleteKanbanCard } from '../db.js'

beforeEach(() => {
  // Re-init with an in-memory database for isolation.
  initDatabase(':memory:')
})

describe('deleteKanbanCard transactional FK safety', () => {
  it('deletes a card with no comments and no children', () => {
    createKanbanCard({ id: 'card-a', title: 'Solo card' })
    const deleted = deleteKanbanCard('card-a')
    expect(deleted).toBe(true)
    expect(getKanbanCard('card-a')).toBeUndefined()
  })

  it('returns false when the card does not exist', () => {
    const deleted = deleteKanbanCard('nonexistent-card')
    expect(deleted).toBe(false)
  })

  it('deletes comments together with the card', () => {
    createKanbanCard({ id: 'card-b', title: 'Card with comments' })
    addKanbanComment('card-b', 'author', 'first comment')
    addKanbanComment('card-b', 'author', 'second comment')

    const deleted = deleteKanbanCard('card-b')
    expect(deleted).toBe(true)
    expect(getKanbanCard('card-b')).toBeUndefined()
    // Comments must be gone too, not left as orphans.
    expect(getKanbanComments('card-b')).toHaveLength(0)
  })

  it('nullifies parent_id on children instead of leaving dangling references', () => {
    // Create a parent card and two children pointing to it.
    createKanbanCard({ id: 'parent-1', title: 'Parent' })
    createKanbanCard({ id: 'child-1', title: 'Child A', parent_id: 'parent-1' })
    createKanbanCard({ id: 'child-2', title: 'Child B', parent_id: 'parent-1' })

    const deleted = deleteKanbanCard('parent-1')
    expect(deleted).toBe(true)
    expect(getKanbanCard('parent-1')).toBeUndefined()

    // Children must still exist as root-level cards (parent_id = NULL).
    const childA = getKanbanCard('child-1')
    const childB = getKanbanCard('child-2')
    expect(childA).toBeDefined()
    expect(childA!.parent_id).toBeNull()
    expect(childB).toBeDefined()
    expect(childB!.parent_id).toBeNull()
  })
})
