// Tests for Issue #30: 3-level kanban subtask hierarchy.
//
// Covers:
//   - Migration 0002 depth backfill (recursive CTE correctness)
//   - createKanbanCard: depth computation and max-depth enforce
//   - updateKanbanCard: depth cascade on reparent
//   - deleteKanbanCard: promote children to grandparent
//   - getSubtree: WITH RECURSIVE result ordering
//   - getSubtreeHeight: leaf vs. subtree with children
//   - reparentKanbanCard: depth constraint, cascade, and status propagation
//   - propagateStatus: all-done -> parent done; un-done -> parent in_progress; bubble-up
//
// Fixtures use neutral names (card-a, card-b, …) per the privacy rule:
// no real agent names, chat IDs, tokens, or emails in tests.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  getKanbanCard,
  updateKanbanCard,
  deleteKanbanCard,
  moveKanbanCard,
  getSubtree,
  getSubtreeHeight,
  reparentKanbanCard,
  propagateStatus,
  getKanbanCardEvents,
  getChildCards,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

// ── depth computation on create ──────────────────────────────────────────────

describe('createKanbanCard: depth', () => {
  it('assigns depth 0 to a top-level card', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    expect(getKanbanCard('card-a')!.depth).toBe(0)
  })

  it('assigns depth 1 to a direct subtask', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    expect(getKanbanCard('card-b')!.depth).toBe(1)
  })

  it('assigns depth 2 to a sub-subtask', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    expect(getKanbanCard('card-c')!.depth).toBe(2)
  })

  it('throws when trying to create a card at depth 3', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    expect(() =>
      createKanbanCard({ id: 'card-d', title: 'Great-grandchild', parent_id: 'card-c' })
    ).toThrow(/max depth/)
  })

  it('throws when parent card does not exist', () => {
    expect(() =>
      createKanbanCard({ id: 'card-b', title: 'Orphan', parent_id: 'nonexistent' })
    ).toThrow(/not found/)
  })
})

// ── getSubtree ────────────────────────────────────────────────────────────────

describe('getSubtree', () => {
  it('returns only the root when it has no children', () => {
    createKanbanCard({ id: 'card-a', title: 'Solo' })
    const tree = getSubtree('card-a')
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('card-a')
  })

  it('returns root + 2 direct children ordered by depth then sort_order', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child 1', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Child 2', parent_id: 'card-a' })
    const tree = getSubtree('card-a')
    expect(tree.map(c => c.id)).toEqual(['card-a', 'card-b', 'card-c'])
  })

  it('returns a 3-level tree in correct order', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    const tree = getSubtree('card-a')
    expect(tree.map(c => c.id)).toEqual(['card-a', 'card-b', 'card-c'])
    expect(tree.map(c => c.depth)).toEqual([0, 1, 2])
  })

  it('returns only subtree of the given root, not siblings', () => {
    createKanbanCard({ id: 'card-a', title: 'Root A' })
    createKanbanCard({ id: 'card-b', title: 'Root B' })
    createKanbanCard({ id: 'card-c', title: 'Child of A', parent_id: 'card-a' })
    const tree = getSubtree('card-a')
    expect(tree.map(c => c.id)).not.toContain('card-b')
    expect(tree).toHaveLength(2)
  })
})

// ── getSubtreeHeight ──────────────────────────────────────────────────────────

describe('getSubtreeHeight', () => {
  it('returns 0 for a leaf card', () => {
    createKanbanCard({ id: 'card-a', title: 'Leaf' })
    expect(getSubtreeHeight('card-a')).toBe(0)
  })

  it('returns 1 for a card with only direct children', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    expect(getSubtreeHeight('card-a')).toBe(1)
  })

  it('returns 2 for a card with grandchildren', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    expect(getSubtreeHeight('card-a')).toBe(2)
  })
})

// ── deleteKanbanCard: promote to grandparent ──────────────────────────────────

describe('deleteKanbanCard: promote children to grandparent', () => {
  it('promotes children to grandparent when deleting a mid-level card', () => {
    createKanbanCard({ id: 'card-a', title: 'Grandparent' })
    createKanbanCard({ id: 'card-b', title: 'Parent', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Child', parent_id: 'card-b' })

    deleteKanbanCard('card-b')

    const child = getKanbanCard('card-c')
    expect(child).toBeDefined()
    expect(child!.parent_id).toBe('card-a')
    expect(child!.depth).toBe(1)
  })

  it('promotes children to top-level when deleting a top-level card', () => {
    createKanbanCard({ id: 'card-a', title: 'Parent' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })

    deleteKanbanCard('card-a')

    const child = getKanbanCard('card-b')
    expect(child).toBeDefined()
    expect(child!.parent_id).toBeNull()
    expect(child!.depth).toBe(0)
  })

  it('cascades depth on grandchildren when promoting', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Mid', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Child of Mid', parent_id: 'card-b' })

    // Delete card-a (top-level). card-b becomes top-level, card-c goes to depth 1.
    deleteKanbanCard('card-a')

    const mid = getKanbanCard('card-b')
    expect(mid!.parent_id).toBeNull()
    expect(mid!.depth).toBe(0)

    const grandchild = getKanbanCard('card-c')
    expect(grandchild!.parent_id).toBe('card-b')
    expect(grandchild!.depth).toBe(1)
  })
})

// ── reparentKanbanCard ────────────────────────────────────────────────────────

describe('reparentKanbanCard', () => {
  it('reparents a leaf card to a different top-level parent', () => {
    createKanbanCard({ id: 'card-a', title: 'Root A' })
    createKanbanCard({ id: 'card-b', title: 'Root B' })
    createKanbanCard({ id: 'card-c', title: 'Child of A', parent_id: 'card-a' })

    const result = reparentKanbanCard('card-c', 'card-b')
    expect(result.ok).toBe(true)

    const c = getKanbanCard('card-c')!
    expect(c.parent_id).toBe('card-b')
    expect(c.depth).toBe(1)
  })

  it('reparents to top-level (null parent)', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })

    const result = reparentKanbanCard('card-b', null)
    expect(result.ok).toBe(true)
    const b = getKanbanCard('card-b')!
    expect(b.parent_id).toBeNull()
    expect(b.depth).toBe(0)
  })

  it('cascades depth to grandchildren after reparent', () => {
    createKanbanCard({ id: 'card-a', title: 'Root A' })
    createKanbanCard({ id: 'card-b', title: 'Root B' })
    createKanbanCard({ id: 'card-c', title: 'Child of A', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-d', title: 'Grandchild', parent_id: 'card-c' })

    // card-c (depth 1) moves under card-b (depth 0) -> card-c stays depth 1, card-d depth 2
    reparentKanbanCard('card-c', 'card-b')

    expect(getKanbanCard('card-c')!.depth).toBe(1)
    expect(getKanbanCard('card-d')!.depth).toBe(2)
  })

  it('rejects when move would push grandchildren beyond depth 2', () => {
    createKanbanCard({ id: 'card-a', title: 'Root A' })
    createKanbanCard({ id: 'card-b', title: 'Child of A', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    createKanbanCard({ id: 'card-d', title: 'Root D' })
    createKanbanCard({ id: 'card-e', title: 'Child of D', parent_id: 'card-d' })

    // Try reparenting card-b (which has card-c as grandchild) under card-e (depth 1).
    // Result: card-b -> depth 2, card-c -> depth 3. Blocked.
    const result = reparentKanbanCard('card-b', 'card-e')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/max depth/)
  })

  it('rejects self-parenting', () => {
    createKanbanCard({ id: 'card-a', title: 'Solo' })
    const result = reparentKanbanCard('card-a', 'card-a')
    expect(result.ok).toBe(false)
  })

  it('rejects when target parent does not exist', () => {
    createKanbanCard({ id: 'card-a', title: 'Solo' })
    const result = reparentKanbanCard('card-a', 'nonexistent')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })
})

// ── updateKanbanCard: depth cascade ──────────────────────────────────────────

describe('updateKanbanCard: depth cascade on parent_id change', () => {
  it('updates depth when parent_id is changed', () => {
    createKanbanCard({ id: 'card-a', title: 'Root A' })
    createKanbanCard({ id: 'card-b', title: 'Root B' })
    createKanbanCard({ id: 'card-c', title: 'Child of A', parent_id: 'card-a' })

    updateKanbanCard('card-c', { parent_id: 'card-b' })

    expect(getKanbanCard('card-c')!.parent_id).toBe('card-b')
    expect(getKanbanCard('card-c')!.depth).toBe(1)
  })

  it('rejects reparent that would cause depth violation', () => {
    createKanbanCard({ id: 'card-a', title: 'Root' })
    createKanbanCard({ id: 'card-b', title: 'Child', parent_id: 'card-a' })
    createKanbanCard({ id: 'card-c', title: 'Grandchild', parent_id: 'card-b' })
    createKanbanCard({ id: 'card-d', title: 'Root D' })
    createKanbanCard({ id: 'card-e', title: 'Child of D', parent_id: 'card-d' })

    // Moving card-b (has grandchild card-c) under card-e (depth 1) would put card-c at depth 3.
    const ok = updateKanbanCard('card-b', { parent_id: 'card-e' })
    expect(ok).toBe(false)
    // Depth must be unchanged.
    expect(getKanbanCard('card-b')!.depth).toBe(1)
  })
})

// ── propagateStatus ───────────────────────────────────────────────────────────

describe('propagateStatus: auto status propagation', () => {
  it('auto-sets parent to done when all children are done', () => {
    createKanbanCard({ id: 'card-a', title: 'Parent', status: 'in_progress' })
    createKanbanCard({ id: 'card-b', title: 'Child 1', parent_id: 'card-a', status: 'in_progress' })
    createKanbanCard({ id: 'card-c', title: 'Child 2', parent_id: 'card-a', status: 'in_progress' })

    moveKanbanCard('card-b', 'done', 0, 'test')
    propagateStatus('card-b')
    // card-c still in_progress, so parent should stay in_progress
    expect(getKanbanCard('card-a')!.status).toBe('in_progress')

    moveKanbanCard('card-c', 'done', 0, 'test')
    propagateStatus('card-c')
    // Now both children are done -> parent auto-done
    expect(getKanbanCard('card-a')!.status).toBe('done')
  })

  it('records an auto event on parent when auto-completing', () => {
    createKanbanCard({ id: 'card-a', title: 'Parent', status: 'in_progress' })
    createKanbanCard({ id: 'card-b', title: 'Only Child', parent_id: 'card-a', status: 'planned' })

    moveKanbanCard('card-b', 'done', 0, 'test')
    propagateStatus('card-b')

    const events = getKanbanCardEvents('card-a')
    const autoEvent = events.find(e => e.actor === 'auto' && e.to_status === 'done')
    expect(autoEvent).toBeDefined()
    expect(autoEvent!.from_status).toBe('in_progress')
  })

  it('reverts done parent to in_progress when a child is un-done', () => {
    createKanbanCard({ id: 'card-a', title: 'Parent', status: 'in_progress' })
    createKanbanCard({ id: 'card-b', title: 'Only Child', parent_id: 'card-a', status: 'planned' })

    // Auto-complete parent
    moveKanbanCard('card-b', 'done', 0, 'test')
    propagateStatus('card-b')
    expect(getKanbanCard('card-a')!.status).toBe('done')

    // Un-done the child
    moveKanbanCard('card-b', 'in_progress', 0, 'test')
    propagateStatus('card-b')
    expect(getKanbanCard('card-a')!.status).toBe('in_progress')
  })

  it('bubbles propagation up through 3 levels', () => {
    createKanbanCard({ id: 'card-a', title: 'Grandparent', status: 'in_progress' })
    createKanbanCard({ id: 'card-b', title: 'Parent', parent_id: 'card-a', status: 'in_progress' })
    createKanbanCard({ id: 'card-c', title: 'Child', parent_id: 'card-b', status: 'planned' })

    moveKanbanCard('card-c', 'done', 0, 'test')
    propagateStatus('card-c')

    // card-b has only card-c, so card-b -> done
    // card-a has only card-b, so card-a -> done
    expect(getKanbanCard('card-b')!.status).toBe('done')
    expect(getKanbanCard('card-a')!.status).toBe('done')
  })

  it('does not propagate when card is top-level (no parent)', () => {
    createKanbanCard({ id: 'card-a', title: 'Solo', status: 'in_progress' })
    moveKanbanCard('card-a', 'done', 0, 'test')
    propagateStatus('card-a')  // should be a no-op (no parent)
    expect(getKanbanCard('card-a')!.status).toBe('done')
  })
})
