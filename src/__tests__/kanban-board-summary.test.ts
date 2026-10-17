// Card ed3c8caf (#569): per-agent board summary. Closed cards come from the
// done events in the window (who closed them), stuck cards from the existing
// getStuckKanbanCards measurement, and the owner's waiting cards are listed
// separately with a cap.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, createKanbanCard, getBoardSummary, BOARD_SUMMARY_OWNER_CAP } from '../db.js'

const OPTS = { ownerName: 'Owner', botName: 'Orin', mainAgentId: 'orin' }
const NOW = Math.floor(Date.now() / 1000)
const DAY = 86400

function event(cardId: string, from: string | null, to: string, actor: string | null, at: number): void {
  getDb().prepare(
    'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(cardId, from, to, actor, at)
}

function setCard(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields)
  getDb().prepare(`UPDATE kanban_cards SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`)
    .run(...keys.map((k) => fields[k] as never), id)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('getBoardSummary', () => {
  it('lists cards closed in the window under the agent that closed them', () => {
    createKanbanCard({ id: 'c1', title: 'Recent', assignee: 'dex' })
    createKanbanCard({ id: 'c2', title: 'Old', assignee: 'dex' })
    createKanbanCard({ id: 'c3', title: 'By main', assignee: 'Orin' })
    createKanbanCard({ id: 'c4', title: 'Born done', assignee: 'dex', status: 'done' })
    event('c1', 'in_progress', 'done', 'dex', NOW - 7200)
    event('c1', 'done', 'in_progress', 'dex', NOW - 5000)
    event('c1', 'in_progress', 'done', 'dex', NOW - 3600) // closed twice: listed once
    event('c2', 'in_progress', 'done', 'dex', NOW - 3 * DAY)
    event('c3', 'in_progress', 'done', null, NOW - 600) // no actor: falls back to the assignee
    const s = getBoardSummary({ ...OPTS, since: NOW - DAY })
    const dex = s.agents.find((a) => a.agent === 'dex')!
    expect(dex.closed.map((c) => c.id)).toEqual(['c1'])
    expect(dex.closed[0].closed_at).toBe(NOW - 3600)
    // The bot name folds into the main agent id.
    expect(s.agents.find((a) => a.agent === 'orin')!.closed.map((c) => c.id)).toEqual(['c3'])
    expect(s.agents.some((a) => a.agent === 'Orin')).toBe(false)
  })

  it('the owner closing a card is not an agent row', () => {
    createKanbanCard({ id: 'c1', title: 'Mine', assignee: 'Owner', status: 'done' })
    event('c1', 'waiting', 'done', 'owner', NOW - 60)
    expect(getBoardSummary({ ...OPTS, since: NOW - DAY }).agents).toEqual([])
  })

  it('carries done_evidence when the column exists, null otherwise', () => {
    createKanbanCard({ id: 'c1', title: 'Checked', assignee: 'dex', status: 'done' })
    event('c1', 'in_progress', 'done', 'dex', NOW - 60)
    expect(getBoardSummary({ ...OPTS, since: NOW - DAY }).agents[0].closed[0].evidence).toBeNull()
    const cols = (getDb().prepare('PRAGMA table_info(kanban_cards)').all() as Array<{ name: string }>).map((c) => c.name)
    if (!cols.includes('done_evidence')) getDb().exec('ALTER TABLE kanban_cards ADD COLUMN done_evidence TEXT')
    setCard('c1', { done_evidence: 'tests green' })
    expect(getBoardSummary({ ...OPTS, since: NOW - DAY }).agents[0].closed[0].evidence).toBe('tests green')
  })

  it('stuck cards come from the stuck measurement, per assignee', () => {
    createKanbanCard({ id: 's1', title: 'Started then idle', assignee: 'Dex' })
    setCard('s1', { status: 'in_progress', created_at: NOW - 10 * DAY, updated_at: NOW - 10 * DAY })
    event('s1', 'planned', 'in_progress', 'dex', NOW - 10 * DAY)
    createKanbanCard({ id: 's2', title: 'Fresh', assignee: 'dex', status: 'in_progress' })
    event('s2', 'planned', 'in_progress', 'dex', NOW - 60)
    const dex = getBoardSummary({ ...OPTS, since: NOW - DAY }).agents.find((a) => a.agent === 'dex')!
    expect(dex.stuck.map((c) => c.id)).toEqual(['s1'])
    expect(dex.stuck[0].idle_days).toBeGreaterThanOrEqual(9)
  })

  it('owner_waiting: waiting cards assigned to the owner, counted in full, listed with a cap', () => {
    for (let i = 0; i < BOARD_SUMMARY_OWNER_CAP + 2; i++) {
      createKanbanCard({ id: `w${i}`, title: `Decide ${i}`, assignee: 'Owner', status: 'waiting' })
    }
    createKanbanCard({ id: 'wx', title: 'Archived', assignee: 'Owner', status: 'waiting' })
    setCard('wx', { archived_at: NOW })
    createKanbanCard({ id: 'wy', title: 'Agent waiting', assignee: 'dex', status: 'waiting' })
    const s = getBoardSummary({ ...OPTS, since: NOW - DAY })
    expect(s.owner_waiting.count).toBe(BOARD_SUMMARY_OWNER_CAP + 2)
    expect(s.owner_waiting.cards).toHaveLength(BOARD_SUMMARY_OWNER_CAP)
    expect(s.owner_waiting.cards.some((c) => c.id === 'wx' || c.id === 'wy')).toBe(false)
  })
})
