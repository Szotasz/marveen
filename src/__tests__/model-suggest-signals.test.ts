// Behaviour tests for the two model-suggest route signals, replacing the
// source-text pins that shipped with #1385.
//
// WHY THEY WERE NOT ENOUGH, measured on that PR's head (6d278ea3) before this
// change: reverting the cache-blind sum turned a test red, and reverting the
// kanban filter turned a test red, but a third mutation that KEPT every
// identifier and broke only the VALUE -- the same sum divided by
// totalCalls * 1000 -- left all 35 tests green. The pins read routes/agents.ts
// and matched `totalCacheRead` and `status <> 'done'` as text, and both were
// still there. That mutation reproduces exactly the defect #1385 fixed: a real
// number computed from the wrong place, which never looks broken.
//
// So these tests assert the RETURNED VALUE of a pure function, and run the
// kanban SQL against a real table to see which ROWS it counts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  contextAvgPerCallMap,
  kanbanLoadMap,
  KANBAN_LOAD_SQL,
  deliveredRunsPerDayMap,
  DELIVERED_RUNS_SQL,
  DELIVERED_RUNS_WINDOW_DAYS,
  type KanbanLoadRow,
  type DeliveredRunsRow,
} from '../web/model-suggest-signals.js'

describe('contextAvgPerCallMap', () => {
  it('counts cache reads and cache creation, not just the uncached remainder', () => {
    // The shape of a long-lived session: the context arrives from the prompt
    // cache, the uncached remainder is a rounding error. This is the case the
    // old signal got wrong, and the numbers are the ones actually measured on
    // the live install (2 tokens/call against a true ~466K).
    const map = contextAvgPerCallMap([
      { agent: 'boni', totalCalls: 100, totalInput: 200, totalCacheRead: 46_000_000, totalCacheCreation: 660_000 },
    ])
    expect(map.get('boni')).toBe((200 + 46_000_000 + 660_000) / 100)
    expect(map.get('boni')).toBeGreaterThan(150_000)
    // Stated rather than implied: this is what the pre-fix signal returned, and
    // it is below every threshold the classifier has.
    expect(map.get('boni')).not.toBe(200 / 100)
  })

  it('divides by calls, so the result is per-call and not a total', () => {
    const one = contextAvgPerCallMap([
      { agent: 'a', totalCalls: 1, totalInput: 0, totalCacheRead: 400_000, totalCacheCreation: 0 },
    ])
    const ten = contextAvgPerCallMap([
      { agent: 'a', totalCalls: 10, totalInput: 0, totalCacheRead: 4_000_000, totalCacheCreation: 0 },
    ])
    // Same context per call, ten times the traffic: the signal must not move.
    expect(one.get('a')).toBe(400_000)
    expect(ten.get('a')).toBe(400_000)
  })

  it('maps a zero-call agent to 0 rather than dropping or dividing by zero', () => {
    const map = contextAvgPerCallMap([
      { agent: 'idle', totalCalls: 0, totalInput: 0, totalCacheRead: 0, totalCacheCreation: 0 },
    ])
    expect(map.has('idle')).toBe(true)
    expect(map.get('idle')).toBe(0)
  })
})

describe('the kanban load query, run against a real table', () => {
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        archived_at INTEGER
      )
    `)
    const add = db.prepare(
      'INSERT INTO kanban_cards (id, title, status, assignee, priority, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
    // Two genuinely open cards, one of them urgent.
    add.run('c1', 'nyitott', 'in_progress', 'boni', 'high', null)
    add.run('c2', 'nyitott', 'planned', 'boni', 'normal', null)
    // Done but NOT yet archived: the 7-day sweep has not run. This is the row
    // the old query counted as load, and the one that inflated the urgent count.
    add.run('c3', 'kesz', 'done', 'boni', 'urgent', null)
    add.run('c4', 'kesz', 'done', 'boni', 'high', null)
    // Archived: excluded by both the old and the new query.
    add.run('c5', 'archivalt', 'in_progress', 'boni', 'urgent', 1_700_000_000)
    // Unassigned: must not reach any agent's bucket.
    add.run('c6', 'gazdatlan', 'planned', null, 'urgent', null)
  })

  afterEach(() => db.close())

  it('counts open cards only, so finished work does not read as load', () => {
    const rows = db.prepare(KANBAN_LOAD_SQL).all() as KanbanLoadRow[]
    const load = kanbanLoadMap(rows)
    expect(load.get('boni')).toEqual({ open: 2, urgent: 1 })
  })

  it('the done cards WOULD have counted without the filter (negative control)', () => {
    // The same query with the filter removed, on the same fixture: this is what
    // the pre-#1385 route saw, and it is the reason the number is worth a test.
    const withoutFilter = KANBAN_LOAD_SQL.replace(" AND status <> 'done'", '')
    expect(withoutFilter).not.toBe(KANBAN_LOAD_SQL)
    const rows = db.prepare(withoutFilter).all() as KanbanLoadRow[]
    const load = kanbanLoadMap(rows)
    // 4 open instead of 2, and 3 urgent/high instead of 1 -- across the
    // kanbanUrgentCount >= 2 threshold, which is an Opus signal.
    expect(load.get('boni')).toEqual({ open: 4, urgent: 3 })
  })

  it('leaves unassigned cards out of every bucket', () => {
    const rows = db.prepare(KANBAN_LOAD_SQL).all() as KanbanLoadRow[]
    const load = kanbanLoadMap(rows)
    expect(load.has('')).toBe(false)
    expect([...load.keys()]).toEqual(['boni'])
  })
})

describe('kanbanLoadMap', () => {
  it('counts urgent and high together as the urgent bucket, and both into open', () => {
    const load = kanbanLoadMap([
      { assignee: 'x', priority: 'urgent', cnt: 2 },
      { assignee: 'x', priority: 'high', cnt: 3 },
      { assignee: 'x', priority: 'normal', cnt: 4 },
      { assignee: 'x', priority: 'low', cnt: 1 },
    ])
    expect(load.get('x')).toEqual({ open: 10, urgent: 5 })
  })

  it('skips null assignees instead of creating an empty-name bucket', () => {
    const load = kanbanLoadMap([
      { assignee: null, priority: 'urgent', cnt: 9 },
      { assignee: 'y', priority: 'normal', cnt: 1 },
    ])
    expect([...load.keys()]).toEqual(['y'])
  })
})

// The scheduled-frequency signal. The defect it replaces is not a wrong query
// but a wrong SOURCE: the route summed cron expressions, which describe what
// the scheduler INTENDS, while the classifier reads the number as how much
// work actually reaches the model. The two diverge wherever a task skips.

describe('DELIVERED_RUNS_SQL', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'fired')`)
  })
  afterEach(() => db.close())

  const add = (agent: string, status: string, n: number, ts: number) => {
    const ins = db.prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?,?,?,?)')
    for (let i = 0; i < n; i++) ins.run('t', agent, ts, status)
  }

  it('counts only fired rows, so a skipping precheck cannot inflate the signal', () => {
    // The live shape measured 2026-10-05: a 2-minute watcher produced 720
    // skipped-precheck rows against 29 rounds that reached the model. Counting
    // every row returns 749 and the classifier reads a busy, cheap agent.
    const now = Date.now()
    add('marveen', 'skipped-precheck', 720, now - 1000)
    add('marveen', 'fired', 29, now - 1000)
    const rows = db.prepare(DELIVERED_RUNS_SQL).all(now - 86400_000) as DeliveredRunsRow[]
    expect(rows).toEqual([{ agent: 'marveen', cnt: 29 }])
  })

  it('excludes rows older than the window instead of averaging over all history', () => {
    const now = Date.now()
    add('marveen', 'fired', 5, now - 1000)
    add('marveen', 'fired', 500, now - 90 * 86400_000)
    const rows = db.prepare(DELIVERED_RUNS_SQL).all(now - 7 * 86400_000) as DeliveredRunsRow[]
    expect(rows).toEqual([{ agent: 'marveen', cnt: 5 }])
  })
})

describe('deliveredRunsPerDayMap', () => {
  it('divides by the window so the signal is a daily rate, not a window total', () => {
    const map = deliveredRunsPerDayMap([{ agent: 'a', cnt: 203 }], 7)
    expect(map.get('a')).toBe(29)
  })

  it('leaves an agent with no rows ABSENT, so the route can tell it from a measured zero', () => {
    const map = deliveredRunsPerDayMap([{ agent: 'a', cnt: 7 }], 7)
    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(false)
    expect(map.get('b')).toBeUndefined()
  })

  it('skips null agents instead of creating an empty-name bucket', () => {
    const map = deliveredRunsPerDayMap([
      { agent: null, cnt: 9 },
      { agent: 'y', cnt: 7 },
    ], 7)
    expect([...map.keys()]).toEqual(['y'])
  })

  it('never divides by zero when handed a nonsense window', () => {
    expect(deliveredRunsPerDayMap([{ agent: 'a', cnt: 4 }], 0).get('a')).toBe(4)
  })

  it('defaults to the window the route uses, so the two cannot drift apart', () => {
    const viaDefault = deliveredRunsPerDayMap([{ agent: 'a', cnt: 14 }])
    const viaExplicit = deliveredRunsPerDayMap([{ agent: 'a', cnt: 14 }], DELIVERED_RUNS_WINDOW_DAYS)
    expect(viaDefault.get('a')).toBe(viaExplicit.get('a'))
  })
})
