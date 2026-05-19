import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

describe('kanban parent_id schema and subtask queries', () => {
  let db: ReturnType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT,
        parent_id TEXT REFERENCES kanban_cards(id),
        due_date INTEGER,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      )
    `)
    db.exec('CREATE INDEX idx_kanban_parent ON kanban_cards(parent_id)')
  })

  it('creates a card with parent_id', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('PARENT01', 'Parent card', 'planned', 0, now, now)
    db.prepare('INSERT INTO kanban_cards (id, title, status, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('CHILD001', 'Child card', 'planned', 'PARENT01', 1, now, now)

    const child = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get('CHILD001') as any
    expect(child.parent_id).toBe('PARENT01')
  })

  it('queries children of a parent', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('PARENT01', 'Big task', 'in_progress', 0, now, now)

    for (let i = 1; i <= 4; i++) {
      db.prepare('INSERT INTO kanban_cards (id, title, status, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`CHILD00${i}`, `Subtask ${i}`, 'planned', 'PARENT01', i, now, now)
    }

    const children = db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all('PARENT01') as any[]
    expect(children).toHaveLength(4)
    expect(children[0].title).toBe('Subtask 1')
    expect(children[3].title).toBe('Subtask 4')
  })

  it('excludes archived children', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('PARENT01', 'Parent', 'planned', 0, now, now)
    db.prepare('INSERT INTO kanban_cards (id, title, status, parent_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('CHILD001', 'Active', 'planned', 'PARENT01', 1, now, now)
    db.prepare('INSERT INTO kanban_cards (id, title, status, parent_id, sort_order, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('CHILD002', 'Archived', 'done', 'PARENT01', 2, now, now, now)

    const children = db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL').all('PARENT01') as any[]
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe('CHILD001')
  })

  it('card without parent_id has null', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('SOLO0001', 'Solo card', 'planned', 0, now, now)

    const card = db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get('SOLO0001') as any
    expect(card.parent_id).toBeNull()
  })

  it('parent card lists no children when none exist', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('NOCHILDS', 'Leaf card', 'planned', 0, now, now)

    const children = db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL').all('NOCHILDS') as any[]
    expect(children).toHaveLength(0)
  })
})

describe('llm-breakdown validation', () => {
  function validateSubtasks(raw: unknown) {
    if (!Array.isArray(raw)) throw new Error('not an array')
    if (raw.length < 1 || raw.length > 10) throw new Error(`bad length: ${raw.length}`)
    const validPriorities = new Set(['low', 'normal', 'high', 'urgent'])
    return raw.map((item: any, i: number) => {
      if (!item.title || typeof item.title !== 'string') throw new Error(`Subtask ${i}: missing title`)
      if (!item.description || typeof item.description !== 'string') throw new Error(`Subtask ${i}: missing description`)
      return {
        title: item.title.slice(0, 120),
        description: item.description.slice(0, 500),
        assignee: typeof item.assignee === 'string' ? item.assignee : null,
        priority: validPriorities.has(item.priority) ? item.priority : 'normal',
      }
    })
  }

  it('validates well-formed subtasks', () => {
    const input = [
      { title: 'Task 1', description: 'Do stuff', assignee: 'Samu', priority: 'high' },
      { title: 'Task 2', description: 'More stuff', assignee: null, priority: 'normal' },
    ]
    const result = validateSubtasks(input)
    expect(result).toHaveLength(2)
    expect(result[0].assignee).toBe('Samu')
    expect(result[0].priority).toBe('high')
    expect(result[1].assignee).toBeNull()
  })

  it('rejects non-array', () => {
    expect(() => validateSubtasks('oops')).toThrow('not an array')
  })

  it('rejects empty array', () => {
    expect(() => validateSubtasks([])).toThrow('bad length')
  })

  it('defaults invalid priority to normal', () => {
    const result = validateSubtasks([{ title: 'T', description: 'D', priority: 'mega' }])
    expect(result[0].priority).toBe('normal')
  })

  it('truncates long titles', () => {
    const result = validateSubtasks([{ title: 'X'.repeat(200), description: 'D' }])
    expect(result[0].title.length).toBe(120)
  })

  it('treats non-string assignee as null', () => {
    const result = validateSubtasks([{ title: 'T', description: 'D', assignee: 42 }])
    expect(result[0].assignee).toBeNull()
  })

  it('rejects item without title', () => {
    expect(() => validateSubtasks([{ description: 'D' }])).toThrow('missing title')
  })

  it('rejects item without description', () => {
    expect(() => validateSubtasks([{ title: 'T' }])).toThrow('missing description')
  })
})

describe('breakdown route regex patterns', () => {
  it('matches breakdown path', () => {
    const re = /^\/api\/kanban\/([^/]+)\/breakdown$/
    expect(re.test('/api/kanban/ABCD1234/breakdown')).toBe(true)
    expect(re.test('/api/kanban/some-id/breakdown')).toBe(true)
    expect(re.test('/api/kanban//breakdown')).toBe(false)
    expect(re.test('/api/kanban/ABCD/breakdown/extra')).toBe(false)
  })

  it('matches accept path', () => {
    const re = /^\/api\/kanban\/([^/]+)\/breakdown\/accept$/
    expect(re.test('/api/kanban/ABCD1234/breakdown/accept')).toBe(true)
    expect(re.test('/api/kanban/x/breakdown/accept')).toBe(true)
    expect(re.test('/api/kanban//breakdown/accept')).toBe(false)
  })

  it('matches children path', () => {
    const re = /^\/api\/kanban\/([^/]+)\/children$/
    expect(re.test('/api/kanban/PARENT01/children')).toBe(true)
    expect(re.test('/api/kanban//children')).toBe(false)
  })
})
