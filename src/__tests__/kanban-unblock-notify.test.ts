// Card 08bf8326 (#567): when a blocker card reaches done and the card waiting on
// it has nothing else open, the waiting card's assignee is told once, and the
// card gets a system comment. Real in-memory DB; only the outbound inter-agent
// message is spied on.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const mockCreateAgentMessage = vi.fn()
let running = new Set<string>(['dex', 'zara'])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a) }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex', 'zara'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: (n: string) => running.has(n),
}))

import {
  initDatabase, createKanbanCard, addCardBlocker, getKanbanComments, getCardsUnblockedBy, archiveKanbanCard,
} from '../db.js'
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

const move = (id: string, status: string, actor = 'zara') =>
  call('POST', `/api/kanban/${id}/move`, { status, sort_order: 0, actor })
const put = (id: string, fields: Record<string, unknown>) => call('PUT', `/api/kanban/${id}`, fields)

const unblockMessages = () =>
  mockCreateAgentMessage.mock.calls.filter((c) => String(c[2]).includes('feloldva'))
const systemComments = (id: string) =>
  getKanbanComments(id).filter((c) => c.author === 'system' && c.content.includes('Folytatható'))

beforeEach(() => {
  vi.clearAllMocks()
  running = new Set(['dex', 'zara'])
  initDatabase(':memory:')
  createKanbanCard({ id: 'blk-a', title: 'First step', assignee: 'zara', status: 'in_progress' })
  createKanbanCard({ id: 'wait-b', title: 'Second step', assignee: 'dex', status: 'planned' })
  addCardBlocker('wait-b', 'blk-a')
})

describe('kanban unblock notification', () => {
  it('moving the only blocker to done tells the waiting assignee once and comments the card', async () => {
    expect(await move('blk-a', 'done')).toBe(200)
    const msgs = unblockMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0][0]).toBe('orin')
    expect(msgs[0][1]).toBe('dex')
    expect(String(msgs[0][2])).toContain('#wait-b')
    expect(String(msgs[0][2])).toContain('#blk-a')
    // Titles are free text and stay out of the message.
    expect(String(msgs[0][2])).not.toContain('Second step')
    expect(systemComments('wait-b')).toHaveLength(1)
  })

  it('a reorder inside done does not notify again', async () => {
    await move('blk-a', 'done')
    mockCreateAgentMessage.mockClear()
    expect(await move('blk-a', 'done')).toBe(200)
    expect(unblockMessages()).toHaveLength(0)
    expect(systemComments('wait-b')).toHaveLength(1)
  })

  it('a second open blocker keeps the card blocked: no notice until the last one closes', async () => {
    createKanbanCard({ id: 'blk-c', title: 'Other step', assignee: 'zara', status: 'in_progress' })
    addCardBlocker('wait-b', 'blk-c')
    await move('blk-a', 'done')
    expect(unblockMessages()).toHaveLength(0)
    await move('blk-c', 'done')
    expect(unblockMessages()).toHaveLength(1)
  })

  it('an archived blocker that never reached done still blocks', async () => {
    createKanbanCard({ id: 'blk-c', title: 'Dropped step', assignee: 'zara', status: 'planned' })
    addCardBlocker('wait-b', 'blk-c')
    archiveKanbanCard('blk-c')
    await move('blk-a', 'done')
    expect(unblockMessages()).toHaveLength(0)
  })

  it('the whole-card PUT to done notifies the same way', async () => {
    expect(await put('blk-a', { status: 'done' })).toBe(200)
    expect(unblockMessages()).toHaveLength(1)
  })

  it('a done or archived waiting card is not notified', async () => {
    await put('wait-b', { status: 'done' })
    mockCreateAgentMessage.mockClear()
    await move('blk-a', 'done')
    expect(unblockMessages()).toHaveLength(0)
    expect(getCardsUnblockedBy('blk-a')).toHaveLength(0)
  })

  it('the agent that closed the blocker is not told about its own waiting card', async () => {
    await move('blk-a', 'done', 'dex')
    expect(unblockMessages()).toHaveLength(0)
    expect(systemComments('wait-b')).toHaveLength(1)
  })

  it('a human owner gets no prompt, only the card comment', async () => {
    createKanbanCard({ id: 'wait-h', title: 'Owner step', assignee: 'Owner', status: 'planned' })
    addCardBlocker('wait-h', 'blk-a')
    await move('blk-a', 'done')
    const targets = unblockMessages().map((c) => c[1])
    expect(targets).toEqual(['dex'])
    expect(systemComments('wait-h')).toHaveLength(1)
  })

  it('a stopped sub-agent is reported to the main agent instead', async () => {
    running = new Set(['zara'])
    await move('blk-a', 'done')
    const msgs = unblockMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0][0]).toBe('system')
    expect(msgs[0][1]).toBe('orin')
    expect(String(msgs[0][2])).toContain('dex')
  })

  it('moving the blocker anywhere but done does nothing', async () => {
    await move('blk-a', 'waiting')
    expect(unblockMessages()).toHaveLength(0)
    expect(systemComments('wait-b')).toHaveLength(0)
  })
})
