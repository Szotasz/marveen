// Card 0f21864e (#568): tokens per card. The assignee's token rows inside the
// card's in_progress windows (from kanban_card_events), per model, with the
// overlap with the agent's other in_progress cards stated, never split.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, createKanbanCard } from '../db.js'
import { inProgressWindows, getCardTokenUsage, tokenAgentForAssignee } from '../web/token-usage.js'

const OPTS = { botName: 'Orin', mainAgentId: 'orin', now: 10_000 }

function event(cardId: string, from: string | null, to: string, at: number): void {
  getDb().prepare(
    'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(cardId, from, to, 'test', at)
}

let seq = 0
function tokens(agent: string, at: number, input: number, output: number, model = 'claude-opus'): void {
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(agent, `s${seq++}`, at, input, output, model)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('inProgressWindows', () => {
  it('opens on in_progress, closes on the next move out, an open window runs to now', () => {
    expect(inProgressWindows([
      { from_status: 'planned', to_status: 'in_progress', created_at: 100 },
      { from_status: 'in_progress', to_status: 'waiting', created_at: 200 },
      { from_status: 'waiting', to_status: 'in_progress', created_at: 300 },
    ], 1000)).toEqual([{ from: 100, to: 200 }, { from: 300, to: 1000 }])
  })

  it('a card never in_progress has no window', () => {
    expect(inProgressWindows([{ from_status: 'planned', to_status: 'done', created_at: 100 }], 1000)).toEqual([])
  })
})

describe('tokenAgentForAssignee', () => {
  it('lowercases, maps the bot name to the main agent id, empty is null', () => {
    expect(tokenAgentForAssignee('Dex', OPTS)).toBe('dex')
    expect(tokenAgentForAssignee('Orin', OPTS)).toBe('orin')
    expect(tokenAgentForAssignee('', OPTS)).toBeNull()
    expect(tokenAgentForAssignee(null, OPTS)).toBeNull()
  })
})

describe('getCardTokenUsage', () => {
  it('sums only the rows inside the windows, per model', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'Dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    tokens('dex', 50, 1000, 10) // before
    tokens('dex', 120, 300, 30)
    tokens('dex', 150, 200, 20, 'claude-sonnet')
    tokens('dex', 250, 1000, 10) // after
    tokens('zara', 150, 999, 99) // another agent
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.agent).toBe('dex')
    expect(u.totalCalls).toBe(2)
    expect(u.outputTokens).toBe(50)
    expect(u.totalTokens).toBe(550)
    expect(u.perModel.map((m) => m.model)).toEqual(['claude-opus', 'claude-sonnet'])
    expect(u.overlappingCards).toBe(0)
    expect(u.dataUntil).toBe(250)
  })

  it('counts the other in_progress cards of the same agent, without splitting', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    createKanbanCard({ id: 'c2', title: 'Other', assignee: 'Dex' })
    createKanbanCard({ id: 'c3', title: 'Later', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    event('c1', 'in_progress', 'done', 200)
    event('c2', 'planned', 'in_progress', 150)
    event('c3', 'planned', 'in_progress', 300)
    tokens('dex', 160, 100, 10)
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.overlappingCards).toBe(1)
    expect(u.totalTokens).toBe(110)
  })

  it('the bot-named main agent card reads the main agent rows', () => {
    createKanbanCard({ id: 'c1', title: 'Main', assignee: 'Orin' })
    event('c1', 'planned', 'in_progress', 100)
    tokens('orin', 150, 10, 5)
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.agent).toBe('orin')
    expect(u.windows).toEqual([{ from: 100, to: 10_000 }])
    expect(u.totalCalls).toBe(1)
  })

  it('no assignee or never in_progress: empty, no crash; missing card is null', () => {
    createKanbanCard({ id: 'c1', title: 'Nobody' })
    expect(getCardTokenUsage('c1', OPTS)!.agent).toBeNull()
    createKanbanCard({ id: 'c2', title: 'Idle', assignee: 'dex' })
    const u = getCardTokenUsage('c2', OPTS)!
    expect(u.windows).toEqual([])
    expect(u.totalCalls).toBe(0)
    expect(getCardTokenUsage('nope', OPTS)).toBeNull()
  })
})

describe('getCardTokenUsage breakdown', () => {
  it('splits fresh input from cache reads and drops zero-token model rows', () => {
    createKanbanCard({ id: 'c1', title: 'Work', assignee: 'dex' })
    event('c1', 'planned', 'in_progress', 100)
    getDb().prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
      VALUES ('dex', 'x1', 120, 10, 5, 900, 40, 'claude-opus'), ('dex', 'x2', 130, 0, 0, 0, 0, '<synthetic>')
    `).run()
    const u = getCardTokenUsage('c1', OPTS)!
    expect(u.freshInputTokens).toBe(50)
    expect(u.cacheReadTokens).toBe(900)
    expect(u.totalTokens).toBe(955)
    expect(u.perModel.map((m) => m.model)).toEqual(['claude-opus'])
    expect(u.totalCalls).toBe(1)
  })
})
