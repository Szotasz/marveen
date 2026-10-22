import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, createAgentMessage, markMessageFailed, requeueAbandonedForAgent, ABANDONED_SESSION_ABSENT } from '../db.js'

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

const DAY = 86400
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

describe('requeueAbandonedForAgent', () => {
  it('T1 requeues an abandoned message', () => {
    const id = abandoned('alice')
    const before = row(id)
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

  it('T4 age limit', () => {
    const old = abandoned('alice', NOW - 8 * DAY)
    const recent = abandoned('alice', NOW - 6 * DAY)
    expect(requeueAbandonedForAgent('alice', { now: NOW })).toEqual([recent])
    expect(row(old).status).toBe('failed')
    expect(row(recent).status).toBe('pending')
  })

  it('T5 cap keeps the newest', () => {
    const ids: number[] = []
    for (let i = 0; i < 25; i++) ids.push(abandoned('alice', NOW - 1000 + i))
    const got = requeueAbandonedForAgent('alice', { now: NOW })
    expect(got).toEqual(ids.slice(5))
    for (const id of ids.slice(0, 5)) expect(row(id).status).toBe('failed')
    for (const id of ids.slice(5)) expect(row(id).status).toBe('pending')
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
    setCreated(last, NOW - 5 * DAY)
    const got = requeueAbandonedForAgent('alice', { now: NOW })
    expect(got).toEqual(ids.slice(0, 20))
    expect(row(last).status).toBe('failed')
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
    const call = body.indexOf('requeueAbandonedForAgent(name)')
    const brief = body.indexOf('scheduleRecoveryBrief(')
    expect(call).toBeGreaterThan(brief)
    expect(brief).toBeGreaterThan(0)
    const ret = body.indexOf('return { ok: true }', brief)
    expect(ret).toBeGreaterThan(call)
  })

  it('the router abandons with the shared constant, not a copy of the text', () => {
    const src = stripComments(readFileSync(join(here, '../web/message-router.ts'), 'utf8'))
    expect(src).toContain('markMessageFailed(msg.id, ABANDONED_SESSION_ABSENT)')
    expect(src).not.toContain('Abandoned: target session absent for full retry window')
  })
})
