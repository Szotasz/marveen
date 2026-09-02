// Contract tests: `dispatched_at` is the once-only guard for ONE in_progress
// spell, not a permanent tombstone.
//
// Root cause: fireKanbanDispatch bails on `card.dispatched_at` and
// markKanbanCardDispatched only ever SETS the column -- nothing in the codebase
// clears it. So a card pulled to in_progress and then put BACK
// (planned/waiting) burned its dispatch forever: the board showed it alive, the
// next in_progress pull woke nobody. Observed live: a card bounced back to
// planned a couple of minutes after activation stayed silent from then on.
//
// The two re-arm assertions, plus the control that the original purpose (one
// activation -> one message, not two) survives.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const mockCreateAgentMessage = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

// Real database (in-memory), real move/dispatch bookkeeping -- only the
// outbound inter-agent message is spied on, since "did the assignee get woken"
// is exactly the question these tests ask.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a) }
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

import { initDatabase, createKanbanCard, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

/** Drive the real POST /api/kanban/<id>/move route. */
async function move(id: string, status: string, actor?: string): Promise<void> {
  const req = Readable.from([Buffer.from(JSON.stringify({ status, sort_order: 0, actor }))]) as unknown as http.IncomingMessage
  const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req,
    res,
    path: `/api/kanban/${id}/move`,
    method: 'POST',
    url: new URL(`http://localhost/api/kanban/${id}/move`),
  } as never)
  expect(handled).toBe(true)
}

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
})

describe('kanban dispatch re-arm', () => {
  it('clears dispatched_at when the card leaves in_progress', async () => {
    createKanbanCard({ id: 'card-1', title: 'Bounced card', assignee: 'dex' })

    await move('card-1', 'in_progress', 'orin')
    expect(getKanbanCard('card-1')?.dispatched_at).toBeTypeOf('number') // dispatched once

    await move('card-1', 'planned', 'orin') // put back -- the bounce that burned the dispatch
    expect(getKanbanCard('card-1')?.dispatched_at).toBeNull()
  })

  it('dispatches AGAIN when a put-back card is pulled to in_progress once more', async () => {
    createKanbanCard({ id: 'card-2', title: 'Bounced card', assignee: 'dex' })

    await move('card-2', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)

    await move('card-2', 'planned', 'orin')
    await move('card-2', 'in_progress', 'orin')

    // The bug: this stayed at 1 -- the card looked alive, nobody was told.
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(2)
    expect(mockCreateAgentMessage.mock.calls[1][1]).toBe('dex')
  })

  it('still sends only ONE message per activation (the guard is not weakened)', async () => {
    createKanbanCard({ id: 'card-3', title: 'Reordered in place', assignee: 'dex' })

    await move('card-3', 'in_progress', 'orin')
    // A pure sort_order reorder inside the in_progress column re-enters the
    // dispatch path; the guard must still hold.
    await move('card-3', 'in_progress', 'orin')

    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
  })

  it('re-arms from waiting too (an escalated card that gets picked up again)', async () => {
    createKanbanCard({ id: 'card-4', title: 'Escalated card', assignee: 'dex' })

    await move('card-4', 'in_progress', 'orin')
    await move('card-4', 'waiting', 'dex')
    expect(getKanbanCard('card-4')?.dispatched_at).toBeNull()

    await move('card-4', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(2)
  })
})
