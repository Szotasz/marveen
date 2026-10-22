// DISPATCHSKIP1022: KANBAN_DISPATCH_SKIP_AGENTS, a list of agents the in_progress
// dispatch never wakes. Measured on a live install (2026-10-14 and again
// 2026-10-22): a coordinating agent that hands cards on (a PM) got the
// "[Kanban feladat]" builder recipe whenever a card stood in its name for a
// moment, and builders whose work is delivered by an outside deliverer (fresh
// context first, then the task) were woken twice. The setting is opt-in and
// empty by default: empty = every dispatchable agent is woken, as before.
//
// Same harness as kanban-dispatch-no-card-text.test.ts: real in-memory database,
// the real POST /api/kanban/<id>/move and PUT /api/kanban/<id> routes; only the
// outbound message is spied on, and the one setting is controlled.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'

const mockCreateAgentMessage = vi.fn()
let skipValue = ''
let running = true

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Botond',
  OWNER_NAME: 'Owner',
}))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex', 'pm'],
  readAgentDisplayName: (n: string) => n,
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => running,
}))
vi.mock('../settings-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      (key === 'KANBAN_DISPATCH_SKIP_AGENTS' ? skipValue : actual.getEffectiveSettingValue(key)),
  }
})

import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, addCardBlocker } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { getSettingDefinition, validateSettingValue } from '../config-registry.js'
import { resolveKanbanDispatch } from '../kanban-dispatch.js'

async function route(method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<void> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({ req, res, path, method, url: new URL(`http://localhost${path}`) } as never)
  expect(handled).toBe(true)
}

const move = (id: string, status: string, actor?: string) =>
  route('POST', `/api/kanban/${encodeURIComponent(id)}/move`, { status, sort_order: 0, actor })
const put = (id: string, body: Record<string, unknown>) => route('PUT', `/api/kanban/${encodeURIComponent(id)}`, body)

const sentTo = (who: string) => mockCreateAgentMessage.mock.calls.filter((c) => c[1] === who)

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
  skipValue = ''
  running = true
})

describe('KANBAN_DISPATCH_SKIP_AGENTS: the setting (DISPATCHSKIP1022)', () => {
  it('is registered as a hot-reloaded, non-secret kanban string, empty by default', () => {
    const def = getSettingDefinition('KANBAN_DISPATCH_SKIP_AGENTS')
    expect(def).toBeDefined()
    expect(def?.type).toBe('string')
    expect(def?.default).toBe('')
    expect(def?.module).toBe('kanban')
    expect(def?.secret).toBe(false)
    expect(def?.requiresRestart).toBe(false)
    expect(String(def?.description ?? '').length).toBeGreaterThan(0)
  })

  it('accepts empty, one name, and a comma list (spaces around the commas allowed)', () => {
    const def = getSettingDefinition('KANBAN_DISPATCH_SKIP_AGENTS')
    expect(def).toBeDefined()
    for (const v of ['', 'pm', 'pm,dex', 'pm, dex', 'Botond', '7en', 'agent_2.b-x']) {
      expect(validateSettingValue(def!, v), v).toMatchObject({ ok: true })
    }
  })

  it('refuses anything that is not a list of agent names', () => {
    const def = getSettingDefinition('KANBAN_DISPATCH_SKIP_AGENTS')
    expect(def).toBeDefined()
    for (const v of ['pm;dex', 'pm dex', '$(id)', 'pm,,dex', 'pm,', ',pm', '-pm', 'a'.repeat(51)]) {
      const r = validateSettingValue(def!, v)
      expect(r.ok, v).toBe(false)
      expect(String((r as { error?: string }).error ?? '').length, v).toBeGreaterThan(0)
    }
  })
})

describe('KANBAN_DISPATCH_SKIP_AGENTS: the dispatch (DISPATCHSKIP1022)', () => {
  it('empty (the default): a running agent is woken exactly as before', async () => {
    createKanbanCard({ id: 'c-0', title: 't', assignee: 'pm' })
    await move('c-0', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
  })

  it('listed: no message at all, the move still succeeds, and dispatched_at stays unset', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'c-1', title: 't', assignee: 'pm' })
    await move('c-1', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(getKanbanCard('c-1')?.status).toBe('in_progress')
    expect(getKanbanCard('c-1')?.dispatched_at ?? null).toBeNull()
  })

  it('only the listed agent is skipped: another agent is still woken', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'c-pm', title: 't', assignee: 'pm' })
    createKanbanCard({ id: 'c-dex', title: 't', assignee: 'dex' })
    await move('c-pm', 'in_progress', 'orin')
    await move('c-dex', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(0)
    expect(sentTo('dex')).toHaveLength(1)
  })

  // The bot display name (Botond) differs from the main agent id (orin) on purpose: a plain lower-casing would not
  // match it, only the same resolution the assignee goes through.
  it('matches names the way the assignee is matched: any casing, and the bot display name for the main agent', async () => {
    skipValue = 'PM, Botond'
    createKanbanCard({ id: 'c-case', title: 't', assignee: 'pm' })
    createKanbanCard({ id: 'c-main', title: 't', assignee: 'orin' })
    await move('c-case', 'in_progress', 'dex')
    await move('c-main', 'in_progress', 'dex')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  it('a listed agent whose session is down raises no "not delivered" notice: the skip is deliberate', async () => {
    skipValue = 'pm'
    running = false
    createKanbanCard({ id: 'c-down', title: 't', assignee: 'pm' })
    await move('c-down', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(getKanbanComments('c-down').filter((c) => c.author === 'system')).toHaveLength(0)
  })

  it('the skip does not burn the once-only wake-up: handed on by PUT, the next /move wakes the new assignee once', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'c-h', title: 't', assignee: 'pm' })
    await move('c-h', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    await put('c-h', { assignee: 'dex', actor: 'pm' })
    await move('c-h', 'in_progress', 'pm')
    expect(sentTo('dex')).toHaveLength(1)
    await move('c-h', 'in_progress', 'pm')
    expect(sentTo('dex')).toHaveLength(1)
  })

  it('the same card, skipped while listed, is woken exactly once by the next /move after the list is emptied', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'c-r', title: 't', assignee: 'pm' })
    await move('c-r', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    skipValue = ''
    await move('c-r', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
    await move('c-r', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
  })

  it('skip -> planned -> list emptied -> back to in_progress: woken exactly once, and the card ends stamped', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'c-p', title: 't', assignee: 'pm' })
    await move('c-p', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    await move('c-p', 'planned', 'orin')
    expect(getKanbanCard('c-p')?.dispatched_at ?? null).toBeNull()
    skipValue = ''
    await move('c-p', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
    expect(getKanbanCard('c-p')?.dispatched_at).toBeTruthy()
    await move('c-p', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
  })

  it('INVARIANT: listing an agent is not retroactive: an already woken card keeps its dispatched_at and wakes nobody again', async () => {
    createKanbanCard({ id: 'c-old', title: 't', assignee: 'dex' })
    await move('c-old', 'in_progress', 'orin')
    expect(sentTo('dex')).toHaveLength(1)
    const stamp = getKanbanCard('c-old')?.dispatched_at
    expect(stamp).toBeTruthy()
    skipValue = 'dex'
    await move('c-old', 'in_progress', 'orin')
    expect(sentTo('dex')).toHaveLength(1)
    expect(getKanbanCard('c-old')?.dispatched_at).toBe(stamp)
  })

  it('is read at dispatch time: a changed value applies to the next move without a restart', async () => {
    createKanbanCard({ id: 'c-a', title: 't', assignee: 'dex' })
    createKanbanCard({ id: 'c-b', title: 't', assignee: 'dex' })
    await move('c-a', 'in_progress', 'orin')
    expect(sentTo('dex')).toHaveLength(1)
    skipValue = 'dex'
    await move('c-b', 'in_progress', 'orin')
    expect(sentTo('dex')).toHaveLength(1)
  })

  it('INVARIANT: the unblock notice ("[Kanban feloldva]") is not a dispatch and still reaches a listed agent', async () => {
    skipValue = 'pm'
    createKanbanCard({ id: 'w', title: 'Waiting', assignee: 'pm', status: 'waiting' })
    createKanbanCard({ id: 'b', title: 'Blocker', assignee: 'dex', status: 'in_progress' })
    addCardBlocker('w', 'b')
    await move('b', 'done', 'dex')
    const toPm = sentTo('pm').map((c) => String(c[2]))
    expect(toPm.some((m) => m.includes('[Kanban feloldva #w]'))).toBe(true)
  })
})

describe('resolveKanbanDispatch skipAgents (DISPATCHSKIP1022)', () => {
  const base = {
    ownerName: 'Owner', botName: 'Botond', mainAgentId: 'orin', agentNames: ['dex', 'pm'],
    isRunning: () => true,
  }

  it('a listed target is a deliberate no-dispatch with its own reason', () => {
    expect(resolveKanbanDispatch('pm', { ...base, skipAgents: ['pm'] })).toEqual({ target: null, reason: 'skip-listed' })
  })

  it('INVARIANT: without skipAgents (or with an empty list) the decision is unchanged', () => {
    expect(resolveKanbanDispatch('pm', base)).toEqual({ target: 'pm' })
    expect(resolveKanbanDispatch('pm', { ...base, skipAgents: [] })).toEqual({ target: 'pm' })
    expect(resolveKanbanDispatch('pm', { ...base, actor: 'pm', skipAgents: ['pm'] })).toEqual({ target: null, reason: 'self-move' })
  })
})
