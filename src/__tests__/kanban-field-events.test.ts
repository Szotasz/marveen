// Contract tests for the kanban field-change audit trail (card f6fba9ec).
//
// An audit asking "when did this card's deadline move, and who moved it" had nothing to read:
// kanban_card_events holds status transitions only, and updated_at is no event record. Measured
// 2026-09-20 on one board: without that answer a four-hour audit reported 39 false positives among
// 126 cards.
//
// The changes now go to a table of their own, kanban_card_field_events, NOT into
// kanban_card_events: every reader of that table (the stuck detector, the status-age queries,
// fleet-transfer) takes a row there as a status transition. So these tests pin both halves: a
// real change of due_date, assignee or priority writes exactly one field row with the actor, and
// kanban_card_events does not move.
//
// The real production entry points on an in-memory database, the way kanban-update-audit.test.ts
// does it, plus the PUT and GET routes end to end.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase,
  getDb,
  createKanbanCard,
  updateKanbanCard,
  getKanbanCard,
  getKanbanCardEvents,
  getKanbanCardFieldEvents,
  KANBAN_AUDITED_FIELDS,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const DUE = 1790000000
const LATER = DUE + 86400

function statusEventRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_card_events').get() as { n: number }).n
}
function fieldRows(cardId: string) {
  return getKanbanCardFieldEvents(cardId).map(({ field, old_value, new_value, actor }) => ({ field, old_value, new_value, actor }))
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('updateKanbanCard: one kanban_card_field_events row per REAL change of due_date, assignee, priority', () => {
  it('the audited set is exactly due_date, assignee, priority', () => {
    expect([...KANBAN_AUDITED_FIELDS]).toEqual(['due_date', 'assignee', 'priority'])
  })

  it('a due-only change: one row with old, new and actor, NO status event; updated_at still moves (#1257, a control)', () => {
    createKanbanCard({ id: 'due', title: 'Deadline card', due_date: DUE })
    getDb().prepare('UPDATE kanban_cards SET updated_at = 1 WHERE id = ?').run('due')
    const before = statusEventRows()

    expect(updateKanbanCard('due', { due_date: LATER }, 'dev-a')).toBe(true)

    expect(fieldRows('due')).toEqual([{ field: 'due_date', old_value: String(DUE), new_value: String(LATER), actor: 'dev-a' }])
    expect(getKanbanCardFieldEvents('due')[0].card_id).toBe('due')
    expect(typeof getKanbanCardFieldEvents('due')[0].created_at).toBe('number')
    expect(statusEventRows()).toBe(before)
    expect(getKanbanCardEvents('due')).toHaveLength(0)
    expect(getKanbanCard('due')!.updated_at).toBeGreaterThan(1)
  })

  it('an assignee change and a priority change: one row each', () => {
    createKanbanCard({ id: 'who', title: 'Reassigned', assignee: 'dev-a', priority: 'normal' })

    updateKanbanCard('who', { assignee: 'dev-b' }, 'lead')
    updateKanbanCard('who', { priority: 'high' }, 'lead')

    expect(fieldRows('who')).toEqual([
      { field: 'assignee', old_value: 'dev-a', new_value: 'dev-b', actor: 'lead' },
      { field: 'priority', old_value: 'normal', new_value: 'high', actor: 'lead' },
    ])
  })

  it('all three in one write: three rows, one per field', () => {
    createKanbanCard({ id: 'all', title: 'Three at once', assignee: 'a', priority: 'low', due_date: DUE })

    updateKanbanCard('all', { due_date: LATER, assignee: 'b', priority: 'urgent' }, 'x')

    expect(fieldRows('all').map((r) => r.field)).toEqual(['due_date', 'assignee', 'priority'])
  })

  it('values sent back unchanged write no row, even when another field really changes', () => {
    createKanbanCard({ id: 'echo', title: 'Whole-card PUT', assignee: 'a', priority: 'high', due_date: DUE })

    expect(updateKanbanCard('echo', { title: 'Edited', assignee: 'a', priority: 'high', due_date: DUE }, 'x')).toBe(true)

    expect(getKanbanCard('echo')!.title).toBe('Edited')
    expect(getKanbanCardFieldEvents('echo')).toHaveLength(0)
  })

  it('a due date sent in a shape the INTEGER column stores as the same value is not a change: the STORED row decides', () => {
    createKanbanCard({ id: 'str', title: 'Numeric string', due_date: DUE })

    // "1790000000.0" is stored as the integer 1790000000 (SQLite affinity), so the stored row is unchanged
    // although the request's text differs from it; compared with the request, this would be a false row.
    for (const sent of [String(DUE), `${DUE}.0`]) {
      updateKanbanCard('str', { due_date: sent as unknown as number }, 'x')
      expect(getKanbanCard('str')!.due_date).toBe(DUE)
    }
    expect(getKanbanCardFieldEvents('str')).toHaveLength(0)
  })

  it('clearing a field and setting an empty one: null on the empty side', () => {
    createKanbanCard({ id: 'nul', title: 'Emptied', assignee: 'a', due_date: DUE })

    updateKanbanCard('nul', { due_date: null as unknown as number, assignee: null as unknown as string }, 'x')
    updateKanbanCard('nul', { due_date: LATER }, 'x')

    expect(fieldRows('nul')).toEqual([
      { field: 'due_date', old_value: String(DUE), new_value: null, actor: 'x' },
      { field: 'assignee', old_value: 'a', new_value: null, actor: 'x' },
      { field: 'due_date', old_value: null, new_value: String(LATER), actor: 'x' },
    ])
  })

  it('a status change is a status event and no field row: the two tables stay apart', () => {
    createKanbanCard({ id: 'st', title: 'Moved' })

    updateKanbanCard('st', { status: 'in_progress' }, 'x')

    expect(getKanbanCardEvents('st')).toHaveLength(1)
    expect(getKanbanCardFieldEvents('st')).toHaveLength(0)
  })

  it('title or description only: no field row', () => {
    createKanbanCard({ id: 'txt', title: 'Text' })

    updateKanbanCard('txt', { title: 'New', description: 'body' }, 'x')

    expect(getKanbanCardFieldEvents('txt')).toHaveLength(0)
  })

  it('no actor: the row is still written, with a null actor', () => {
    createKanbanCard({ id: 'anon', title: 'Anonymous', priority: 'normal' })

    updateKanbanCard('anon', { priority: 'low' })

    expect(fieldRows('anon')).toEqual([{ field: 'priority', old_value: 'normal', new_value: 'low', actor: null }])
  })

  it('a card that does not exist: false, and no row anywhere', () => {
    expect(updateKanbanCard('nincs', { due_date: DUE }, 'x')).toBe(false)
    expect(getKanbanCardFieldEvents('nincs')).toHaveLength(0)
    expect(statusEventRows()).toBe(0)
  })

  it('ONE TRANSACTION: a field-row insert that fails rolls the card write back too (forced with a trigger)', () => {
    createKanbanCard({ id: 'tx', title: 'Rolled back', due_date: DUE })
    getDb().prepare('UPDATE kanban_cards SET updated_at = 1 WHERE id = ?').run('tx')
    getDb().exec(`CREATE TRIGGER fail_field BEFORE INSERT ON kanban_card_field_events BEGIN SELECT RAISE(ABORT, 'forced field-row failure'); END`)

    expect(() => updateKanbanCard('tx', { due_date: LATER }, 'x')).toThrow(/forced field-row failure/)

    expect(getKanbanCard('tx')!.due_date).toBe(DUE)
    expect(getKanbanCard('tx')!.updated_at).toBe(1)
    expect(getKanbanCardFieldEvents('tx')).toHaveLength(0)
  })

  it('ONE TRANSACTION: a status-event insert that fails rolls the status change and its field rows back', () => {
    createKanbanCard({ id: 'txs', title: 'Status rolled back', priority: 'normal' })
    getDb().exec(`CREATE TRIGGER fail_status BEFORE INSERT ON kanban_card_events BEGIN SELECT RAISE(ABORT, 'forced status-row failure'); END`)

    expect(() => updateKanbanCard('txs', { status: 'in_progress', priority: 'high' }, 'x')).toThrow(/forced status-row failure/)

    expect(getKanbanCard('txs')!.status).toBe('planned')
    expect(getKanbanCard('txs')!.priority).toBe('normal')
    expect(getKanbanCardEvents('txs')).toHaveLength(0)
    expect(getKanbanCardFieldEvents('txs')).toHaveLength(0)
  })

  it('ONE TRANSACTION: the ancestor stamp is rolled back with it', () => {
    createKanbanCard({ id: 'parent', title: 'Thread' })
    createKanbanCard({ id: 'child', title: 'Subcard', parent_id: 'parent', due_date: DUE })
    getDb().prepare('UPDATE kanban_cards SET updated_at = 1 WHERE id = ?').run('parent')
    getDb().exec(`CREATE TRIGGER fail_field2 BEFORE INSERT ON kanban_card_field_events BEGIN SELECT RAISE(ABORT, 'forced'); END`)

    expect(() => updateKanbanCard('child', { due_date: LATER }, 'x')).toThrow()

    expect(getKanbanCard('parent')!.updated_at).toBe(1)
  })

  it('kanban_card_events keeps its columns: the status table was not extended', () => {
    const cols = (getDb().prepare('PRAGMA table_info(kanban_card_events)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(['id', 'card_id', 'from_status', 'to_status', 'actor', 'created_at'])
  })
})

describe('the routes: PUT writes the row, GET /field-events reads it, GET /events keeps its shape', () => {
  function ctx(method: string, path: string, body?: unknown, auth?: RouteContext['auth']) {
    const out: { status: number; body: any } = { status: 200, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      setHeader() { return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    const url = new URL(`http://localhost:3420${path}`)
    return { c: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
  }
  async function call(method: string, path: string, body?: unknown, auth?: RouteContext['auth']) {
    const { c, out } = ctx(method, path, body, auth)
    expect(await tryHandleKanban(c)).toBe(true)
    return out
  }

  it('a due-only PUT with an actor: 200, one field row on /field-events, /events still an empty array', async () => {
    createKanbanCard({ id: 'rt', title: 'Through the route', due_date: DUE })

    expect((await call('PUT', '/api/kanban/rt', { due_date: LATER, actor: 'dev-a' })).status).toBe(200)

    const fields = await call('GET', '/api/kanban/rt/field-events')
    expect(fields.status).toBe(200)
    expect(fields.body).toHaveLength(1)
    expect(fields.body[0]).toMatchObject({ card_id: 'rt', field: 'due_date', old_value: String(DUE), new_value: String(LATER), actor: 'dev-a' })
    const events = await call('GET', '/api/kanban/rt/events')
    expect(events.body).toEqual([])
  })

  it('X7: an actor that is not a string or null is refused BEFORE the write -- 400, card unchanged, no rows', async () => {
    createKanbanCard({ id: 'x7', title: 'Bad actor', due_date: DUE })
    for (const bad of [true, { name: 'x' }, 42, ['a']]) {
      const out = await call('PUT', '/api/kanban/x7', { due_date: LATER, status: 'in_progress', actor: bad })
      expect(out.status, JSON.stringify(bad)).toBe(400)
      expect(out.body.error).toMatch(/actor must be a string or null/)
    }
    expect(getKanbanCard('x7')!.due_date).toBe(DUE)
    expect(getKanbanCard('x7')!.status).toBe('planned')
    expect(getKanbanCardFieldEvents('x7')).toHaveLength(0)
    expect(getKanbanCardEvents('x7')).toHaveLength(0)
  })

  it('X7 INVARIANT (taken over from the review): an unbindable actor never leaves an audited field changed without its row', async () => {
    // Mechanism-free on purpose: whether the route refuses (400) or the write rolls back (500), a changed field
    // without its row is the one outcome that must not happen.
    createKanbanCard({ id: 'x7i', title: 'x7', due_date: DUE })
    try { await call('PUT', '/api/kanban/x7i', { due_date: LATER, actor: true }) } catch { /* a throw is allowed, a half write is not */ }
    const changed = getKanbanCard('x7i')!.due_date !== DUE
    expect(changed ? getKanbanCardFieldEvents('x7i').length : 1).toBe(1)
  })

  it('no actor in the request: a browser session names its user, on the field row and the status event', async () => {
    createKanbanCard({ id: 'ses', title: 'Edited in the dashboard', due_date: DUE })

    expect((await call('PUT', '/api/kanban/ses', { due_date: LATER, status: 'in_progress' }, { kind: 'session', user: 'admin' })).status).toBe(200)

    expect(fieldRows('ses')).toEqual([{ field: 'due_date', old_value: String(DUE), new_value: String(LATER), actor: 'admin' }])
    expect(getKanbanCardEvents('ses')[0].actor).toBe('admin')
  })

  it('actor: null in a session is also "no actor"; an explicit actor string wins over the session', async () => {
    createKanbanCard({ id: 'nul2', title: 'Null actor', priority: 'normal' })
    await call('PUT', '/api/kanban/nul2', { priority: 'high', actor: null }, { kind: 'session', user: 'admin' })
    await call('PUT', '/api/kanban/nul2', { priority: 'low', actor: 'dev-a' }, { kind: 'session', user: 'admin' })
    expect(fieldRows('nul2').map((r) => r.actor)).toEqual(['admin', 'dev-a'])
  })

  it('no actor and no session (a token caller, or no principal): the row stays anonymous, as before', async () => {
    createKanbanCard({ id: 'tok', title: 'Token caller', priority: 'normal' })
    await call('PUT', '/api/kanban/tok', { priority: 'high' }, { kind: 'token' })
    await call('PUT', '/api/kanban/tok', { priority: 'low' })
    expect(fieldRows('tok').map((r) => r.actor)).toEqual([null, null])
  })

  it('a card without changes: /field-events is an empty array', async () => {
    createKanbanCard({ id: 'quiet', title: 'Untouched' })
    expect((await call('GET', '/api/kanban/quiet/field-events')).body).toEqual([])
  })
})
