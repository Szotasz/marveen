import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initDatabase,
  getDb,
  createAgentMessage,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
  markPendingMessageFailed,
  requeueAbandonedForAgent,
  cardAnchors,
  ABANDONED_SESSION_ABSENT,
} from '../db.js'
import { requeueAbandonedAndNotify } from '../web/requeue-notice.js'
import { MAIN_AGENT_ID } from '../config.js'

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const DAY = 86400
const HOUR = 3600
const NOW = 2_000_000_000

function row(id: number): any {
  return getDb().prepare('SELECT * FROM agent_messages WHERE id = ?').get(id)
}
function setCreated(id: number, t: number) {
  getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?').run(t, id)
}
function abandoned(to: string, createdAt?: number): number {
  const id = createAgentMessage('s' + Math.random(), to, 'hello ' + to).id
  markMessageFailed(id, ABANDONED_SESSION_ABSENT)
  if (createdAt !== undefined) setCreated(id, createdAt)
  return id
}
function systemMessages(to?: string): any[] {
  return to === undefined
    ? getDb().prepare("SELECT * FROM agent_messages WHERE from_agent = 'system' ORDER BY id").all()
    : getDb().prepare("SELECT * FROM agent_messages WHERE from_agent = 'system' AND to_agent = ? ORDER BY id").all(to)
}

describe('requeueAbandonedForAgent', () => {
  it('T1 an abandoned row with a delivered_at stays failed', () => {
    const id = abandoned('alice')
    getDb().prepare('UPDATE agent_messages SET delivered_at = created_at WHERE id = ?').run(id)
    const before = row(id)
    expect(before.delivered_at).not.toBeNull()
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.result).toBe(ABANDONED_SESSION_ABSENT)
    expect(r.delivered_at).toBe(before.delivered_at)
    expect(r.requeued_at).toBeNull()
    expect(r.requeue_skipped_at).toBeNull()
  })

  it('T1 control: the same row with delivered_at NULL is revived', () => {
    const id = abandoned('alice')
    const before = row(id)
    expect(before.delivered_at).toBeNull()
    expect(requeueAbandonedForAgent('alice')).toEqual([id])
    const r = row(id)
    expect(r.status).toBe('pending')
    expect(r.result).toBeNull()
    expect(r.completed_at).toBeNull()
    expect(r.delivered_at).toBeNull()
    expect(r.content).toBe(before.content)
    expect(r.from_agent).toBe(before.from_agent)
    expect(r.created_at).toBe(before.created_at)
  })

  it('a done row overwritten to failed stays failed', () => {
    const id = createAgentMessage('carol', 'alice', 'd').id
    markMessageDone(id)
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.delivered_at).not.toBeNull()
  })

  it('a delivered row overwritten to failed stays failed', () => {
    const id = createAgentMessage('carol', 'alice', 'v').id
    markMessageDelivered(id)
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(id).status).toBe('failed')
    expect(row(id).delivered_at).not.toBeNull()
  })

  it('markPendingMessageFailed fails a pending row', () => {
    const id = createAgentMessage('carol', 'alice', 'x').id
    const before = row(id)
    expect(markPendingMessageFailed(id, ABANDONED_SESSION_ABSENT)).toBe(true)
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.result).toBe(ABANDONED_SESSION_ABSENT)
    expect(r.completed_at).toBeGreaterThanOrEqual(before.created_at)
  })

  it('markPendingMessageFailed leaves a done row alone', () => {
    const id = createAgentMessage('carol', 'alice', 'x').id
    markMessageDone(id, 'all good')
    const before = row(id)
    expect(markPendingMessageFailed(id, ABANDONED_SESSION_ABSENT)).toBe(false)
    const r = row(id)
    expect(r.status).toBe('done')
    expect(r.result).toBe('all good')
    expect(r.completed_at).toBe(before.completed_at)
  })

  it('markPendingMessageFailed leaves a delivered row alone', () => {
    const id = createAgentMessage('carol', 'alice', 'x').id
    markMessageDelivered(id)
    expect(markPendingMessageFailed(id, ABANDONED_SESSION_ABSENT)).toBe(false)
    expect(row(id).status).toBe('delivered')
  })

  it('T2 only the abandoned reason', () => {
    const id = createAgentMessage('sender', 'alice', 'x').id
    markMessageFailed(id, 'Invalid or empty from_agent')
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(id).status).toBe('failed')
  })

  it('T3 only that agent', () => {
    const id = abandoned('bob')
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(id).status).toBe('failed')
  })

  it('T4 age limit is 24 hours', () => {
    const old = abandoned('alice', NOW - 25 * HOUR)
    const recent = abandoned('alice', NOW - 23 * HOUR)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([recent])
    expect(row(old).status).toBe('failed')
    expect(row(recent).status).toBe('pending')
  })

  it('T5 cap keeps the newest, the rest stay failed for good', () => {
    const ids: number[] = []
    for (let i = 0; i < 25; i++) ids.push(abandoned('alice', NOW - 1000 + i))
    const got = requeueAbandonedForAgent('alice', { now: NOW })
    expect(got).toEqual(ids.slice(5))
    for (const id of ids.slice(0, 5)) {
      const r = row(id)
      expect(r.status).toBe('failed')
      expect(r.requeue_skipped_at).toBe(NOW)
      expect(r.requeued_at).toBeNull()
    }
    for (const id of ids.slice(5)) {
      expect(row(id).status).toBe('pending')
      expect(row(id).requeue_skipped_at).toBeNull()
    }
    // a second start requeues nothing: the leftovers carry the marker
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([])
    for (const id of ids.slice(0, 5)) {
      const r = row(id)
      expect(r.status).toBe('failed')
      expect(r.requeue_skipped_at).toBe(NOW)
    }
  })

  it('a row already carrying requeue_skipped_at is not revived', () => {
    const id = abandoned('alice', NOW - 100)
    getDb().prepare('UPDATE agent_messages SET requeue_skipped_at = ? WHERE id = ?').run(NOW - 50, id)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([])
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.requeue_skipped_at).toBe(NOW - 50)
    expect(r.requeued_at).toBeNull()
  })

  it('T6 at most once', () => {
    const id = abandoned('alice')
    expect(requeueAbandonedForAgent('alice')).toEqual([id])
    expect(row(id).status).toBe('pending')
    expect(row(id).requeued_at).not.toBeNull()
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(id).status).toBe('failed')
  })

  it('T7 done, delivered and pending rows untouched', () => {
    const done = createAgentMessage('sender', 'alice', 'd').id
    getDb().prepare("UPDATE agent_messages SET status = 'done', result = ? WHERE id = ?").run(ABANDONED_SESSION_ABSENT, done)
    const delivered = createAgentMessage('sender', 'alice', 'v').id
    getDb().prepare("UPDATE agent_messages SET status = 'delivered' WHERE id = ?").run(delivered)
    const pending = createAgentMessage('sender', 'alice', 'p').id
    const b1 = row(done), b2 = row(pending), b3 = row(delivered)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(done)).toEqual(b1)
    expect(row(pending)).toEqual(b2)
    expect(row(delivered)).toEqual(b3)
  })

  it('sender moved on: skipped; control without newer message is requeued', () => {
    const m1 = createAgentMessage('carol', 'alice', 'one').id
    markMessageFailed(m1, ABANDONED_SESSION_ABSENT)
    const m2 = createAgentMessage('erin', 'alice', 'two').id
    markMessageFailed(m2, ABANDONED_SESSION_ABSENT)
    const resent = createAgentMessage('carol', 'alice', 'resent').id
    setCreated(resent, row(m1).completed_at + 10)
    expect(requeueAbandonedForAgent('alice')).toEqual([m2])
    expect(row(m1).status).toBe('failed')
    expect(row(m2).status).toBe('pending')
  })

  it('a resend in the same second as the abandon is still seen', () => {
    const m = createAgentMessage('carol', 'alice', 'one').id
    markMessageFailed(m, ABANDONED_SESSION_ABSENT)
    const resent = createAgentMessage('carol', 'alice', 'resent').id
    setCreated(resent, row(m).completed_at)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    expect(row(m).status).toBe('failed')
  })

  it('returns the requeued ids oldest first by created_at, not by id', () => {
    const a = abandoned('alice', NOW - 100)
    const b = abandoned('alice', NOW - 200)
    expect(b).toBeGreaterThan(a)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([b, a])
  })

  it('newer message to another recipient does not block', () => {
    const m = createAgentMessage('carol', 'alice', 'one').id
    markMessageFailed(m, ABANDONED_SESSION_ABSENT)
    const other = createAgentMessage('carol', 'bob', 'other').id
    setCreated(other, row(m).completed_at + 10)
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('cap picks by age, not id', () => {
    const ids: number[] = []
    for (let i = 0; i < 21; i++) ids.push(abandoned('alice', NOW - 1000 + i))
    const last = ids[20]
    // the highest id, but the oldest row, still inside the 24 h window: only the cap keeps it out
    setCreated(last, NOW - 2 * HOUR)
    const got = requeueAbandonedForAgent('alice', { now: NOW })
    expect(got).toEqual(ids.slice(0, 20))
    expect(row(last).status).toBe('failed')
    expect(row(last).requeue_skipped_at).toBe(NOW)
  })

  it('cap 1: a row requeued before does not take the only slot', () => {
    const now = 1_900_000_000
    const old = abandoned('agent-c', now - 200)
    const prev = abandoned('agent-c', now - 100)
    getDb().prepare('UPDATE agent_messages SET requeued_at = ? WHERE id = ?').run(now - 50, prev)
    expect(row(prev).status).toBe('failed') // still failed + abandoned text, but already revived once
    expect(requeueAbandonedForAgent('agent-c', { cap: 1, now })).toEqual([old])
    expect(row(prev).status).toBe('failed')
  })

  it('cap 1: a newer failed row with another reason does not take the only slot', () => {
    const now = 1_900_000_000
    const old = abandoned('agent-d', now - 200)
    const other = createAgentMessage('s' + Math.random(), 'agent-d', 'x').id
    markMessageFailed(other, 'some other failure')
    setCreated(other, now - 100)
    expect(requeueAbandonedForAgent('agent-d', { cap: 1, now })).toEqual([old])
    expect(row(other).status).toBe('failed')
  })

  it('T8 cap 0 and maxAgeSec 0 do nothing', () => {
    const id = abandoned('alice')
    const snap = row(id)
    expect(requeueAbandonedForAgent('alice', { cap: 0 })).toEqual([])
    expect(requeueAbandonedForAgent('alice', { maxAgeSec: 0 })).toEqual([])
    expect(row(id)).toEqual(snap)
  })

  it('T9 constant text', () => {
    expect(ABANDONED_SESSION_ABSENT).toBe('Abandoned: target session absent for full retry window')
  })

  it('a stop row is never revived', () => {
    const id = abandoned('alice', NOW - 2 * HOUR)
    getDb().prepare('UPDATE agent_messages SET stop_authorized = 1 WHERE id = ?').run(id)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([])
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.result).toBe(ABANDONED_SESSION_ABSENT)
    expect(r.requeued_at).toBeNull()
    expect(r.requeue_skipped_at).toBeNull()
  })

  it('an urgent row is never revived', () => {
    const id = abandoned('alice', NOW - 2 * HOUR)
    getDb().prepare('UPDATE agent_messages SET urgent = 1 WHERE id = ?').run(id)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([])
    const r = row(id)
    expect(r.status).toBe('failed')
    expect(r.result).toBe(ABANDONED_SESSION_ABSENT)
    expect(r.requeued_at).toBeNull()
    expect(r.requeue_skipped_at).toBeNull()
  })

  it('control: the same row without the flags is revived', () => {
    const id = abandoned('alice', NOW - 2 * HOUR)
    expect(row(id).stop_authorized).toBe(0)
    expect(row(id).urgent).toBe(0)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([id])
    expect(row(id).status).toBe('pending')
  })

  it('a stop row does not block a plain row next to it', () => {
    // Two different senders (the helper picks a random one), so neither row's
    // "same sender moved on" check can see the other.
    const stop = abandoned('alice', NOW - 2 * HOUR)
    getDb().prepare('UPDATE agent_messages SET stop_authorized = 1 WHERE id = ?').run(stop)
    const plain = abandoned('alice', NOW - 2 * HOUR + 10)
    expect(row(stop).from_agent).not.toBe(row(plain).from_agent)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([plain])
    expect(row(stop).status).toBe('failed')
    expect(row(plain).status).toBe('pending')
  })
})

describe('cardAnchors', () => {
  it('distinct bracketed card ids, in order of first appearance', () => {
    expect(cardAnchors('[ABCDEF1234] x [QWERTY5678] y [ABCDEF1234]')).toEqual(['[ABCDEF1234]', '[QWERTY5678]'])
  })

  it('tags, lower case, separators and short ids are not anchors', () => {
    expect(cardAnchors('[HOLD] [URGENT] [abcdef1234] [ABC-1234] [AB12]')).toEqual([])
  })

  it('null and empty content have no anchors', () => {
    expect(cardAnchors(null)).toEqual([])
    expect(cardAnchors('')).toEqual([])
    expect(cardAnchors(undefined)).toEqual([])
  })
})

// The card-anchor "moved on" rule: carol abandoned a handoff to alice naming
// card [ABCDEF1234], then wrote to bob. Only a newer carol message that carries
// THE SAME card (brackets and case included) counts as having moved on.
function abandonedWithCard(): number {
  const id = createAgentMessage('carol', 'alice', '[ABCDEF1234] task').id
  markMessageFailed(id, ABANDONED_SESSION_ABSENT)
  return id
}
function newerMessage(from: string, content: string, afterId: number): number {
  const id = createAgentMessage(from, 'bob', content).id
  setCreated(id, row(afterId).completed_at + 10)
  return id
}

describe('card-anchor moved on', () => {
  it('the same card re-sent to another recipient blocks the revive', () => {
    const m = abandonedWithCard()
    newerMessage('carol', '[ABCDEF1234] again', m)
    expect(requeueAbandonedForAgent('alice')).toEqual([])
    const r = row(m)
    expect(r.status).toBe('failed')
    expect(r.requeue_skipped_at).toBeNull()
    expect(r.requeued_at).toBeNull()
  })

  it('control: a different card does not block', () => {
    const m = abandonedWithCard()
    newerMessage('carol', '[QWERTY5678] other', m)
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('control: another sender carrying the same card does not block', () => {
    const m = abandonedWithCard()
    newerMessage('dave', '[ABCDEF1234]', m)
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('control: the same card in lower case does not block', () => {
    const m = abandonedWithCard()
    newerMessage('carol', '[abcdef1234]', m)
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('control: the card id without brackets does not block', () => {
    const m = abandonedWithCard()
    newerMessage('carol', 'ABCDEF1234 without brackets', m)
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('control: the same card written before the abandon does not block', () => {
    const m = abandonedWithCard()
    const n = newerMessage('carol', '[ABCDEF1234]', m) // larger id...
    setCreated(n, row(m).completed_at - 10) // ...but written before the abandon
    expect(requeueAbandonedForAgent('alice')).toEqual([m])
  })

  it('an anchor-blocked row does not use up the cap', () => {
    const blocked = createAgentMessage('carol', 'alice', '[ABCDEF1234] task').id
    markMessageFailed(blocked, ABANDONED_SESSION_ABSENT)
    newerMessage('carol', '[ABCDEF1234] again', blocked)
    const plain = createAgentMessage('dave', 'alice', 'plain').id
    markMessageFailed(plain, ABANDONED_SESSION_ABSENT)
    setCreated(plain, row(blocked).created_at - 100)
    expect(requeueAbandonedForAgent('alice', { cap: 1 })).toEqual([plain])
    const r = row(blocked)
    expect(r.status).toBe('failed')
    expect(r.requeue_skipped_at).toBeNull()
  })
})

describe('requeue notices', () => {
  it('one notice to the sender, one to the main agent', () => {
    const id = createAgentMessage('carol', 'alice', 'task').id
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedAndNotify('alice')).toEqual([id])
    const toCarol = systemMessages('carol')
    expect(toCarol).toHaveLength(1)
    expect(toCarol[0].content.startsWith(`[ÚJRAKÉZBESÍTVE] msg_id:${id} -> alice:`)).toBe(true)
    expect(toCarol[0].content).toContain(`PUT /api/messages/${id}`)
    const toMain = systemMessages(MAIN_AGENT_ID)
    expect(toMain).toHaveLength(1)
    expect(toMain[0].content.startsWith(`[ÚJRAKÉZBESÍTVE] msg_id:${id} carol -> alice:`)).toBe(true)
  })

  it('two rows from one sender give ONE notice with two lines', () => {
    const a = createAgentMessage('carol', 'alice', 'one').id
    const b = createAgentMessage('carol', 'alice', 'two').id
    markMessageFailed(a, ABANDONED_SESSION_ABSENT)
    markMessageFailed(b, ABANDONED_SESSION_ABSENT)
    // Both rows must be revivable, so neither may look like a resend of the
    // other: keep every created_at below the earlier abandon's completed_at.
    setCreated(a, row(a).completed_at - 10)
    setCreated(b, row(b).completed_at - 20)
    expect(requeueAbandonedAndNotify('alice')).toEqual([b, a])
    const toCarol = systemMessages('carol')
    expect(toCarol).toHaveLength(1)
    expect(toCarol[0].content.split('\n')).toHaveLength(2)
    const toMain = systemMessages(MAIN_AGENT_ID)
    expect(toMain).toHaveLength(1)
    expect(toMain[0].content.split('\n')).toHaveLength(2)
    expect(toMain[0].content.startsWith(`[ÚJRAKÉZBESÍTVE] msg_id:${b} carol -> alice:`)).toBe(true)
  })

  it('a row whose sender is system gets no sender notice', () => {
    const id = createAgentMessage('system', 'alice', 'task').id
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    const before = systemMessages().length
    expect(requeueAbandonedAndNotify('alice')).toEqual([id])
    expect(systemMessages().length).toBe(before + 1) // only the main agent's line
    expect(systemMessages().at(-1).to_agent).toBe(MAIN_AGENT_ID)
    expect(systemMessages('system')).toEqual([])
  })

  it('a row whose sender is the main agent gives exactly one notice to it', () => {
    const id = createAgentMessage(MAIN_AGENT_ID, 'alice', 'task').id
    markMessageFailed(id, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedAndNotify('alice')).toEqual([id])
    const toMain = systemMessages(MAIN_AGENT_ID)
    expect(toMain).toHaveLength(1)
    expect(toMain[0].content.startsWith(`[ÚJRAKÉZBESÍTVE] msg_id:${id} ${MAIN_AGENT_ID} -> alice:`)).toBe(true)
  })

  it('a row addressed to the main agent gives it no digest line, only the revived row', () => {
    const toMainRow = createAgentMessage('carol', MAIN_AGENT_ID, 'task for main').id
    markMessageFailed(toMainRow, ABANDONED_SESSION_ABSENT)
    expect(requeueAbandonedAndNotify(MAIN_AGENT_ID)).toEqual([toMainRow])
    expect(systemMessages(MAIN_AGENT_ID)).toEqual([])
    expect(row(toMainRow).status).toBe('pending')
    // control: the sender is still told
    const toCarol = systemMessages('carol')
    expect(toCarol).toHaveLength(1)
    expect(toCarol[0].content.startsWith(`[ÚJRAKÉZBESÍTVE] msg_id:${toMainRow} -> ${MAIN_AGENT_ID}:`)).toBe(true)
  })

  it('nothing revived sends no system messages at all', () => {
    const id = createAgentMessage('carol', 'alice', 'still pending').id
    const before = systemMessages().length
    expect(requeueAbandonedAndNotify('alice')).toEqual([])
    expect(systemMessages().length).toBe(before)
    expect(row(id).status).toBe('pending')
  })
})

// Static wiring: the function is only useful if every agent start calls it, and
// the router must keep writing the exact reason the requeue selects on.
const here = dirname(fileURLToPath(import.meta.url))
const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('requeue wiring', () => {
  it('startAgentProcess requeues before its success return', () => {
    const src = stripComments(readFileSync(join(here, '../web/agent-process.ts'), 'utf8'))
    const start = src.indexOf('export async function startAgentProcess(')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('\nexport ', start + 1))
    const call = body.indexOf('requeueAbandonedAndNotify(name)')
    const brief = body.indexOf('scheduleRecoveryBrief(')
    expect(call).toBeGreaterThan(brief)
    expect(brief).toBeGreaterThan(0)
    const ret = body.indexOf('return { ok: true }', brief)
    expect(ret).toBeGreaterThan(call)
  })

  it('startRemoteAgentProcess requeues before its success return', () => {
    const src = stripComments(readFileSync(join(here, '../web/agent-process.ts'), 'utf8'))
    const start = src.indexOf('function startRemoteAgentProcess(')
    expect(start).toBeGreaterThan(0)
    const nextFn = src.indexOf('\nfunction ', start + 1)
    const nextExport = src.indexOf('\nexport ', start + 1)
    const end = nextFn === -1 ? nextExport : nextExport === -1 ? nextFn : Math.min(nextFn, nextExport)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    const call = body.indexOf('requeueAbandonedAndNotify(name, host)')
    const setup = body.indexOf('scheduleIdentitySetup(')
    expect(setup).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(setup)
    const ret = body.indexOf('return { ok: true }', setup)
    expect(ret).toBeGreaterThan(call)
  })

  it('agent-process no longer calls the raw requeue itself', () => {
    const src = readFileSync(join(here, '../web/agent-process.ts'), 'utf8')
    expect(src).not.toContain('requeueAbandonedForAgent(')
  })

  it('the router abandons with the guarded pending-only write', () => {
    const src = stripComments(readFileSync(join(here, '../web/message-router.ts'), 'utf8'))
    expect(src).toContain('markPendingMessageFailed(msg.id, ABANDONED_SESSION_ABSENT)')
    expect(src).not.toContain('markMessageFailed(msg.id, ABANDONED_SESSION_ABSENT)')
    expect(src).not.toContain('Abandoned: target session absent for full retry window')
  })

  it('a row the router did not close itself earns no failure notice, neither to the main agent nor to the sender', () => {
    const src = stripComments(readFileSync(join(here, '../web/message-router.ts'), 'utf8'))
    const start = src.indexOf('const closed = markPendingMessageFailed(msg.id, ABANDONED_SESSION_ABSENT)')
    expect(start).toBeGreaterThan(0)
    const branch = src.slice(start, src.indexOf('routerInjectFailures.delete(msg.id)', start))
    const guard = branch.indexOf('if (closed) {')
    const orElse = branch.indexOf('} else {')
    expect(guard).toBeGreaterThan(0)
    expect(orElse).toBeGreaterThan(guard)
    for (const call of ['notifyOrchestratorOfFailedHandoff(msg,', 'notifySenderOfFailedHandoff(msg,']) {
      const at = branch.indexOf(call)
      expect(at, call).toBeGreaterThan(guard)
      expect(at, call).toBeLessThan(orElse)
      expect(branch.indexOf(call, at + 1), call).toBe(-1)
    }
  })

  it('requeue-notice imports neither agent-process nor the router', () => {
    const src = readFileSync(join(here, '../web/requeue-notice.ts'), 'utf8')
    expect(src).not.toContain("'./agent-process.js'")
    expect(src).not.toContain("'./message-router.js'")
  })
})
