import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageFailed,
  countNewerMessagesFromSameSender,
  countNewerMessagesForRows,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

// SB hardening 2026-08-22: the freshness/supersession signal. Contract:
//   - counts STRICTLY newer messages (higher id) from the SAME from->to pair,
//   - excludes 'failed' rows (a message that never reached the receiver cannot
//     be "the current truth"),
//   - is scoped per sender AND per recipient (unrelated traffic never counts).
describe('countNewerMessagesFromSameSender', () => {
  it('counts strictly-newer non-failed messages from the same sender/recipient', () => {
    const to = 'countnewer-' + Date.now() + '-' + Math.floor(performance.now())
    const from = 'pm'
    const m1 = createAgentMessage(from, to, 'deploy-go A (stale)')
    createAgentMessage(from, to, 'superseding B')
    createAgentMessage(from, to, 'superseding C')

    // Two newer messages exist after m1.
    expect(countNewerMessagesFromSameSender(from, to, m1.id)).toBe(2)
  })

  it('the newest message has zero newer', () => {
    const to = 'countnewer-newest-' + Date.now() + '-' + Math.floor(performance.now())
    createAgentMessage('pm', to, 'old')
    const newest = createAgentMessage('pm', to, 'newest')
    expect(countNewerMessagesFromSameSender('pm', to, newest.id)).toBe(0)
  })

  it('excludes failed newer messages', () => {
    const to = 'countnewer-failed-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('pm', to, 'stale go')
    const m2 = createAgentMessage('pm', to, 'newer but failed')
    createAgentMessage('pm', to, 'newer and live')
    markMessageFailed(m2.id, 'test-failed')
    // Only the live newer one counts; the failed one is excluded.
    expect(countNewerMessagesFromSameSender('pm', to, m1.id)).toBe(1)
  })

  it('does not count a different sender or a different recipient', () => {
    const to = 'countnewer-scope-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('pm', to, 'from pm')
    createAgentMessage('bob', to, 'newer from a DIFFERENT sender')
    createAgentMessage('pm', to + '-other', 'newer to a DIFFERENT recipient')
    // Neither the other sender nor the other recipient supersedes m1.
    expect(countNewerMessagesFromSameSender('pm', to, m1.id)).toBe(0)
  })
})

// The batch form exists so the JSON mailbox endpoints can annotate a whole page
// of rows without one partition scan per row. Its contract is
// "same answers, fewer queries", so the ORACLE is the single-row function
// above, not a hand-written expectation: any divergence is a bug in the batch
// form by definition.
describe('countNewerMessagesForRows (batch)', () => {
  it('agrees with the single-row function on every row, across senders and recipients', () => {
    const tag = 'batch-' + Date.now() + '-' + Math.floor(performance.now())
    const rows = [
      createAgentMessage('pm', tag + '-a', 'a1'),
      createAgentMessage('pm', tag + '-a', 'a2'),
      createAgentMessage('pm', tag + '-a', 'a3'),
      createAgentMessage('bob', tag + '-a', 'b1'),
      createAgentMessage('bob', tag + '-a', 'b2'),
      createAgentMessage('pm', tag + '-b', 'c1'),
    ]
    const failed = createAgentMessage('pm', tag + '-a', 'a4 -- never arrived')
    markMessageFailed(failed.id, 'test-failed')

    const batch = countNewerMessagesForRows([...rows, failed])
    for (const r of [...rows, failed]) {
      expect(batch.get(r.id)).toBe(countNewerMessagesFromSameSender(r.from_agent, r.to_agent, r.id))
    }
    // Spot-check one value outright, so a both-sides-broken oracle cannot pass:
    // a1 has a2 and a3 after it, and the failed a4 does not count.
    expect(batch.get(rows[0].id)).toBe(2)
  })

  it('returns an empty map for an empty input instead of querying', () => {
    expect(countNewerMessagesForRows([]).size).toBe(0)
  })

  it('handles a single row and rows given in arbitrary order', () => {
    const to = 'batch-order-' + Date.now() + '-' + Math.floor(performance.now())
    const m1 = createAgentMessage('pm', to, 'first')
    const m2 = createAgentMessage('pm', to, 'second')
    const m3 = createAgentMessage('pm', to, 'third')

    expect(countNewerMessagesForRows([m2]).get(m2.id)).toBe(1)
    // Newest-first is how the list endpoint returns them.
    const shuffled = countNewerMessagesForRows([m3, m1, m2])
    expect(shuffled.get(m1.id)).toBe(2)
    expect(shuffled.get(m2.id)).toBe(1)
    expect(shuffled.get(m3.id)).toBe(0)
  })
})
