// Contract tests: a card activated for an agent whose session is DOWN must not
// go quiet.
//
// Root cause: the card flips to in_progress first and the wake-up message is
// attempted after -- and when resolveKanbanDispatchTarget finds the assignee's
// session not running it returns null, which fireKanbanDispatch treats as
// "nothing to do" and returns silently. The board then shows a card that is
// in_progress with nobody working it, and status-driven monitoring skips on
// exactly that status, so the false in_progress SUSTAINS ITSELF: a single
// missed message can hold a card open for hours with a green log and no signal
// anywhere.
//
// The stricter contract -- message first, in_progress only after successful
// delivery -- is not available here. createAgentMessage only ENQUEUES -- the
// router delivers later, asynchronously -- so "after successful delivery" is
// not knowable at move time. What is enforceable, and what these tests pin, is
// that the failure is never SILENT: it lands on the card and in the main
// agent's inbox.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const mockCreateAgentMessage = vi.fn()
const runningAgents = new Set<string>()

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
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: (n: string) => runningAgents.has(n),
}))

import { initDatabase, createKanbanCard, getKanbanComments } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

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
  runningAgents.clear()
  initDatabase(':memory:')
})

describe('silent dispatch no-op on a down agent', () => {
  it('tells the main agent when an activated card could not wake its assignee', async () => {
    createKanbanCard({ id: 'card-1', title: 'Night round', assignee: 'dex' }) // dex is NOT running

    await move('card-1', 'in_progress', 'orin')

    // The incident: zero messages, zero logs, zero board signal.
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, content] = mockCreateAgentMessage.mock.calls[0] as string[]
    expect(from).toBe('system')
    expect(to).toBe('orin') // MAIN_AGENT_ID -- the delegator triages
    expect(content).toContain('card-1')
    expect(content).toContain('dex')
  })

  it('leaves the evidence on the card itself, where the board shows it', async () => {
    createKanbanCard({ id: 'card-2', title: 'Night round', assignee: 'dex' })

    await move('card-2', 'in_progress', 'orin')

    const comments = getKanbanComments('card-2')
    expect(comments).toHaveLength(1)
    expect(comments[0].content).toContain('dex')
  })

  it('stays silent when the no-op is CORRECT: self-move, owner, no assignee', async () => {
    // The control. These three are deliberate no-dispatch cases -- turning them
    // into alerts would bury the real one.
    runningAgents.add('dex')
    createKanbanCard({ id: 'card-3', title: 'Self pickup', assignee: 'dex' })
    createKanbanCard({ id: 'card-4', title: 'Human card', assignee: 'Owner' })
    createKanbanCard({ id: 'card-5', title: 'Unassigned' }) // no assignee at all

    await move('card-3', 'in_progress', 'dex') // agent picks up its own card
    await move('card-4', 'in_progress', 'orin')
    await move('card-5', 'in_progress', 'orin')

    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(getKanbanComments('card-3')).toHaveLength(0)
    expect(getKanbanComments('card-4')).toHaveLength(0)
    expect(getKanbanComments('card-5')).toHaveLength(0)
  })

  it('dispatches normally (and adds no noise) when the agent is up', async () => {
    runningAgents.add('dex')
    createKanbanCard({ id: 'card-6', title: 'Normal round', assignee: 'dex' })

    await move('card-6', 'in_progress', 'orin')

    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    expect((mockCreateAgentMessage.mock.calls[0] as string[])[1]).toBe('dex')
    expect(getKanbanComments('card-6')).toHaveLength(0)
  })
})
