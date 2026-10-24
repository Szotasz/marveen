// Contract tests: POST /api/kanban/<id>/move accepts an optional
// `expected_status` (compare-and-set).
//
// Root cause: the move UPDATE filtered on id only, so it was an unconditional
// "last writer wins". Two agents moving the same card (e.g. a late-delivered
// dispatch that still believes the card is `planned`, arriving after another
// agent already closed it) both got 200, and neither learned about the other.
//
// With `expected_status` the check and the write are ONE statement
// (UPDATE ... WHERE id=? AND status=?): a mismatch changes nothing and answers
// 409 with the card's actual status. Without `expected_status` the route
// behaves exactly as before.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

// Real in-memory database; only the outbound inter-agent message (the
// in_progress dispatch side effect) is stubbed out.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: vi.fn() }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import {
  initDatabase, createKanbanCard, getKanbanCard, getKanbanCardEvents, moveKanbanCard,
} from '../db.js'
import { tryHandleKanban, kanbanMoveInstructions } from '../web/routes/kanban.js'

interface MoveResult { status: number; body: Record<string, unknown> }

/** Drive the real POST /api/kanban/<id>/move route and capture the response. */
async function move(id: string, payload: Record<string, unknown>): Promise<MoveResult> {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as http.IncomingMessage
  let status = 0
  let raw = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((b?: string) => { raw = b ?? '' }),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req,
    res,
    path: `/api/kanban/${id}/move`,
    method: 'POST',
    url: new URL(`http://localhost/api/kanban/${id}/move`),
  } as never)
  expect(handled).toBe(true)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
})

describe('POST /api/kanban/<id>/move with expected_status', () => {
  it('(a) moves the card when expected_status matches the current status', async () => {
    createKanbanCard({ id: 'c-a', title: 'Matching', assignee: 'dex' })

    const r = await move('c-a', { status: 'in_progress', expected_status: 'planned', actor: 'dex' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(getKanbanCard('c-a')?.status).toBe('in_progress')
    // actor lands in the existing audit trail (kanban_card_events), same as before.
    const events = getKanbanCardEvents('c-a')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from_status: 'planned', to_status: 'in_progress', actor: 'dex' })
  })

  it('(b) refuses with 409 and leaves a done card done when expected_status is stale', async () => {
    createKanbanCard({ id: 'c-b', title: 'Already closed', assignee: 'dex' })
    // An agent closes with evidence (kanban-done-evidence); without it the card would land in testing.
    await move('c-b', { status: 'done', actor: 'dex', evidence: 'checked' })
    expect(getKanbanCard('c-b')?.status).toBe('done')
    const updatedBefore = getKanbanCard('c-b')?.updated_at

    // A late-delivered dispatch: the caller believes the card is still planned.
    const r = await move('c-b', { status: 'in_progress', expected_status: 'planned', actor: 'orin' })

    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'status_conflict', current_status: 'done', expected_status: 'planned' })
    expect(getKanbanCard('c-b')?.status).toBe('done')
    expect(getKanbanCard('c-b')?.updated_at).toBe(updatedBefore)
    // No audit event for a move that did not happen.
    expect(getKanbanCardEvents('c-b').map((e) => e.to_status)).toEqual(['done'])
  })

  it('(c) without expected_status the move is unconditional, exactly as before', async () => {
    createKanbanCard({ id: 'c-c', title: 'Legacy caller', assignee: 'dex' })
    await move('c-c', { status: 'done', actor: 'dex' })

    const r = await move('c-c', { status: 'in_progress', sort_order: 0, actor: 'orin' })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(getKanbanCard('c-c')?.status).toBe('in_progress')
  })

  it('(d) an unknown id still answers the previous 404', async () => {
    const plain = await move('no-such-card', { status: 'done' })
    expect(plain.status).toBe(404)
    expect(plain.body).toEqual({ error: 'Kártya nem található' })

    // Also with expected_status: a missing card is 404, not a 409 conflict.
    const guarded = await move('no-such-card', { status: 'done', expected_status: 'planned' })
    expect(guarded.status).toBe(404)
    expect(guarded.body).toEqual({ error: 'Kártya nem található' })
  })

  it('rejects an expected_status that is not a known status with 400 and changes nothing', async () => {
    createKanbanCard({ id: 'c-e', title: 'Bad guard' })

    const r = await move('c-e', { status: 'done', expected_status: 'finished' })

    expect(r.status).toBe(400)
    expect(getKanbanCard('c-e')?.status).toBe('planned')
  })
})

describe('moveKanbanCard expectedStatus (db layer)', () => {
  it('is a no-op returning false when the current status differs', () => {
    createKanbanCard({ id: 'd-1', title: 't' })
    moveKanbanCard('d-1', 'done', 0, 'dex')

    expect(moveKanbanCard('d-1', 'in_progress', 0, 'orin', { expectedStatus: 'planned' })).toBe(false)
    expect(getKanbanCard('d-1')?.status).toBe('done')
  })

  it('moves and returns true when the current status matches', () => {
    createKanbanCard({ id: 'd-2', title: 't' })

    expect(moveKanbanCard('d-2', 'waiting', 3, 'orin', { expectedStatus: 'planned' })).toBe(true)
    expect(getKanbanCard('d-2')).toMatchObject({ status: 'waiting', sort_order: 3 })
  })
})

// The dispatch message is what an assigned agent actually runs to close its
// card, so the guard only helps if the recipe sends it. These tests take the
// done payload exactly as the dispatch hands it over and send it to the real
// route.
describe('dispatch recipe sends expected_status on the close', () => {
  const donePayload = (): Record<string, unknown> => {
    const out = kanbanMoveInstructions('t-1', 'dex')
    const line = out.split('\n').find((l) => l.includes(`-d '{"status":"done"`))
    expect(line).toBeDefined()
    return JSON.parse(line!.slice(line!.indexOf("'") + 1, line!.lastIndexOf("'"))) as Record<string, unknown>
  }

  it('a late close does not move a card that has moved on (409, unchanged)', async () => {
    createKanbanCard({ id: 't-1', title: 'Moved on', assignee: 'dex' })
    moveKanbanCard('t-1', 'testing', 0, 'orin')

    const r = await move('t-1', donePayload())

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'status_conflict', current_status: 'testing' })
    expect(getKanbanCard('t-1')?.status).toBe('testing')
  })

  it('the same payload closes a card that is still in_progress', async () => {
    createKanbanCard({ id: 't-1', title: 'Still mine', assignee: 'dex' })
    moveKanbanCard('t-1', 'in_progress', 0, 'dex')

    const r = await move('t-1', donePayload())

    expect(r.status).toBe(200)
    expect(getKanbanCard('t-1')?.status).toBe('done')
  })

  it('tells the reader what a 409 means and to guard the waiting move too', () => {
    const out = kanbanMoveInstructions('t-1', 'dex')
    expect(out).toContain('HTTP 409')
    expect(out).toContain('status_conflict')
    expect(out).toMatch(/waiting.*"expected_status":"in_progress"/)
  })
})
