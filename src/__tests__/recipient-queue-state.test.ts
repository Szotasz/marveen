import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  getRecipientQueueState,
  getDb,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

// Measured on 2026-08-20: six consecutive messages from the main agent to a
// busy sub-agent took 51, 94, 97, 86, 82 and 81 minutes to arrive. The sender
// saw only `{"id":N,"status":"pending"}` and read it as "sent" every time, so the send
// rate stayed well above the drain rate and the queue grew all morning. Two
// agents ended up measuring the same production database within two minutes of
// each other because neither knew the other's instruction was still an hour
// and a half from landing.
//
// The backlog endpoint already existed. That was the problem: it had to be
// asked for. These tests pin the numbers that now come back WITH the id.
describe('getRecipientQueueState', () => {
  const uniq = (tag: string) =>
    `q-${tag}-${Date.now()}-${Math.floor(performance.now() * 1000)}`

  it('counts the message just created, not the ones ahead of it only', () => {
    // Off-by-one here would be the worst kind of wrong: a sender reading
    // "0 ahead of you" on a queue that already holds their message.
    const busy = uniq('depth')
    createAgentMessage('a', busy, 'egy')
    expect(getRecipientQueueState(busy).queueDepth).toBe(1)
    createAgentMessage('a', busy, 'ketto')
    expect(getRecipientQueueState(busy).queueDepth).toBe(2)
  })

  it('counts only PENDING rows -- a delivered message is no longer a wait', () => {
    const agent = uniq('drain')
    const first = createAgentMessage('a', agent, 'elso')
    createAgentMessage('a', agent, 'masodik')
    markMessageDelivered(first.id)
    expect(getRecipientQueueState(agent).queueDepth).toBe(1)
  })

  it('reports how long the OLDEST pending message has waited', () => {
    const agent = uniq('oldest')
    const old = createAgentMessage('a', agent, 'regi')
    createAgentMessage('a', agent, 'friss')
    getDb().exec(`UPDATE agent_messages SET created_at = created_at - 4800 WHERE id = ${old.id}`)
    expect(getRecipientQueueState(agent).oldestPendingSec).toBeGreaterThanOrEqual(4800)
  })

  it('an empty queue is zero depth and zero wait, not a crash', () => {
    const s = getRecipientQueueState(uniq('empty'))
    expect(s.queueDepth).toBe(0)
    expect(s.oldestPendingSec).toBe(0)
  })

  it('estimatedDelaySec is NULL with no delivery history, never 0', () => {
    // 0 would read as "arrives instantly" -- the opposite of "we have no idea
    // yet". This is the distinction the whole field exists to preserve.
    const fresh = uniq('nohistory')
    createAgentMessage('a', fresh, 'egy')
    expect(getRecipientQueueState(fresh).estimatedDelaySec).toBeNull()
  })

  it('estimates the delay from real created -> delivered latencies', () => {
    const agent = uniq('latency')
    for (const seconds of [600, 1200, 1800]) {
      const m = createAgentMessage('a', agent, `keses ${seconds}`)
      markMessageDelivered(m.id)
      getDb().exec(
        `UPDATE agent_messages SET created_at = delivered_at - ${seconds} WHERE id = ${m.id}`,
      )
    }
    // Median of 600 / 1200 / 1800.
    expect(getRecipientQueueState(agent).estimatedDelaySec).toBe(1200)
  })

  it('uses the MEDIAN, so one overnight outlier cannot distort the estimate', () => {
    // An agent that was offline for a day produces a latency no future sender
    // will experience. A mean would hand that number to everyone: with these
    // five samples the mean is over four hours, the median is ten minutes.
    const agent = uniq('outlier')
    for (const seconds of [600, 600, 600, 600, 86400]) {
      const m = createAgentMessage('a', agent, `keses ${seconds}`)
      markMessageDelivered(m.id)
      getDb().exec(
        `UPDATE agent_messages SET created_at = delivered_at - ${seconds} WHERE id = ${m.id}`,
      )
    }
    expect(getRecipientQueueState(agent).estimatedDelaySec).toBe(600)
  })

  it('averages the two middle samples on an even-sized window', () => {
    const agent = uniq('even')
    for (const seconds of [100, 300]) {
      const m = createAgentMessage('a', agent, `keses ${seconds}`)
      markMessageDelivered(m.id)
      getDb().exec(
        `UPDATE agent_messages SET created_at = delivered_at - ${seconds} WHERE id = ${m.id}`,
      )
    }
    expect(getRecipientQueueState(agent).estimatedDelaySec).toBe(200)
  })

  it('measures each recipient separately -- a busy peer must not colour a quiet one', () => {
    // The whole point is to tell the sender about THIS recipient. A global
    // number would say "the fleet is slow" while the agent they are writing to
    // is idle, and vice versa.
    const busy = uniq('sep-busy')
    const quiet = uniq('sep-quiet')
    createAgentMessage('a', busy, '1')
    createAgentMessage('a', busy, '2')
    createAgentMessage('a', busy, '3')
    createAgentMessage('a', quiet, '1')
    expect(getRecipientQueueState(busy).queueDepth).toBe(3)
    expect(getRecipientQueueState(quiet).queueDepth).toBe(1)
  })

  it('ignores rows whose delivered_at precedes created_at (clock skew, hand-edited data)', () => {
    // A negative latency is not a fast delivery, it is corrupt bookkeeping --
    // and one of them could drag an estimate below zero, which would print as
    // "arrives before you send it".
    const agent = uniq('skew')
    const bad = createAgentMessage('a', agent, 'ferde ora')
    markMessageDelivered(bad.id)
    getDb().exec(`UPDATE agent_messages SET created_at = delivered_at + 500 WHERE id = ${bad.id}`)
    expect(getRecipientQueueState(agent).estimatedDelaySec).toBeNull()
  })
})
