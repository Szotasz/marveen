import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HEARTBEAT_URGENT_SQL, HEARTBEAT_WAITING_SQL } from '../db.js'

// The most prominent line of an hourly report is the one nobody reads.
//
// On 2026-08-04 the 09:00 heartbeat listed five items under urgent/waiting, of
// which THREE were already `done`; the 08-03 measurement was 22 done vs 2
// waiting, so ~92% of that line was closed work. A signal that always shows the
// same thing stops being a signal -- the same failure family as the silent
// channel death we spent the day on, seen from the other side.
//
// Three things are pinned here, and the LAST one matters most:
//   1. a `done` (or archived) card never reaches the list;
//   2. a `planned` urgent card DOES reach it -- "urgent and nobody has touched
//      it" is one of the states most worth seeing. An earlier draft narrowed the
//      list to waiting/in_progress and was withdrawn for exactly that reason, so
//      the inclusion is asserted rather than assumed;
//   3. an EMPTY list is allowed to stay empty. "Fill it with something so the
//      section is not blank" is the natural wrong fix, and it is the one that
//      would quietly bring the noise back.

const ROOT = join(__dirname, '..', '..')

function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-urgent-'))
  const db = new Database(join(dir, 'test.db'))
  db.exec(`CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, priority TEXT,
    assignee TEXT, archived_at INTEGER, updated_at INTEGER, created_at INTEGER, sort_order INTEGER
  )`)
  const ins = db.prepare(
    "INSERT INTO kanban_cards (id,title,status,priority,assignee,archived_at,updated_at,created_at,sort_order) VALUES (?,?,?,?,?,?,?,?,0)",
  )
  return { dir, db, ins }
}

describe('the heartbeat urgent list contains urgent, unfinished cards', () => {
  it('excludes done and archived, keeps waiting, in_progress AND planned', () => {
    const { dir, db, ins } = fixtureDb()
    try {
      ins.run('OPEN1', 'urgent + in_progress', 'in_progress', 'urgent', 'samu', null, 1, 1)
      ins.run('OPEN2', 'urgent + waiting', 'waiting', 'urgent', 'samu', null, 1, 1)
      ins.run('DONE1', 'urgent but finished', 'done', 'urgent', 'samu', null, 1, 1)
      ins.run('DONE2', 'urgent, finished, older', 'done', 'urgent', null, null, 1, 1)
      ins.run('ARCH1', 'urgent but archived', 'waiting', 'urgent', 'samu', 12345, 1, 1)
      ins.run('PLAN1', 'urgent but not started', 'planned', 'urgent', 'samu', null, 1, 1)
      ins.run('NORM1', 'in_progress but not urgent', 'in_progress', 'normal', 'samu', null, 1, 1)

      const rows = db.prepare(HEARTBEAT_URGENT_SQL).all() as { id: string }[]
      const ids = rows.map((r) => r.id).sort()

      expect(ids).toEqual(['OPEN1', 'OPEN2', 'PLAN1'])
      expect(ids).not.toContain('DONE1')
      expect(ids).not.toContain('DONE2')
      expect(ids).not.toContain('ARCH1')
      // pinned explicitly: an urgent card nobody has started must be VISIBLE.
      // Hiding it would make the line quiet for the wrong reason.
      expect(ids).toContain('PLAN1')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a board where every urgent card is done yields an EMPTY list -- not a fallback', () => {
    const { dir, db, ins } = fixtureDb()
    try {
      ins.run('D1', 'done urgent', 'done', 'urgent', 'samu', null, 1, 1)
      ins.run('D2', 'done urgent', 'done', 'urgent', 'samu', null, 1, 1)
      ins.run('D3', 'done urgent', 'done', 'urgent', 'samu', null, 1, 1)

      const rows = db.prepare(HEARTBEAT_URGENT_SQL).all() as unknown[]
      expect(rows).toEqual([])
      expect(rows.length).toBe(0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an EMPTY board stays empty on both lists', () => {
    const { dir, db } = fixtureDb()
    try {
      expect(db.prepare(HEARTBEAT_URGENT_SQL).all()).toEqual([])
      expect(db.prepare(HEARTBEAT_WAITING_SQL).all()).toEqual([])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the waiting list is waiting-only and drops archived rows', () => {
    const { dir, db, ins } = fixtureDb()
    try {
      ins.run('W1', 'waiting', 'waiting', 'normal', 'samu', null, 1, 1)
      ins.run('W2', 'waiting but archived', 'waiting', 'normal', 'samu', 999, 1, 1)
      ins.run('W3', 'done', 'done', 'normal', 'samu', null, 1, 1)
      const ids = (db.prepare(HEARTBEAT_WAITING_SQL).all() as { id: string }[]).map((r) => r.id)
      expect(ids).toEqual(['W1'])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('there is ONE definition, and both consumers read it', () => {
  const DB_SRC = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf-8')
  const HEARTBEAT_SRC = readFileSync(join(ROOT, 'src', 'heartbeat.ts'), 'utf-8')
  const ROUTE_SRC = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
  const SCAFFOLD_SRC = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

  it('the built-in heartbeat does not run its own kanban SQL', () => {
    expect(HEARTBEAT_SRC).toContain('getHeartbeatKanbanSummary')
    expect(HEARTBEAT_SRC).not.toMatch(/FROM kanban_cards/i)
  })

  it('the API endpoint serves the same summary function', () => {
    expect(ROUTE_SRC).toContain("path === '/api/kanban/heartbeat-summary'")
    expect(ROUTE_SRC).toContain('getHeartbeatKanbanSummary()')
    expect(ROUTE_SRC).not.toMatch(/priority = 'urgent'/)
  })

  it('the definition itself excludes finished and archived work, and nothing else', () => {
    const fn = DB_SRC.slice(DB_SRC.indexOf('HEARTBEAT_URGENT_SQL'), DB_SRC.indexOf('getHeartbeatKanbanSummary('))
    expect(fn).toMatch(/archived_at IS NULL/)
    expect(fn).toMatch(/status != 'done'/)
    // no status allowlist: narrowing to waiting/in_progress would hide an
    // untouched urgent card, which is the state we most want to see
    expect(fn).not.toMatch(/status IN \(/)
  })
})

describe('the heartbeat AGENT is handed the list, not a filter to re-apply', () => {
  const SCAFFOLD_SRC = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')
  // The kanban step lives inside the single Metrics instrument bullet since
  // the HBMEMBLIND819 third contract; the window is that bullet's own bounds.
  const kanbanBlock = SCAFFOLD_SRC.slice(
    SCAFFOLD_SRC.indexOf('- **Metrics ('),
    SCAFFOLD_SRC.indexOf('2. **Format**'),
  )

  it('the kanban step is one endpoint call', () => {
    expect(kanbanBlock).toContain('/api/kanban/heartbeat-summary')
  })

  it('that step no longer asks the agent to compose SQL or to run sqlite3', () => {
    expect(kanbanBlock).not.toMatch(/sqlite3 \$\{id\.storeDir\}/)
    expect(kanbanBlock).not.toMatch(/SELECT .* FROM kanban_cards/i)
    expect(kanbanBlock).not.toMatch(/status != 'done'/)
  })

  it('it says out loud that an empty list stays empty', () => {
    expect(kanbanBlock).toMatch(/report it as empty/i)
    expect(kanbanBlock).toMatch(/Do not widen the query|do not fall back|do not fill/i)
  })
})
