// Contract tests for parentWouldCycle -- the cycle guard for kanban_cards.parent_id.
//
// Same shape as kanban-blockers.test.ts's "cycle guard" describe block: parent_id is a
// single-valued pointer (not a join table like blockers), but the risk is the same one
// touchAncestorChain's own comment used to describe -- nothing refused the write that
// would close a loop, only the walk that later discovers one.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, updateKanbanCard, parentWouldCycle,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('parent cycle guard', () => {
  it('refuses a card being its own parent', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    expect(parentWouldCycle('card-a', 'card-a')).toBe(true)
  })

  it('refuses a direct back-link (A is B\'s parent, B proposed as A\'s parent)', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B', parent_id: 'card-a' })
    expect(parentWouldCycle('card-a', 'card-b')).toBe(true)
  })

  it('refuses a transitive loop (A is B\'s parent, B is C\'s parent, C proposed as A\'s parent)', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'C', parent_id: 'card-b' })
    expect(parentWouldCycle('card-a', 'card-c')).toBe(true)
  })

  it('allows a diamond-shaped reparent -- two children of the same parent are not a cycle', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'C', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-d', title: 'D' })
    expect(parentWouldCycle('card-d', 'card-b')).toBe(false)
    expect(parentWouldCycle('card-d', 'card-c')).toBe(false)
  })

  it('terminates on data that already contains a cycle', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    createKanbanCard({ id: 'card-c', title: 'C' })
    // Written straight through updateKanbanCard, bypassing the PUT-route guard, the way a
    // script or a hand-edited database could. The walk must not spin forever on it, and
    // must refuse to extend a chain that is already broken rather than silently accept it.
    updateKanbanCard('card-a', { parent_id: 'card-b' })
    updateKanbanCard('card-b', { parent_id: 'card-a' })
    expect(parentWouldCycle('card-c', 'card-a')).toBe(true)
  })

  it('allows a plain re-parent onto an unrelated card', () => {
    createKanbanCard({ id: 'card-a', title: 'A' })
    createKanbanCard({ id: 'card-b', title: 'B' })
    expect(parentWouldCycle('card-a', 'card-b')).toBe(false)
  })
})
