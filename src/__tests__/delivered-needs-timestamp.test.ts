import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  closeMessagesWithoutDelivery,
  getAgentMessage,
  getDb,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

// The queue is the only record of what actually went out. On 2026-07-27 an
// operator cleared a backlog with raw SQL that set status without a timestamp,
// and afterwards nobody could tell which messages had genuinely been delivered
// and which had merely been marked. These tests pin the invariant that makes
// that question answerable: 'delivered' always carries a delivered_at.
describe('delivered rows always carry a timestamp', () => {
  const to = () => 'inv-' + Date.now() + '-' + Math.floor(performance.now() * 1000)

  it('records a timestamp on a genuine delivery', () => {
    const m = createAgentMessage('a', to(), 'valódi kézbesítés')
    expect(markMessageDelivered(m.id)).toBe(true)

    const row = getAgentMessage(m.id)
    expect(row?.status).toBe('delivered')
    expect(row?.delivered_at).toBeTruthy()
    // a genuine delivery says nothing about itself in `result` -- that field
    // stays free for the executor's own write-back
    expect(row?.result ?? null).toBeNull()
  })

  it('marks an operator close with both a timestamp and a reason', () => {
    const target = to()
    const m1 = createAgentMessage('a', target, 'elavult')
    const m2 = createAgentMessage('b', target, 'szintén elavult')

    expect(closeMessagesWithoutDelivery([m1.id, m2.id], 'stale backlog after restart')).toBe(2)

    for (const id of [m1.id, m2.id]) {
      const row = getAgentMessage(id)
      expect(row?.status).toBe('delivered')
      expect(row?.delivered_at).toBeTruthy()
      // the reason is what separates "we sent it" from "we gave up on it"
      expect(row?.result).toContain('closed-without-delivery')
      expect(row?.result).toContain('stale backlog after restart')
    }
  })

  it('does not reopen or re-close a row that is no longer pending', () => {
    const m = createAgentMessage('a', to(), 'már kézbesítve')
    markMessageDelivered(m.id)
    const before = getAgentMessage(m.id)

    expect(closeMessagesWithoutDelivery([m.id], 'késői takarítás')).toBe(0)

    const after = getAgentMessage(m.id)
    expect(after?.delivered_at).toBe(before?.delivered_at)
    expect(after?.result ?? null).toBeNull()   // the close must not overwrite a real delivery
  })

  it('repairs a raw-SQL status flip that skipped the timestamp', () => {
    // This is the incident itself, not an approximation of it: bypass every
    // helper and drive the same UPDATE an operator's `sqlite3` session would,
    // straight at the connection. A shell has no other guard, so the trigger
    // is the only thing standing between a cleanup and a dishonest log.
    const m = createAgentMessage('a', to(), 'nyers SQL-lel lezárva')

    getDb().exec(`UPDATE agent_messages SET status = 'delivered' WHERE id = ${m.id}`)

    const row = getAgentMessage(m.id)
    expect(row?.status).toBe('delivered')
    expect(row?.delivered_at).toBeTruthy()               // trigger filled it in
    expect(row?.result).toBe('closed-without-delivery')  // and said why
  })

  it('leaves a genuine delivery untouched when other rows are flipped', () => {
    // The trigger fires per row and must not rewrite the result of a message
    // that really was delivered -- otherwise the repair destroys the very
    // distinction it exists to preserve.
    const real = createAgentMessage('a', to(), 'valódi')
    markMessageDelivered(real.id)
    const stamp = getAgentMessage(real.id)?.delivered_at

    const flipped = createAgentMessage('a', to(), 'nyersen lezárva')
    getDb().exec(`UPDATE agent_messages SET status = 'delivered' WHERE id = ${flipped.id}`)

    const after = getAgentMessage(real.id)
    expect(after?.delivered_at).toBe(stamp)
    expect(after?.result ?? null).toBeNull()
  })
})
