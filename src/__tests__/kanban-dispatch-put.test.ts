// Contract tests: the whole-card PUT follows the same dispatched_at rule as
// /move (kanbanWriteClearsDispatch), and it only CLEARS -- it never wakes the
// assignee. PUT to in_progress clears but does not dispatch; /move remains the
// only dispatch path.
//
// Before: updateKanbanCard wrote status without touching dispatched_at, so a
// card the PUT took out of in_progress kept its stamp, and the next /move to
// in_progress hit the once-only guard and woke nobody.

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

// Real database (in-memory), real move/update/dispatch bookkeeping -- only the
// outbound inter-agent message is spied on: it is the one observable effect of
// fireKanbanDispatch ("was the assignee woken").
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

import { initDatabase, getDb, createKanbanCard, getKanbanCard, kanbanWriteClearsDispatch } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function call(method: string, path: string, body: unknown): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 200
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path, method, url: new URL(`http://localhost${path}`),
  } as never)
  expect(handled).toBe(true)
  return status
}

const move = (id: string, status: string) => call('POST', `/api/kanban/${id}/move`, { status, sort_order: 0, actor: 'orin' })
const put = (id: string, fields: Record<string, unknown>) => call('PUT', `/api/kanban/${id}`, fields)

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
})

describe('kanban dispatch on the whole-card PUT', () => {
  it('PUT to in_progress clears but does not dispatch; /move remains the only dispatch path', async () => {
    createKanbanCard({ id: 'card-1', title: 'Pulled by PUT', assignee: 'dex' })

    expect(await put('card-1', { status: 'in_progress' })).toBe(200)
    expect(getKanbanCard('card-1')?.status).toBe('in_progress')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(getKanbanCard('card-1')?.dispatched_at).toBeNull()

    // Control: the same card, the same harness, through /move -- this one wakes
    // dex, so the silence above is the PUT's, not the harness's.
    await move('card-1', 'in_progress')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls[0][1]).toBe('dex')
  })

  it('PUT out of in_progress clears dispatched_at, so the next /move wakes the assignee again', async () => {
    createKanbanCard({ id: 'card-2', title: 'Bounced by PUT', assignee: 'dex' })

    await move('card-2', 'in_progress')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    expect(getKanbanCard('card-2')?.dispatched_at).toBeTypeOf('number')

    expect(await put('card-2', { status: 'waiting' })).toBe(200)
    expect(getKanbanCard('card-2')?.dispatched_at).toBeNull()

    // The bug: this stayed at 1 -- the PUT left the stamp, the guard held.
    await move('card-2', 'in_progress')
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(2)
  })

  it('a PUT that keeps the card in in_progress keeps the stamp (same spell, no second wake-up)', async () => {
    createKanbanCard({ id: 'card-3', title: 'Edited while in progress', assignee: 'dex' })

    await move('card-3', 'in_progress')
    const stamp = getKanbanCard('card-3')?.dispatched_at
    expect(stamp).toBeTypeOf('number')

    expect(await put('card-3', { title: 'Edited while in progress, renamed' })).toBe(200)
    expect(getKanbanCard('card-3')?.dispatched_at).toBe(stamp)

    await move('card-3', 'in_progress') // a reorder inside the column
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
  })

  it('a PUT on a card outside in_progress heals a stale stamp, like /move', async () => {
    createKanbanCard({ id: 'card-4', title: 'Stuck row', assignee: 'dex' })
    getDb().prepare('UPDATE kanban_cards SET dispatched_at = 1790000000 WHERE id = ?').run('card-4')

    expect(await put('card-4', { title: 'Stuck row, renamed' })).toBe(200)
    expect(getKanbanCard('card-4')?.dispatched_at).toBeNull()
  })
})

describe('kanbanWriteClearsDispatch (the rule /move, PUT and the card script share)', () => {
  it('keeps the stamp only for in_progress', () => {
    for (const s of ['planned', 'testing', 'waiting', 'done']) expect(kanbanWriteClearsDispatch(s), s).toBe(true)
    expect(kanbanWriteClearsDispatch('in_progress')).toBe(false)
  })
})
