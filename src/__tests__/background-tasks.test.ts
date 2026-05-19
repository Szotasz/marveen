import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

describe('background_tasks schema and CRUD', () => {
  let db: ReturnType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE background_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
        tmux_session TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        output TEXT
      )
    `)
    db.exec(`CREATE INDEX idx_bg_tasks_agent ON background_tasks(agent_id, status)`)
  })

  it('inserts a running task', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ABCD1234', 'marveen', 'test prompt', 'running', 'bg-ABCD1234', now)

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('ABCD1234') as any
    expect(row.agent_id).toBe('marveen')
    expect(row.status).toBe('running')
    expect(row.prompt).toBe('test prompt')
    expect(row.tmux_session).toBe('bg-ABCD1234')
    expect(row.finished_at).toBeNull()
  })

  it('finishes a task with done status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('AAAA', 'samu', 'build something', 'running', 'bg-AAAA', now)

    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('done', now + 100, 'Build succeeded', 'AAAA')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('AAAA') as any
    expect(row.status).toBe('done')
    expect(row.output).toBe('Build succeeded')
    expect(row.finished_at).toBe(now + 100)
  })

  it('rejects invalid status', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => {
      db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)')
        .run('BAD1', 'test', 'bad', 'invalid_status', now)
    }).toThrow()
  })

  it('counts running tasks per agent', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A1', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A2', 'marveen', 'p2', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A3', 'marveen', 'p3', 'done', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A4', 'samu', 'p4', 'running', now)

    const count = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('marveen') as any).c
    expect(count).toBe(2)

    const samuCount = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('samu') as any).c
    expect(samuCount).toBe(1)
  })

  it('lists tasks with optional agent filter', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B1', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B2', 'samu', 'p2', 'done', now)

    const all = db.prepare('SELECT * FROM background_tasks ORDER BY started_at DESC').all()
    expect(all).toHaveLength(2)

    const running = db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all()
    expect(running).toHaveLength(1)

    const marveenOnly = db.prepare("SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running'").all('marveen')
    expect(marveenOnly).toHaveLength(1)
  })

  it('supports timeout status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('T1', 'test', 'slow task', 'running', now)
    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('timeout', now + 1800, '(timeout after 30 min)', 'T1')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('T1') as any
    expect(row.status).toBe('timeout')
  })
})
