// REPLAYNOENVELOPE1114: the second requeue selector. After the watchdog restarts a sub-agent's session it asks the
// server (POST /api/agents/:name/redeliver-open) to put the rows the old session was handed and did not close
// back to pending, so the router delivers them again through its normal envelope. The old path typed the raw
// content into the pane with no envelope, no sender and no id, system directives included.
//
// Pinned here: exactly which rows go back (delivered, open, inside the window, not from system, not stop, not
// urgent, never put back before; SEEN OR NOT, because the restarted session is a fresh one and a seen mark only
// says the row reached a transcript that is gone), once per row, a second call changes nothing, the cap and
// requeue_skipped_at,
// the deliberate difference from the abandoned selector (a newer message from the same sender does NOT block), and
// that the abandoned selector's set and this one's are disjoint.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  createAgentMessage,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
  requeueDeliveredOpenForAgent,
  requeueAbandonedForAgent,
  claimPendingForAgent,
  ABANDONED_SESSION_ABSENT,
} from '../db.js'

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const HOUR = 3600
const NOW = 2_000_000_000

interface Row {
  id: number
  from_agent: string
  to_agent: string
  status: string
  delivered_at: number | null
  seen_at: number | null
  completed_at: number | null
  requeued_at: number | null
  requeue_skipped_at: number | null
  redelivered_at: number | null
  created_at: number
}
function row(id: number): Row {
  return getDb().prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as Row
}
function setCols(id: number, cols: Record<string, number | string | null>): void {
  const keys = Object.keys(cols)
  getDb().prepare(`UPDATE agent_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id)
}
/** A row delivered to `to` at NOW - ageSec, never seen, never closed: in the set the selector is for. */
function deliveredOpen(to: string, ageSec = 600, from = 'carol', content = 'task for ' + to): number {
  const id = createAgentMessage(from, to, content).id
  markMessageDelivered(id)
  setCols(id, { created_at: NOW - ageSec, delivered_at: NOW - ageSec + 5 })
  return id
}

describe('requeueDeliveredOpenForAgent: which rows go back', () => {
  it('a delivered, open, unseen row inside the window goes back to pending with requeued_at and redelivered_at', () => {
    const id = deliveredOpen('alice')
    const before = row(id)
    expect(before.status).toBe('delivered')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([id])
    const r = row(id)
    expect(r.status).toBe('pending')
    expect(r.requeued_at).toBe(NOW)
    expect(r.redelivered_at).toBe(NOW)
    expect(r.requeue_skipped_at).toBeNull()
    // delivered_at is kept: the router overwrites it when it delivers the row again
    expect(r.delivered_at).toBe(before.delivered_at)
    expect(r.created_at).toBe(before.created_at)
    expect(r.seen_at).toBeNull()
    expect(r.completed_at).toBeNull()
  })

  it('picks exactly the eligible rows and leaves every excluded kind untouched', () => {
    const good = deliveredOpen('alice', 600, 'carol')
    const completed = deliveredOpen('alice', 600, 'erin')
    markMessageDone(completed, 'finished')
    const old = deliveredOpen('alice', 2 * HOUR + 60, 'frank')
    const otherRecipient = deliveredOpen('bob', 600, 'carol')
    const fromSystem = deliveredOpen('alice', 600, 'system', '[SYSTEM-DIREKTIVA msg_id:1] stop now')
    const stop = deliveredOpen('alice', 600, 'gina')
    setCols(stop, { stop_authorized: 1 })
    const urgent = deliveredOpen('alice', 600, 'hank')
    setCols(urgent, { urgent: 1 })
    const pending = createAgentMessage('ivan', 'alice', 'still pending').id
    setCols(pending, { created_at: NOW - 600 })
    const failed = createAgentMessage('judy', 'alice', 'failed one').id
    markMessageFailed(failed, 'some failure')
    setCols(failed, { created_at: NOW - 600 })

    const excluded = [completed, old, otherRecipient, fromSystem, stop, urgent, pending, failed]
    const snaps = excluded.map(row)
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([good])
    expect(row(good).status).toBe('pending')
    excluded.forEach((id, i) => expect(row(id), `row ${id}`).toEqual(snaps[i]))
  })

  it('controls: a stop or urgent row with that one field cleared IS put back', () => {
    for (const col of ['stop_authorized', 'urgent'] as const) {
      initDatabase(':memory:')
      const id = deliveredOpen('alice')
      setCols(id, { [col]: 1 })
      expect(requeueDeliveredOpenForAgent('alice', { now: NOW }), col).toEqual([])
      setCols(id, { [col]: 0 })
      expect(requeueDeliveredOpenForAgent('alice', { now: NOW }), col).toEqual([id])
    }
  })

  // Review of #2755: the watchdog starts a fresh session, so "the old session saw it" is no reason to keep a row
  // out. It is the row most likely to be work in progress.
  it('a row the old session had SEEN is put back like an unseen one, and keeps its old seen_at', () => {
    const unseen = deliveredOpen('alice', 900, 'carol')
    const seen = deliveredOpen('alice', 600, 'dave')
    setCols(seen, { seen_at: NOW - 100 })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([unseen, seen])
    const r = row(seen)
    expect(r.status).toBe('pending')
    expect(r.requeued_at).toBe(NOW)
    expect(r.redelivered_at).toBe(NOW)
    expect(r.seen_at).toBe(NOW - 100)
  })

  it('a row delivered on the pull path (marked seen by the drain itself) is put back too', () => {
    const id = createAgentMessage('carol', 'alice', 'pulled task').id
    const claimed = claimPendingForAgent('alice', 10)
    expect(claimed.map((m) => m.id)).toEqual([id])
    expect(row(id).status).toBe('delivered')
    expect(row(id).seen_at).not.toBeNull()
    const nowSec = Math.floor(Date.now() / 1000)
    expect(requeueDeliveredOpenForAgent('alice', { now: nowSec + 60 })).toEqual([id])
    expect(row(id).status).toBe('pending')
  })

  it('a seen row that is closed stays closed (a closed row is never touched)', () => {
    const id = deliveredOpen('alice')
    setCols(id, { seen_at: NOW - 100 })
    markMessageDone(id, 'finished')
    const snap = row(id)
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([])
    expect(row(id)).toEqual(snap)
  })

  // A normally closed row is 'done' or 'failed', so the status condition already keeps it out. This is the
  // completed_at condition on its own: a row that still says 'delivered' but carries a close time is closed.
  it('a delivered row that carries a completed_at is not put back; control: without it, it is', () => {
    const id = deliveredOpen('alice')
    setCols(id, { completed_at: NOW - 30 })
    expect(row(id).status).toBe('delivered')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([])
    expect(row(id).requeued_at).toBeNull()
    setCols(id, { completed_at: null })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([id])
  })

  it('a system row is never put back; control: the same row from a named sender is', () => {
    const sys = deliveredOpen('alice', 600, 'system', 'a directive')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([])
    expect(row(sys).status).toBe('delivered')
    expect(row(sys).requeued_at).toBeNull()
    expect(row(sys).requeue_skipped_at).toBeNull()
    setCols(sys, { from_agent: 'carol' })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([sys])
  })

  it('a system row does not use up the cap', () => {
    const plain = deliveredOpen('alice', 900, 'carol')
    deliveredOpen('alice', 100, 'system', 'newer directive')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW, cap: 1 })).toEqual([plain])
  })

  it('the window is 2 hours by default; maxAgeSec widens it', () => {
    const inside = deliveredOpen('alice', 2 * HOUR - 60)
    const outside = deliveredOpen('alice', 2 * HOUR + 60)
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([inside])
    expect(row(outside).status).toBe('delivered')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW, maxAgeSec: 3 * HOUR })).toEqual([outside])
  })

  it('cap 0 and maxAgeSec 0 do nothing', () => {
    const id = deliveredOpen('alice')
    const snap = row(id)
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW, cap: 0 })).toEqual([])
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW, maxAgeSec: 0 })).toEqual([])
    expect(row(id)).toEqual(snap)
  })
})

describe('requeueDeliveredOpenForAgent: once per row, and repeatable', () => {
  it('a second call in a row puts nothing back and changes nothing', () => {
    const a = deliveredOpen('alice', 900, 'carol')
    const b = deliveredOpen('alice', 300, 'dave')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([a, b])
    const snaps = [row(a), row(b)]
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW + 10 })).toEqual([])
    expect([row(a), row(b)]).toEqual(snaps)
  })

  it('a row put back and delivered again is not put back a second time (seen or not)', () => {
    const id = deliveredOpen('alice')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([id])
    markMessageDelivered(id) // the router delivered it again
    expect(row(id).status).toBe('delivered')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW + 60 })).toEqual([])
    setCols(id, { seen_at: NOW + 30 })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW + 90 })).toEqual([])
    expect(row(id).status).toBe('delivered')
  })

  it('a row the abandoned selector revived before (requeued_at set) is not put back', () => {
    const id = deliveredOpen('alice')
    setCols(id, { requeued_at: NOW - 1000 })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([])
    expect(row(id).status).toBe('delivered')
    expect(row(id).redelivered_at).toBeNull()
  })

  it('a row already marked requeue_skipped_at is not put back', () => {
    const id = deliveredOpen('alice')
    setCols(id, { requeue_skipped_at: NOW - 50 })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([])
    expect(row(id).requeue_skipped_at).toBe(NOW - 50)
  })
})

describe('requeueDeliveredOpenForAgent: the cap', () => {
  it('the newest 20 go back, the rest are marked requeue_skipped_at for good; ids oldest first', () => {
    const ids: number[] = []
    for (let i = 0; i < 25; i++) ids.push(deliveredOpen('alice', 5000 - i * 10, 's' + i))
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual(ids.slice(5))
    for (const id of ids.slice(0, 5)) {
      const r = row(id)
      expect(r.status).toBe('delivered')
      expect(r.requeue_skipped_at).toBe(NOW)
      expect(r.requeued_at).toBeNull()
      expect(r.redelivered_at).toBeNull()
    }
    for (const id of ids.slice(5)) expect(row(id).status).toBe('pending')
    // a second call: the skipped ones stay skipped, nothing goes back
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW + 1 })).toEqual([])
    for (const id of ids.slice(0, 5)) expect(row(id).status).toBe('delivered')
  })

  it('the cap picks by age, not by id; returns oldest first by created_at', () => {
    const a = deliveredOpen('alice', 100, 'carol')
    const b = deliveredOpen('alice', 200, 'dave')
    expect(b).toBeGreaterThan(a)
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([b, a])
    const c = deliveredOpen('bob', 300, 'carol')
    const d = deliveredOpen('bob', 100, 'dave')
    expect(requeueDeliveredOpenForAgent('bob', { now: NOW, cap: 1 })).toEqual([d])
    expect(row(c).requeue_skipped_at).toBe(NOW)
  })
})

describe('requeueDeliveredOpenForAgent: the deliberate difference from the abandoned selector', () => {
  it('a newer message from the same sender to the same recipient does NOT block (it is just the next message)', () => {
    const first = deliveredOpen('alice', 900, 'carol', 'first part')
    const second = deliveredOpen('alice', 300, 'carol', 'second part')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([first, second])
  })

  it('a newer message carrying the same card anchor does NOT block either', () => {
    const m = deliveredOpen('alice', 900, 'carol', '[ABCDEF1234] task')
    const resent = createAgentMessage('carol', 'bob', '[ABCDEF1234] again').id
    setCols(resent, { created_at: NOW - 100 })
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([m])
  })

  it('the two selectors take disjoint sets: neither touches the other one\'s rows', () => {
    const delivered = deliveredOpen('alice', 600, 'carol')
    const abandoned = createAgentMessage('dave', 'alice', 'abandoned').id
    markMessageFailed(abandoned, ABANDONED_SESSION_ABSENT)
    setCols(abandoned, { created_at: NOW - 600 })
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([abandoned])
    expect(row(delivered).status).toBe('delivered')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([delivered])
  })

})

describe('the new column', () => {
  it('createAgentMessage returns redelivered_at null, and the stored row has it null', () => {
    const m = createAgentMessage('carol', 'alice', 'x')
    expect(m.redelivered_at).toBeNull()
    expect(row(m.id).redelivered_at).toBeNull()
  })

  // The pull path (drain-inbox) wraps the rows this claim returns, so the flag must come back with them: the
  // RETURNING list is explicit, and a column missing from it would silently drop the redelivery note there.
  it('claimPendingForAgent returns the flag: set on a row put back, null on a plain row', () => {
    const back = deliveredOpen('alice', 600, 'carol')
    expect(requeueDeliveredOpenForAgent('alice', { now: NOW })).toEqual([back])
    const plain = createAgentMessage('dave', 'alice', 'never delivered before').id
    const claimed = claimPendingForAgent('alice', 10)
    expect(claimed.map((m) => m.id).sort((a, b) => a - b)).toEqual([back, plain].sort((a, b) => a - b))
    expect(claimed.find((m) => m.id === back)!.redelivered_at).toBe(NOW)
    expect(claimed.find((m) => m.id === plain)!.redelivered_at).toBeNull()
  })
})
