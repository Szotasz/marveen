// Contract tests for write-time assignee canonicalisation.
//
// The board holds hand-typed names ('Viktor' vs 'viktor', 'marveen' vs
// 'Marveen') and SQLite compares case-sensitively, so every consumer keying on
// assignee equality either remembers COLLATE NOCASE or silently misses rows.
// createKanbanCard/updateKanbanCard therefore reuse the board's majority
// spelling of a name; a never-seen name is stored as typed.
//
// The tests drive the real production entry points on an in-memory database
// seeded with the production schema, like the other kanban db tests.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, updateKanbanCard, getKanbanCard } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('assignee canonicalisation', () => {
  it('reuses the majority spelling on create', () => {
    createKanbanCard({ id: 'v1', title: 'a', assignee: 'Viktor' })
    createKanbanCard({ id: 'v2', title: 'b', assignee: 'Viktor' })
    createKanbanCard({ id: 'v3', title: 'c', assignee: 'viktor' })

    createKanbanCard({ id: 'v4', title: 'd', assignee: 'VIKTOR' })

    expect(getKanbanCard('v4')!.assignee).toBe('Viktor')
  })

  it('reuses the majority spelling on update', () => {
    createKanbanCard({ id: 'm1', title: 'a', assignee: 'prisma' })
    createKanbanCard({ id: 'm2', title: 'b', assignee: 'prisma' })
    createKanbanCard({ id: 'x1', title: 'c' })

    updateKanbanCard('x1', { assignee: 'Prisma' }, { reassign: true })

    expect(getKanbanCard('x1')!.assignee).toBe('prisma')
  })

  it('stores a never-seen name as typed', () => {
    createKanbanCard({ id: 'n1', title: 'a', assignee: 'Edina1' })

    expect(getKanbanCard('n1')!.assignee).toBe('Edina1')
  })

  it('trims and stores empty as null', () => {
    createKanbanCard({ id: 'e1', title: 'a', assignee: '   ' })

    expect(getKanbanCard('e1')!.assignee).toBeNull()
  })

  it('leaves the assignee alone when the update does not mention it', () => {
    createKanbanCard({ id: 'k1', title: 'a', assignee: 'polaris' })

    updateKanbanCard('k1', { title: 'renamed' })

    expect(getKanbanCard('k1')!.assignee).toBe('polaris')
  })
})
