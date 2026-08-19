import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HEARTBEAT_NEW_HOT_MEMORIES_SQL } from '../db.js'

// HBMEMBLIND819: the heartbeat's "new hot memories (1h)" line said 0 for
// 14/14 rounds over 24h while the real value was 2 in three of them. Second
// failure of the prescribe-the-query pattern for this metric (HBMEMBLIND807
// was the first): the agent ran the prescribed query SHAPE but substituted
// agent_id='heartbeat' for the main agent's id on post-compact rounds, and
// the wrong form then persisted as its own precedent. The closure is the same
// one the kanban counts already use: the number is computed server-side and
// served over /api/kanban/heartbeat-summary; the agent copies it and never
// runs a query. These tests pin BOTH halves: the shipped SQL counts the right
// rows, and the scaffold no longer tells the agent to run anything for it.

const ROOT = join(__dirname, '..', '..')

function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-hotmem-'))
  const db = new Database(join(dir, 'test.db'))
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY, agent_id TEXT, category TEXT, content TEXT, created_at INTEGER
  )`)
  const ins = db.prepare('INSERT INTO memories (agent_id,category,content,created_at) VALUES (?,?,?,?)')
  return { db, ins }
}

describe('HEARTBEAT_NEW_HOT_MEMORIES_SQL (the shipped statement, on a fixture DB)', () => {
  it('counts only the given agent, only hot, only the last hour', () => {
    const { db, ins } = fixtureDb()
    const now = Math.floor(Date.now() / 1000)
    ins.run('marveen', 'hot', 'fresh main-agent hot #1', now - 60)
    ins.run('marveen', 'hot', 'fresh main-agent hot #2', now - 3599)
    // The exact wrong-row family HBMEMBLIND819 measured: the heartbeat's OWN
    // id. It must not be countable by accident when the caller passes the
    // main agent's id.
    ins.run('heartbeat', 'hot', 'heartbeat own hot', now - 60)
    ins.run('marveen', 'hot', 'main-agent hot but old', now - 3700)
    ins.run('marveen', 'warm', 'fresh but warm', now - 60)

    const forMain = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('marveen') as { n: number }
    expect(forMain.n).toBe(2)

    // And the failure shape itself, replayed: querying with the heartbeat's
    // own id sees a different world -- which is WHY the id must be supplied
    // server-side, not reconstructed by the agent.
    const forHeartbeat = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('heartbeat') as { n: number }
    expect(forHeartbeat.n).toBe(1)
  })

  it('empty table -> 0, not NULL-shaped surprises', () => {
    const { db } = fixtureDb()
    const row = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('marveen') as { n: number }
    expect(row.n).toBe(0)
  })
})

describe('wiring contract: the number flows endpoint -> agent, never agent -> query', () => {
  const KANBAN = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
  const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

  it('heartbeat-summary serves counts.new_hot_memories_1h computed with MAIN_AGENT_ID', () => {
    // Anchor the window to the endpoint handler's own structural bounds
    // (start marker to the closing `return true`), NOT to the sought string --
    // a window derived from the needle grows until it contains it and the
    // assertion cannot fail (the #1006 review lesson).
    const start = KANBAN.indexOf("'/api/kanban/heartbeat-summary'")
    expect(start).toBeGreaterThanOrEqual(0)
    const end = KANBAN.indexOf('return true', start)
    expect(end).toBeGreaterThan(start)
    const handler = KANBAN.slice(start, end)
    expect(handler).toMatch(/new_hot_memories_1h:\s*countNewHotMemories\(MAIN_AGENT_ID\)/)
  })

  it('the scaffold tells the agent to COPY the field and forbids running a query for it', () => {
    expect(SCAFFOLD).toMatch(/counts\.new_hot_memories_1h/)
    // The memory bullet must not prescribe (or even show) a runnable
    // hot-memory SQL anymore -- that is the exact surface that drifted twice.
    expect(SCAFFOLD).not.toMatch(/FROM memories[\s\S]{0,120}category='hot'/)
    // Missing field degrades to "no data", never to a self-run query or a 0.
    expect(SCAFFOLD).toMatch(/nincs adat \(a summary nem adja\)/)
  })
})
