import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createApproval,
  getApproval,
  decideApproval,
  rejectDecision,
  listCardDecisions,
  parseDecisionOptions,
  createKanbanCard,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const OPTIONS = [
  { key: 'merchant_text', label: 'A kereskedő írja a szöveget', detail: 'Nincs alapértelmezett állítás' },
  { key: 'make_real', label: 'Tegyük valóssá', detail: 'Backend-munka, csúsztat' },
  { key: 'drop', label: 'Vegyük ki' },
]

function makeDecision(id = 'dec-1', cardId: string | null = null) {
  return createApproval({
    id,
    agent_id: 'prisma',
    category: 'product_decision',
    action_description: 'Mi legyen a visszaszámláló szövegével?',
    card_id: cardId,
    options: OPTIONS,
  })
}

describe('parseDecisionOptions', () => {
  it('returns an empty list for a classic approval with no options', () => {
    expect(parseDecisionOptions(null)).toEqual([])
  })

  // A malformed blob must not take the board down -- it degrades to a binary
  // approval, which is still answerable, rather than throwing on render.
  it('degrades to no options on malformed or non-array JSON', () => {
    expect(parseDecisionOptions('{not json')).toEqual([])
    expect(parseDecisionOptions('{"key":"a"}')).toEqual([])
  })

  it('drops entries missing key or label rather than surfacing half-options', () => {
    const raw = JSON.stringify([{ key: 'a', label: 'A' }, { key: 'b' }, { label: 'C' }])
    expect(parseDecisionOptions(raw)).toEqual([{ key: 'a', label: 'A' }])
  })
})

describe('createApproval with options', () => {
  it('round-trips the offered options', () => {
    const a = makeDecision()
    expect(a.status).toBe('pending')
    expect(parseDecisionOptions(a.options)).toEqual(OPTIONS)
  })

  it('leaves options null for a classic binary approval', () => {
    const a = createApproval({
      id: 'ap-1',
      agent_id: 'prisma',
      category: 'email_send',
      action_description: 'Send report',
    })
    expect(a.options).toBeNull()
    expect(parseDecisionOptions(a.options)).toEqual([])
  })
})

describe('decideApproval', () => {
  it('records the chosen option, who chose it, and when', () => {
    makeDecision()
    expect(decideApproval('dec-1', 'make_real', 'viktor')).toBe(true)
    const a = getApproval('dec-1')!
    expect(a.status).toBe('decided')
    expect(a.chosen_key).toBe('make_real')
    expect(a.resolved_by).toBe('viktor')
    expect(a.resolved_at).toBeGreaterThan(0)
  })

  it('stores an optional note alongside the choice', () => {
    makeDecision()
    decideApproval('dec-1', 'drop', 'viktor', 'zsákutca')
    expect(getApproval('dec-1')!.chosen_note).toBe('zsákutca')
  })

  // The whole point is a durable record: a second click (or a click racing
  // another surface) must not silently overwrite the answer already given.
  it('refuses to overwrite an answer that was already recorded', () => {
    makeDecision()
    expect(decideApproval('dec-1', 'drop', 'viktor')).toBe(true)
    expect(decideApproval('dec-1', 'make_real', 'viktor')).toBe(false)
    expect(getApproval('dec-1')!.chosen_key).toBe('drop')
  })

  // An answer outside the offered menu is a bug in the caller, not a choice --
  // accepting it would let an agent branch on a key nobody was ever shown.
  it('rejects a key that was not among the offered options', () => {
    makeDecision()
    expect(decideApproval('dec-1', 'something_else', 'viktor')).toBe(false)
    expect(getApproval('dec-1')!.status).toBe('pending')
  })

  it('rejects a decision on a request that has no options', () => {
    createApproval({
      id: 'ap-2',
      agent_id: 'prisma',
      category: 'email_send',
      action_description: 'Send report',
    })
    expect(decideApproval('ap-2', 'anything', 'viktor')).toBe(false)
  })

  it('returns false for an unknown id', () => {
    expect(decideApproval('nope', 'drop', 'viktor')).toBe(false)
  })
})

describe('rejectDecision', () => {
  // "None of these" is a real answer -- exactly what happened to the countdown
  // timer -- and must be distinguishable from picking an option.
  it('records a none-of-the-above answer with its reason', () => {
    makeDecision()
    expect(rejectDecision('dec-1', 'viktor', 'egyik sem, zsákutca')).toBe(true)
    const a = getApproval('dec-1')!
    expect(a.status).toBe('rejected')
    expect(a.chosen_key).toBeNull()
    expect(a.chosen_note).toBe('egyik sem, zsákutca')
  })

  it('does not overwrite an already-answered decision', () => {
    makeDecision()
    decideApproval('dec-1', 'drop', 'viktor')
    expect(rejectDecision('dec-1', 'viktor', 'meggondoltam')).toBe(false)
    expect(getApproval('dec-1')!.status).toBe('decided')
  })
})

describe('listCardDecisions', () => {
  function card(id: string) {
    createKanbanCard({ id, title: `card ${id}` })
  }

  it('returns only the decisions attached to the given card', () => {
    card('card-a')
    card('card-b')
    makeDecision('d-a1', 'card-a')
    makeDecision('d-b1', 'card-b')
    makeDecision('d-loose', null)
    expect(listCardDecisions('card-a').map(d => d.id)).toEqual(['d-a1'])
  })

  it('keeps answered decisions visible so the card stays a decision log', () => {
    card('card-a')
    makeDecision('d-1', 'card-a')
    makeDecision('d-2', 'card-a')
    decideApproval('d-1', 'drop', 'viktor')
    expect(listCardDecisions('card-a').map(d => d.id)).toEqual(['d-1', 'd-2'])
    expect(listCardDecisions('card-a', { pendingOnly: true }).map(d => d.id)).toEqual(['d-2'])
  })

  it('orders oldest first so questions are answered in the order asked', () => {
    card('card-a')
    makeDecision('d-1', 'card-a')
    makeDecision('d-2', 'card-a')
    const ids = listCardDecisions('card-a').map(d => d.id)
    expect(ids.indexOf('d-1')).toBeLessThan(ids.indexOf('d-2'))
  })
})
