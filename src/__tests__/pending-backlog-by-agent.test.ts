import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  getPendingBacklogByAgent,
  getDb,
} from '../db.js'

beforeAll(() => { initDatabase(':memory:') })

// A queue behind a busy agent grows silently: the router only injects into an
// idle pane, so an agent that works for an hour accumulates an hour of messages
// and nothing anywhere says so. On 2026-07-27 an 18-row backlog built up that
// way and was read as data loss, which led to it being cleared - the one action
// that actually could have lost something.
describe('getPendingBacklogByAgent', () => {
  const uniq = () => 'backlog-' + Date.now() + '-' + Math.floor(performance.now() * 1000)

  it('counts only pending rows, and reports the oldest wait', () => {
    const busy = uniq()
    const m1 = createAgentMessage('a', busy, 'régi')
    createAgentMessage('b', busy, 'újabb')
    // backdate the first one so "oldest" is a real measurement, not a tie
    getDb().exec(`UPDATE agent_messages SET created_at = created_at - 3600 WHERE id = ${m1.id}`)

    const row = getPendingBacklogByAgent().find(r => r.agent === busy)
    expect(row?.pending).toBe(2)
    expect(row?.oldestAgeSeconds).toBeGreaterThanOrEqual(3600)
  })

  it('drops an agent off the list once its queue is drained', () => {
    const quiet = uniq()
    const m = createAgentMessage('a', quiet, 'egyetlen')
    expect(getPendingBacklogByAgent().some(r => r.agent === quiet)).toBe(true)

    markMessageDelivered(m.id)
    expect(getPendingBacklogByAgent().some(r => r.agent === quiet)).toBe(false)
  })

  it('puts the longest-waiting agent first', () => {
    // Whoever has been waiting longest is the one worth looking at, not whoever
    // happens to have the most messages -- a big fresh queue is just a busy
    // agent, one old message is an agent that will never pick it up.
    const stale = uniq() + '-stale'
    const fresh = uniq() + '-fresh'
    const old = createAgentMessage('a', stale, 'két órája vár')
    getDb().exec(`UPDATE agent_messages SET created_at = created_at - 7200 WHERE id = ${old.id}`)
    createAgentMessage('a', fresh, 'most jött')
    createAgentMessage('b', fresh, 'ez is most jött')
    createAgentMessage('c', fresh, 'meg ez is')

    const list = getPendingBacklogByAgent().filter(r => r.agent === stale || r.agent === fresh)
    expect(list[0].agent).toBe(stale)
    expect(list[0].pending).toBe(1)        // fewer messages, but waiting longer
    expect(list[1].pending).toBe(3)
  })
})
