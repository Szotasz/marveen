// A comment addressed to "#230" must land on the card whose seq is 230, not
// under an orphan "230" key nobody reads. Measured live 2026-08-03: fifteen
// comments written through the seq-shaped URL were invisible on their cards,
// and the cards' updated_at was silently never touched. The write path must
// resolve the ref or refuse loudly -- a silent orphan looks like success.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, getKanbanCard,
  addKanbanComment, getKanbanComments,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('comment refs resolve to the card, whatever shape the caller used', () => {
  it('stores a seq-addressed comment under the hex id', () => {
    createKanbanCard({ id: 'abc123ff', title: 'seq-addressed' })
    const seq = getKanbanCard('abc123ff')!.seq as number

    const comment = addKanbanComment(String(seq), 'marveen', 'via seq')

    expect(comment.card_id).toBe('abc123ff')
    expect(getKanbanComments('abc123ff').map(c => c.content)).toContain('via seq')
  })

  it('reads comments through a seq or #seq ref too', () => {
    createKanbanCard({ id: 'abc123ff', title: 'seq-read' })
    const seq = getKanbanCard('abc123ff')!.seq as number
    addKanbanComment('abc123ff', 'marveen', 'via hex')

    expect(getKanbanComments(String(seq)).map(c => c.content)).toContain('via hex')
    expect(getKanbanComments(`#${seq}`).map(c => c.content)).toContain('via hex')
  })

  it('bumps the card updated_at when the comment used a seq ref', () => {
    createKanbanCard({ id: 'abc123ff', title: 'bump' })
    const card = getKanbanCard('abc123ff')!
    const seq = card.seq as number

    addKanbanComment(String(seq), 'marveen', 'bump please')

    expect(getKanbanCard('abc123ff')!.updated_at).toBeGreaterThanOrEqual(card.updated_at)
  })

  it('refuses loudly when the ref matches no card', () => {
    expect(() => addKanbanComment('99999', 'marveen', 'orphan')).toThrow(/unknown kanban card/i)
  })
})
