// Contract tests for the kanban label registry + card<->label join table.
//
// These call the real production entry points (db.js) against an in-memory
// database seeded with the production schema, mirroring the pattern used by
// kanban-delete-fk.test.ts for deleteKanbanCard.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, deleteKanbanCard,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForCard, getLabelsForAllCards,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('label registry CRUD', () => {
  it('creates and lists a label', () => {
    createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    expect(listLabels()).toEqual([{ id: 'lbl-a', name: 'bug', color: '#3b82f6', created_at: expect.any(Number) }])
  })

  it('updates name and colour independently', () => {
    createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    expect(updateLabel('lbl-a', { color: '#10b981' })).toBe(true)
    expect(getLabel('lbl-a')).toMatchObject({ name: 'bug', color: '#10b981' })

    expect(updateLabel('lbl-a', { name: 'defect' })).toBe(true)
    expect(getLabel('lbl-a')).toMatchObject({ name: 'defect', color: '#10b981' })
  })

  it('returns false updating a non-existent label', () => {
    expect(updateLabel('nope', { name: 'x' })).toBe(false)
  })

  it('deletes a label and its card associations (no dangling join rows)', () => {
    createKanbanCard({ id: 'card-a', title: 'Card A' })
    createLabel({ id: 'lbl-a', name: 'bug', color: '#3b82f6' })
    addLabelToCard('card-a', 'lbl-a')
    expect(getLabelsForCard('card-a')).toHaveLength(1)

    expect(deleteLabel('lbl-a')).toBe(true)
    expect(getLabel('lbl-a')).toBeUndefined()
    expect(getLabelsForCard('card-a')).toHaveLength(0)
  })

  it('returns false deleting a non-existent label', () => {
    expect(deleteLabel('nope')).toBe(false)
  })
})

describe('card <-> label associations', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'card-a', title: 'Card A' })
    createKanbanCard({ id: 'card-b', title: 'Card B' })
    createLabel({ id: 'lbl-bug', name: 'bug', color: '#3b82f6' })
    createLabel({ id: 'lbl-q2', name: 'q2', color: '#10b981' })
  })

  it('attaches a label to a card and reads it back', () => {
    addLabelToCard('card-a', 'lbl-bug')
    expect(getLabelsForCard('card-a')).toEqual([
      { id: 'lbl-bug', name: 'bug', color: '#3b82f6', created_at: expect.any(Number) },
    ])
    expect(getLabelsForCard('card-b')).toHaveLength(0)
  })

  it('is idempotent -- attaching the same label twice does not duplicate it', () => {
    addLabelToCard('card-a', 'lbl-bug')
    addLabelToCard('card-a', 'lbl-bug')
    expect(getLabelsForCard('card-a')).toHaveLength(1)
  })

  it('removes a label from a card', () => {
    addLabelToCard('card-a', 'lbl-bug')
    expect(removeLabelFromCard('card-a', 'lbl-bug')).toBe(true)
    expect(getLabelsForCard('card-a')).toHaveLength(0)
  })

  it('returns false removing an association that does not exist', () => {
    expect(removeLabelFromCard('card-a', 'lbl-bug')).toBe(false)
  })

  it('bulk-loads labels for all cards in one map', () => {
    addLabelToCard('card-a', 'lbl-bug')
    addLabelToCard('card-a', 'lbl-q2')
    addLabelToCard('card-b', 'lbl-q2')

    const map = getLabelsForAllCards()
    expect(map.get('card-a')).toHaveLength(2)
    expect(map.get('card-b')).toHaveLength(1)
    expect(map.has('card-c')).toBe(false)
  })

  it('drops a card label association when the card is deleted', () => {
    addLabelToCard('card-a', 'lbl-bug')
    expect(deleteKanbanCard('card-a')).toBe(true)
    // The label itself must survive -- only the association is gone.
    expect(getLabel('lbl-bug')).toBeDefined()
    expect(getLabelsForAllCards().has('card-a')).toBe(false)
  })
})
