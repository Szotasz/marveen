import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, createAgentMessage, claimPendingForAgent } from '../db.js'

beforeAll(() => { initDatabase(':memory:') }) // fresh, isolated schema'd DB

// claimPendingForAgent backs the main-agent inbox PULL model. Contract:
//   - claims oldest-first (FIFO: created_at, then id) up to the cap,
//   - marks the claimed rows delivered, and
//   - NEVER double-claims (a single atomic UPDATE ... WHERE status='pending'
//     RETURNING, so two concurrent drains can't return the same message).
describe('claimPendingForAgent', () => {
  it('claims FIFO up to the cap, marks delivered, and never double-claims', () => {
    const to = 'claimtest-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('subA', to, 'first')
    const m2 = createAgentMessage('subB', to, 'second')
    createAgentMessage('subC', to, 'third')

    // cap=2 -> the two OLDEST, in FIFO order
    const batch1 = claimPendingForAgent(to, 2)
    expect(batch1.map(m => m.content)).toEqual(['first', 'second'])
    expect(batch1.every(m => m.status === 'delivered')).toBe(true)

    // next drain -> only the remaining one, with NO overlap (no double-claim)
    const ids1 = new Set([m1.id, m2.id])
    const batch2 = claimPendingForAgent(to, 10)
    expect(batch2.map(m => m.content)).toEqual(['third'])
    expect(batch2.some(m => ids1.has(m.id))).toBe(false)

    // inbox drained empty
    expect(claimPendingForAgent(to, 10)).toEqual([])
  })

  it('returns [] for an agent with no pending messages', () => {
    expect(claimPendingForAgent('claimtest-empty-' + Date.now(), 10)).toEqual([])
  })
})
