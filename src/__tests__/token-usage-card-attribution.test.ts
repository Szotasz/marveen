// DBSIZE1111 step 2: a token row's card is worked out when the details are read, from the agent's in_progress
// windows in kanban_card_events (the #568 logic), not from the stored task_title. Real in-memory DB.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getTokenDetails, TOKEN_DETAILS_Q_MAX_WINDOWS } from '../web/token-usage.js'

const MAP = { botName: 'Marveen', mainAgentId: 'marveen', now: 100_000 }

function row(agent: string, ts: number, opts: { taskTitle?: string; preview?: string } = {}) {
  getDb().prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, content_preview, task_title, project)
     VALUES (?, 's', ?, 10, 1, 0, 0, ?, ?, ?)`,
  ).run(agent, ts, opts.preview ?? `call ${ts}`, opts.taskTitle ?? null, opts.taskTitle ? 'stale-project' : null)
}

function card(id: string, title: string, assignee: string, moves: [string | null, string, number][], archivedAt: number | null = null) {
  const db = getDb()
  db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at, sort_order, archived_at)
    VALUES (?, ?, 'done', 'normal', ?, 1, 99999, 0, ?)`).run(id, title, assignee, archivedAt)
  const ev = db.prepare('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
  for (const [from, to, at] of moves) ev.run(id, from, to, 'test', at)
}

const details = (opts: Parameters<typeof getTokenDetails>[0] = {}) =>
  new Map(getTokenDetails({ ...MAP, ...opts }).map((d) => [`${d.agent}@${d.timestamp}`, d]))

beforeEach(() => {
  initDatabase(':memory:')
})

describe('the card of a token row, at read time (DBSIZE1111)', () => {
  it('a row inside the window gets the card, a row outside gets none; the window end is exclusive', () => {
    card('c1', 'Fix the router', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'waiting', 2000]])
    row('samu', 999)
    row('samu', 1000)
    row('samu', 1500)
    row('samu', 2000)
    const d = details()
    expect(d.get('samu@999')?.taskCards).toEqual([])
    expect(d.get('samu@999')?.taskTitle).toBeNull()
    expect(d.get('samu@1000')?.taskCardId).toBe('c1')
    expect(d.get('samu@1500')?.taskTitle).toBe('Fix the router')
    expect(d.get('samu@1500')?.taskCards).toEqual([{ id: 'c1', title: 'Fix the router' }])
    expect(d.get('samu@2000')?.taskCards).toEqual([])
  })

  it('a card back in in_progress opens a second window; an open window runs until now', () => {
    card('c1', 'Twice', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'waiting', 1100], ['waiting', 'in_progress', 3000]])
    row('samu', 1050)
    row('samu', 2000)
    row('samu', 50_000)
    const d = details()
    expect(d.get('samu@1050')?.taskCardId).toBe('c1')
    expect(d.get('samu@2000')?.taskCardId).toBeNull()
    expect(d.get('samu@50000')?.taskCardId).toBe('c1')
  })

  it('overlapping cards: both are listed, none is picked', () => {
    card('c1', 'First', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'done', 3000]])
    card('c2', 'Second', 'samu', [['planned', 'in_progress', 2000], ['in_progress', 'done', 4000]])
    row('samu', 1500)
    row('samu', 2500)
    row('samu', 3500)
    const d = details()
    expect(d.get('samu@1500')?.taskCardId).toBe('c1')
    expect(d.get('samu@2500')?.taskCards.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(d.get('samu@2500')?.taskCardId).toBeNull()
    expect(d.get('samu@2500')?.taskTitle).toBeNull()
    expect(d.get('samu@3500')?.taskCardId).toBe('c2')
  })

  it('an archived card still names the rows it was worked on', () => {
    card('c-arch', 'Archived work', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'done', 2000]], 5000)
    row('samu', 1500)
    expect(details().get('samu@1500')?.taskTitle).toBe('Archived work')
  })

  it('only the assignee agent: another agent working at the same time gets nothing from this card', () => {
    card('c1', 'Samu card', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'done', 2000]])
    row('samu', 1500)
    row('geri', 1500)
    const d = details()
    expect(d.get('samu@1500')?.taskCardId).toBe('c1')
    expect(d.get('geri@1500')?.taskCards).toEqual([])
  })

  it("a card assigned to the bot's name belongs to the main agent's rows", () => {
    // A bot name that is NOT the main agent id, so only the mapping can join them.
    card('c-main', 'Main work', 'Robi', [['planned', 'in_progress', 1000], ['in_progress', 'done', 2000]])
    row('main-agent', 1500)
    const d = new Map(getTokenDetails({ botName: 'Robi', mainAgentId: 'main-agent', now: 100_000 }).map((x) => [`${x.agent}@${x.timestamp}`, x]))
    expect(d.get('main-agent@1500')?.taskTitle).toBe('Main work')
  })

  it('the stored task_title and project are not read and not returned', () => {
    row('samu', 1500, { taskTitle: 'stale title from the old correlation' })
    const d = getTokenDetails({ ...MAP })[0] as unknown as Record<string, unknown>
    expect(d.taskTitle).toBeNull()
    expect(d).not.toHaveProperty('task_title')
    expect(d).not.toHaveProperty('project')
  })
})

describe('q searches the card title through the windows (DBSIZE1111)', () => {
  beforeEach(() => {
    card('c1', 'Router hotfix', 'samu', [['planned', 'in_progress', 1000], ['in_progress', 'done', 2000]])
    row('samu', 1500)
    row('samu', 2500)
    row('geri', 1500)
  })

  it("finds the assignee's rows inside the card's window, and nothing else", () => {
    const keys = [...details({ q: 'hotfix' }).keys()]
    expect(keys).toEqual(['samu@1500'])
  })

  it('with an agent filter, only that agent', () => {
    expect([...details({ q: 'hotfix', agent: 'geri' }).keys()]).toEqual([])
    expect([...details({ q: 'hotfix', agent: 'samu' }).keys()]).toEqual(['samu@1500'])
  })

  it('the stored task_title is not searched any more', () => {
    row('samu', 7000, { taskTitle: 'only in the stale column' })
    expect([...details({ q: 'stale column' }).keys()]).toEqual([])
  })

  it('the other columns are still searched', () => {
    row('samu', 8000, { preview: 'deploy the hotfix branch' })
    expect([...details({ q: 'hotfix' }).keys()].sort()).toEqual(['samu@1500', 'samu@8000'])
  })

  it(`a broad title match is capped at the newest ${TOKEN_DETAILS_Q_MAX_WINDOWS} windows`, () => {
    for (let i = 0; i <= TOKEN_DETAILS_Q_MAX_WINDOWS; i++) {
      const t = 10_000 + i * 10
      card(`m${i}`, `Many cards ${i}`, 'samu', [['planned', 'in_progress', t], ['in_progress', 'done', t + 5]])
      row('samu', t + 1)
    }
    const keys = new Set(details({ q: 'Many cards', limit: 500 }).keys())
    expect(keys.size).toBe(TOKEN_DETAILS_Q_MAX_WINDOWS)
    expect(keys.has('samu@10001')).toBe(false)
    expect(keys.has(`samu@${10_000 + TOKEN_DETAILS_Q_MAX_WINDOWS * 10 + 1}`)).toBe(true)
  })
})
