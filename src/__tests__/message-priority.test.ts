import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase,
  getDb,
  createAgentMessage,
  getPendingMessages,
  claimPendingForAgent,
  type AgentMessage,
} from '../db.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'
import { selectTickWindow } from '../web/message-router-window.js'
import { MAX_MESSAGES_PER_TICK } from '../web/message-router.js'
import { decidePriority, parsePriorityField, HIGH_PRIORITY_PER_HOUR_DEFAULT } from '../web/message-priority.js'
import { oldestPendingAgeMs } from '../web/inbox-nudge-watcher.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// Card ad771121: priority delivery on the inter-agent queue. Delivery was strictly FIFO, so an urgent
// instruction sat behind every older row of a busy recipient (the measured case: three GO messages
// behind 10, 11 and 43 rows; each needed a manual tmux nudge). Measured here on a REAL SQLite (the
// in-memory DB the other route tests use) and through the REAL POST route:
//   - POSITIVE CONTROL: a high row sent into an artificially filled queue (>= 10 pending) is the next
//     one delivered -- the main agent's real claim returns it first, and the router's real tick window
//     puts it first for its recipient;
//   - NEGATIVE CONTROL: normal rows into the same queue stay FIFO, and without a priority field nothing
//     changes (absent = "normal");
//   - an unknown value is a loud 400, the hourly high budget of a (sender, recipient) pair downgrades
//     (never drops) and the answer says so, next to the existing queue field (#1674), which stays as it is.
// The router's batch order with a high head is measured in message-priority-router.test.ts. The file
// ends with the tick window above MAX_MESSAGES_PER_TICK recipients (the window finding) and the guards
// taken over from the independent test; agent-msg.sh's --priority is measured in
// scripts/__tests__/agent-msg-priority.test.py.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: any }> {
  const { ctx, res } = fakeCtx(body)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

const nowSec = () => Math.floor(Date.now() / 1000)
const setCreated = (id: number, sec: number) => getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?').run(sec, id)
const setRow = (id: number, created: number, status = 'pending') =>
  getDb().prepare('UPDATE agent_messages SET created_at = ?, status = ? WHERE id = ?').run(created, status, id)
const storedStatus = (id: number) => (getDb().prepare('SELECT status FROM agent_messages WHERE id = ?').get(id) as { status: string }).status
const pendingCount = (to: string) => (getDb().prepare("SELECT count(*) AS n FROM agent_messages WHERE to_agent = ? AND status = 'pending'").get(to) as { n: number }).n
const storedPriority = (id: number) => (getDb().prepare('SELECT priority FROM agent_messages WHERE id = ?').get(id) as { priority: number }).priority

/** `n` normal rows to `to` from three senders, oldest first, one minute apart (backdated). */
function fillQueue(to: string, n: number): AgentMessage[] {
  const base = nowSec() - 3600
  const rows: AgentMessage[] = []
  for (let i = 0; i < n; i++) {
    const m = createAgentMessage(`kuldo-${i % 3}`, to, `normal row ${i}`)
    setCreated(m.id, base + i * 60)
    rows.push({ ...m, created_at: base + i * 60 })
  }
  return rows
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().prepare('DELETE FROM agent_messages').run()
  delete process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR
})
afterEach(() => {
  delete process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR
})

describe('the delivery order on a real SQLite', () => {
  it('POSITIVE CONTROL: a high row sent into 12 pending rows is the next one the main agent claims', async () => {
    const normals = fillQueue(MAIN_AGENT_ID, 12)
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'urgent GO', priority: 'high' })
    expect(r.statusCode).toBe(200)
    expect(storedPriority(r.json.id)).toBe(1)
    expect(r.json.priority).toBe(1)
    expect(r.json.downgraded).toBeUndefined()
    expect(getPendingMessages(MAIN_AGENT_ID)[0].id).toBe(r.json.id)
    // the real pull-drain claim: the high row first, then the oldest normal rows in FIFO
    const claimed = claimPendingForAgent(MAIN_AGENT_ID, 3)
    expect(claimed.map((m) => m.id)).toEqual([r.json.id, normals[0].id, normals[1].id])
  })

  it('POSITIVE CONTROL, router path: the real tick window puts the high row first for its recipient', () => {
    const normals = fillQueue('prio-celpont', 12)
    fillQueue('masik-celpont', 3)
    const high = createAgentMessage('kuldo-x', 'prio-celpont', 'urgent GO', null, null, 1)
    const window = selectTickWindow(getPendingMessages(), 25, MAIN_AGENT_ID)
    const forTarget = window.filter((m) => m.to_agent === 'prio-celpont').map((m) => m.id)
    expect(forTarget[0]).toBe(high.id)
    expect(forTarget.slice(1)).toEqual(normals.map((m) => m.id).slice(0, forTarget.length - 1))
    // the other recipient keeps its own FIFO rows in the window (fairness unchanged)
    expect(window.some((m) => m.to_agent === 'masik-celpont')).toBe(true)
  })

  it('NEGATIVE CONTROL: normal rows into the same queue stay FIFO, behind the high rows', async () => {
    const normals = fillQueue(MAIN_AGENT_ID, 12)
    const high = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'urgent', priority: 'high' })
    const late = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'an ordinary row' })
    expect(late.statusCode).toBe(200)
    expect(storedPriority(late.json.id)).toBe(0)
    expect(late.json.priority).toBe(0)
    expect(late.json.downgraded).toBeUndefined()
    const order = getPendingMessages(MAIN_AGENT_ID).map((m) => m.id)
    expect(order).toEqual([high.json.id, ...normals.map((m) => m.id), late.json.id])
  })

  it('NEGATIVE CONTROL: without any high row the order is exactly the old FIFO (created_at, then id)', () => {
    const rows = fillQueue('fifo-celpont', 10)
    // two rows in the same second: the id breaks the tie, as the old claim did
    const a = createAgentMessage('kuldo-a', 'fifo-celpont', 'same second A')
    const b = createAgentMessage('kuldo-b', 'fifo-celpont', 'same second B')
    setCreated(a.id, nowSec()); setCreated(b.id, nowSec())
    expect(getPendingMessages('fifo-celpont').map((m) => m.id)).toEqual([...rows.map((m) => m.id), a.id, b.id])
  })

  it('two high rows: FIFO between them, both ahead of every normal row', () => {
    const normals = fillQueue('ket-high', 4)
    const h1 = createAgentMessage('kuldo-1', 'ket-high', 'first high', null, null, 1)
    const h2 = createAgentMessage('kuldo-2', 'ket-high', 'second high', null, null, 1)
    setCreated(h1.id, nowSec() - 10); setCreated(h2.id, nowSec() - 5)
    expect(getPendingMessages('ket-high').map((m) => m.id)).toEqual([h1.id, h2.id, ...normals.map((m) => m.id)])
  })

})

describe('the priority field on POST /api/messages', () => {
  it('ABSENT means normal: today\'s FIFO, stored 0, the row goes last', async () => {
    fillQueue(MAIN_AGENT_ID, 3)
    for (const body of [{}, { priority: null }, { priority: 'normal' }]) {
      const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'x', ...body })
      expect(r.statusCode).toBe(200)
      expect(storedPriority(r.json.id)).toBe(0)
      expect(r.json.priority).toBe(0)
      expect(r.json.downgraded).toBeUndefined()
      const order = getPendingMessages(MAIN_AGENT_ID)
      expect(order[order.length - 1].id).toBe(r.json.id)
    }
  })

  it('an unknown value is a loud 400 and no row is created', async () => {
    for (const priority of ['urgent', 'HIGH', 'High', 1, true, '', ' high']) {
      const before = pendingCount(MAIN_AGENT_ID)
      const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'x', priority })
      expect(r.statusCode, JSON.stringify(priority)).toBe(400)
      expect(String(r.json.error)).toContain('priority')
      expect(pendingCount(MAIN_AGENT_ID)).toBe(before)
    }
  })

  it('K3: the sender\'s sixth high in an hour is accepted as NORMAL (downgraded), not dropped', async () => {
    expect(HIGH_PRIORITY_PER_HOUR_DEFAULT).toBe(5)
    const answers = []
    for (let i = 0; i < 6; i++) answers.push(await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: `go ${i}`, priority: 'high' }))
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 200, 200])
    expect(answers.map((a) => storedPriority(a.json.id))).toEqual([1, 1, 1, 1, 1, 0])
    expect(answers[5].json).toMatchObject({ priority: 0, downgraded: true })
    expect(answers[4].json.downgraded).toBeUndefined()
  })

  it('K3: the budget is configurable, and 0 downgrades every high', async () => {
    process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR = '0'
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'go', priority: 'high' })
    expect(storedPriority(r.json.id)).toBe(0)
    expect(r.json.downgraded).toBe(true)
    process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR = '2'
    const two = [await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'a', priority: 'high' }),
      await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'b', priority: 'high' }),
      await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'c', priority: 'high' })]
    expect(two.map((a) => storedPriority(a.json.id))).toEqual([1, 1, 0])
    process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR = 'sok'
    expect(decidePriority('high', 'uj-kuldo', 'cel', nowSec())).toEqual({ priority: 1, downgraded: false })
  })

  it('K3: only the SAME pair\'s accepted highs inside the last hour count', () => {
    for (let i = 0; i < 5; i++) createAgentMessage('masik-kuldo', 'cel', 'h', null, null, 1)
    const old = [0, 1, 2, 3, 4].map(() => createAgentMessage('ez-a-kuldo', 'cel', 'old high', null, null, 1))
    old.forEach((m) => setCreated(m.id, nowSec() - 2 * 3600))
    expect(decidePriority('high', 'ez-a-kuldo', 'cel', nowSec())).toEqual({ priority: 1, downgraded: false })
    expect(decidePriority('normal', 'ez-a-kuldo', 'cel', nowSec())).toEqual({ priority: 0, downgraded: false })
    expect(decidePriority('high', 'masik-kuldo', 'cel', nowSec())).toEqual({ priority: 0, downgraded: true })
    // the same sender's budget toward ANOTHER recipient is untouched, and so is another sender's toward this one
    expect(decidePriority('high', 'masik-kuldo', 'masik-cel', nowSec())).toEqual({ priority: 1, downgraded: false })
    expect(decidePriority('high', 'harmadik-kuldo', 'cel', nowSec())).toEqual({ priority: 1, downgraded: false })
  })

  it('K3: an urgent warning fanned out to twenty recipients stays high in every queue', () => {
    const rows = Array.from({ length: 20 }, (_, i) => {
      const d = decidePriority('high', 'lead-sender', `worker-${i}`, nowSec())
      return createAgentMessage('lead-sender', `worker-${i}`, 'urgent', null, null, d.priority)
    })
    expect(rows.map((m) => storedPriority(m.id))).toEqual(Array(20).fill(1))
  })

  it('K3 through the route: the budget belongs to the (sender, recipient) pair the row is stored under', async () => {
    const fromOwner: { statusCode: number; json: any }[] = []
    for (let i = 0; i < 6; i++) fromOwner.push(await post({ from: OWNER_NAME, to: MAIN_AGENT_ID, content: `go ${i}`, priority: 'high' }))
    expect(fromOwner.map((r) => r.statusCode)).toEqual(Array(6).fill(200))
    expect(fromOwner.map((r) => storedPriority(r.json.id))).toEqual([1, 1, 1, 1, 1, 0])
    expect(fromOwner[5].json.downgraded).toBe(true)
    // another sender toward the same recipient has its own budget
    const other = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'go', priority: 'high' })
    expect(other.statusCode).toBe(200)
    expect(storedPriority(other.json.id)).toBe(1)
  })

  it('the answer keeps the queue field (#1674) as it is, and says downgraded only on a downgraded row', async () => {
    process.env.MESSAGE_HIGH_PRIORITY_PER_HOUR = '1'
    const first = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'a', priority: 'high' })
    expect(first.statusCode).toBe(200)
    expect(first.json.priority).toBe(1)
    expect(first.json.downgraded).toBeUndefined()
    expect(first.json.queue).toMatchObject({ queueDepth: 1, estimatedDelaySec: null })
    const second = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'b', priority: 'high' })
    expect(second.statusCode).toBe(200)
    expect(second.json.priority).toBe(0)
    expect(second.json.downgraded).toBe(true)
    expect(second.json.queue).toMatchObject({ queueDepth: 2, estimatedDelaySec: null })
    const plain = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'c' })
    expect(plain.json.downgraded).toBeUndefined()
    expect(Object.keys(plain.json.queue).sort()).toEqual(['estimatedDelaySec', 'oldestPendingSec', 'queueDepth'])
  })
})

// The window finding (the card's decision: the behavior stays, pinned here). With more recipients waiting than
// MAX_MESSAGES_PER_TICK the router's tick window cannot hold all of them; a high row brings its recipient
// in first, and the recipient that came last by age stays out. Measured as a DIFFERENTIAL against the
// base order (FIFO, re-sorted here), the way the card's independent test measured it.
describe('the window finding: the tick window with more recipients than MAX_MESSAGES_PER_TICK', () => {
  const cel = (i: number) => `cel-${String(i).padStart(2, '0')}`
  const fifo = (rows: AgentMessage[]) => [...rows].sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
  const inWindow = (rows: AgentMessage[]) =>
    new Set(selectTickWindow(rows, MAX_MESSAGES_PER_TICK, MAIN_AGENT_ID).map((m) => m.to_agent))

  it('a high row brings its recipient into the window, and the recipient that came last by age stays out', () => {
    const base = nowSec() - 3600
    const n = MAX_MESSAGES_PER_TICK + 5
    for (let i = 0; i < n; i++) setCreated(createAgentMessage('kuldo', cel(i), `old ${i}`).id, base + i)
    // the youngest recipient also gets one high row, the newest row of all
    setCreated(createAgentMessage('kuldo', cel(n - 1), 'urgent', null, null, 1).id, base + n + 10)
    const delivery = getPendingMessages()
    const fifoWindow = inWindow(fifo(delivery))
    const deliveryWindow = inWindow(delivery)
    expect(fifoWindow.size).toBe(MAX_MESSAGES_PER_TICK)
    expect(deliveryWindow.size).toBe(MAX_MESSAGES_PER_TICK)
    expect([...deliveryWindow].filter((t) => !fifoWindow.has(t))).toEqual([cel(n - 1)])
    expect([...fifoWindow].filter((t) => !deliveryWindow.has(t))).toEqual([cel(MAX_MESSAGES_PER_TICK - 1)])
  })

  it('NEGATIVE CONTROL: with MAX_MESSAGES_PER_TICK recipients or fewer the window holds every recipient either way', () => {
    const base = nowSec() - 3600
    for (let i = 0; i < MAX_MESSAGES_PER_TICK; i++) setCreated(createAgentMessage('kuldo', cel(i), 'x').id, base + i)
    setCreated(createAgentMessage('kuldo', cel(MAX_MESSAGES_PER_TICK - 1), 'u', null, null, 1).id, base + 99)
    const delivery = getPendingMessages()
    expect(inWindow(fifo(delivery)).size).toBe(MAX_MESSAGES_PER_TICK)
    expect(inWindow(delivery).size).toBe(MAX_MESSAGES_PER_TICK)
  })
})

// Guards taken over from the card's independent test. On its mutants each was the only test to turn red:
// a same-second tie ordered wrong -> the random queues; M5 (the budget window's edge made exclusive) ->
// the 3600 s edge; M6 (the budget counting pending rows only) -> the delivered/done rows. The oracle is
// written here from the card's rule, never imported from the code it measures.
describe('guards from the independent test', () => {
  const oracle = (rows: Array<{ id: number; created_at: number; priority: number }>) =>
    [...rows].sort((a, b) => (b.priority - a.priority) || (a.created_at - b.created_at) || (a.id - b.id))
  // a small deterministic PRNG, so a red run can be replayed by its seed
  function rng(seed: number) {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  }

  for (const seed of [1, 7, 42, 2026, 99991]) {
    it(`seed ${seed}: on random queues with same-second ties the lists and the claim follow the oracle`, () => {
      const r = rng(seed)
      const recipients = ['cel-a', 'cel-b', 'cel-c', 'cel-d', 'cel-e']
      const base = nowSec() - 7200
      const all: Array<{ id: number; to: string; created_at: number; priority: number; status: string }> = []
      for (let i = 0; i < 240; i++) {
        const to = recipients[Math.floor(r() * recipients.length)]
        const priority = r() < 0.2 ? 1 : 0
        const m = createAgentMessage(`kuldo-${i % 4}`, to, `row ${i}`, null, null, priority as 0 | 1)
        // few distinct seconds, so same-second ties (broken by the id) are common
        const created = base + Math.floor(r() * 30)
        const status = r() < 0.25 ? (r() < 0.5 ? 'delivered' : 'done') : 'pending'
        setRow(m.id, created, status)
        all.push({ id: m.id, to, created_at: created, priority, status })
      }
      const pending = all.filter((m) => m.status === 'pending')
      expect(getPendingMessages().map((m) => m.id)).toEqual(oracle(pending).map((m) => m.id))
      for (const to of recipients) {
        const want = oracle(pending.filter((m) => m.to === to))
        expect(getPendingMessages(to).map((m) => m.id), to).toEqual(want.map((m) => m.id))
        // the pull claim takes exactly the oracle's head, in the oracle's order, and marks it delivered
        const k = Math.min(5, want.length)
        const claimed = claimPendingForAgent(to, k)
        expect(claimed.map((m) => m.id), `${to} claim`).toEqual(want.slice(0, k).map((m) => m.id))
        expect(claimed.every((m) => storedStatus(m.id) === 'delivered')).toBe(true)
      }
    })
  }

  it('a high created exactly 3600 s before counts against the budget, one created 3601 s before does not', () => {
    const now = nowSec()
    const rows = [0, 1, 2, 3, 4].map(() => createAgentMessage('kuldo', 'cel', 'h', null, null, 1))
    rows.slice(0, 4).forEach((m) => setRow(m.id, now - 100))
    setRow(rows[4].id, now - 3600)
    expect(decidePriority('high', 'kuldo', 'cel', now, 5)).toEqual({ priority: 0, downgraded: true })
    setRow(rows[4].id, now - 3601)
    expect(decidePriority('high', 'kuldo', 'cel', now, 5)).toEqual({ priority: 1, downgraded: false })
  })

  it('an accepted high still counts after it was delivered or done (the budget is on acceptance, not on the queue)', () => {
    const now = nowSec()
    const rows = [0, 1, 2, 3, 4].map(() => createAgentMessage('kuldo', 'cel', 'h', null, null, 1))
    rows.forEach((m, i) => setRow(m.id, now - 60, i % 2 ? 'delivered' : 'done'))
    expect(decidePriority('high', 'kuldo', 'cel', now, 5)).toEqual({ priority: 0, downgraded: true })
  })
})

describe('pure helpers', () => {
  it('parsePriorityField: absent = normal, only two values', () => {
    expect(parsePriorityField(undefined)).toEqual({ ok: true, level: 'normal' })
    expect(parsePriorityField(null)).toEqual({ ok: true, level: 'normal' })
    expect(parsePriorityField('high')).toEqual({ ok: true, level: 'high' })
    expect(parsePriorityField('urgent').ok).toBe(false)
  })


  it('oldestPendingAgeMs: a fresh high row at the head does not make an old inbox look young', () => {
    const now = 1_000_000_000
    const rows = [{ created_at: now / 1000 - 5 }, { created_at: now / 1000 - 600 }, { created_at: now / 1000 - 60 }]
    expect(oldestPendingAgeMs(rows, now)).toBe(600_000)
    expect(oldestPendingAgeMs([], now)).toBe(0)
  })

})
