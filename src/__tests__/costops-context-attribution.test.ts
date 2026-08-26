import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  splitRuns,
  decomposeRun,
  freshSessionCost,
  getContextAttribution,
  SESSION_STARTUP_TOKENS,
  RUN_GAP_SECONDS,
  type UsageRow,
} from '../costops/context-attribution.js'

/**
 * R1-A (kanban #134): a scheduled task's cost is mostly a fact about the
 * session it landed in, not about the task. These tests pin the decomposition
 * and, more importantly, pin the honesty of the fresh-session comparison.
 */

const OPUS = 'claude-opus-5' // $5 in / $25 out per 1M
const T0 = 1_780_000_000

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    task_title: 'demo', session_id: 's1', model: OPUS, timestamp: T0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    ...over,
  }
}

describe('splitting a task into runs', () => {
  it('splits on a gap longer than the threshold', () => {
    const runs = splitRuns([
      row({ timestamp: T0 }),
      row({ timestamp: T0 + 5 }),
      row({ timestamp: T0 + RUN_GAP_SECONDS + 60 }),
    ])
    expect(runs.map(r => r.length)).toEqual([2, 1])
  })

  it('keeps calls seconds apart in one run', () => {
    expect(splitRuns([row({ timestamp: T0 }), row({ timestamp: T0 + 30 })])).toHaveLength(1)
  })

  it('would undercount runs if bucketed by clock hour instead', () => {
    // A quarter-hourly heartbeat fires up to 4 times an hour. Hour-bucketing
    // would call that one run and quadruple every per-run figure.
    const quarterly = [0, 900, 1800, 2700].map(d => row({ timestamp: T0 + d }))
    expect(splitRuns(quarterly)).toHaveLength(4)
  })

  it('handles an empty input', () => {
    expect(splitRuns([])).toEqual([])
  })
})

describe('separating inherited context from own work', () => {
  it('charges the first call\'s cache_read to inherited, the excess to own', () => {
    const c = decomposeRun([
      row({ cache_read_tokens: 1_000_000 }),                          // baseline
      row({ cache_read_tokens: 1_200_000, output_tokens: 1_000 }),    // +200k own
    ])!
    // inherited = 2 x 1M x $5 x 0.1 / 1M = $1.00
    expect(c.inherited).toBeCloseTo(1.0, 6)
    // own = 200k cache at 0.1x ($0.10) + 1k output at $25/1M ($0.025)
    expect(c.own).toBeCloseTo(0.125, 6)
    expect(c.total).toBeCloseTo(c.inherited + c.own, 10)
  })

  it('attributes nothing to inherited when the session started empty', () => {
    const c = decomposeRun([row({ cache_read_tokens: 0, output_tokens: 1_000_000 })])!
    expect(c.inherited).toBe(0)
    expect(c.own).toBeCloseTo(25, 6)
  })

  it('never charges a shrinking context as negative own work', () => {
    // Context can shrink across a run when compaction fires mid-task.
    const c = decomposeRun([
      row({ cache_read_tokens: 1_000_000 }),
      row({ cache_read_tokens: 200_000 }),
    ])!
    expect(c.own).toBeGreaterThanOrEqual(0)
  })

  it('returns null for an unpriced model rather than a zero cost', () => {
    expect(decomposeRun([row({ model: '<synthetic>' })])).toBeNull()
    expect(decomposeRun([])).toBeNull()
  })
})

describe('the fresh-session alternative is not free', () => {
  const own = { inherited: 10, own: 2, total: 12, calls: 1 }

  it('charges the startup preamble as a cache WRITE on the first call', () => {
    const cost = freshSessionCost(own, OPUS)
    // 41,224 x $5 x 1.25 / 1M = $0.2577, plus the unchanged own work
    expect(cost).toBeCloseTo((SESSION_STARTUP_TOKENS * 5 * 1.25) / 1e6 + 2, 6)
  })

  it('charges a re-read of that preamble on every later call', () => {
    const one = freshSessionCost({ ...own, calls: 1 }, OPUS)
    const five = freshSessionCost({ ...own, calls: 5 }, OPUS)
    expect(five).toBeGreaterThan(one)
    expect(five - one).toBeCloseTo((4 * SESSION_STARTUP_TOKENS * 5 * 0.1) / 1e6, 6)
  })

  it('keeps the task\'s own work unchanged -- only the inherited context goes', () => {
    expect(freshSessionCost({ inherited: 100, own: 3, total: 103, calls: 1 }, OPUS))
      .toBeCloseTo(freshSessionCost({ inherited: 0, own: 3, total: 3, calls: 1 }, OPUS), 10)
  })

  it('can come out MORE expensive, and says so', () => {
    // The honesty test. If a run inherited almost nothing, paying to load a
    // fresh preamble is a loss. A model that always favoured fresh sessions
    // would be rigged, and every saving it reported would be suspect.
    const cheapHost = { inherited: 0.001, own: 0.01, total: 0.011, calls: 1 }
    expect(freshSessionCost(cheapHost, OPUS)).toBeGreaterThan(cheapHost.total)
  })
})

describe('the report over real-shaped rows', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function insert(r: Partial<UsageRow> & { task_title: string }) {
    const f = row(r as Partial<UsageRow>)
    getDb().prepare(`INSERT INTO token_usage
      (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model,task_title)
      VALUES ('marveen',?,?,?,?,?,?,?,?)`).run(
      f.session_id, f.timestamp, f.input_tokens, f.output_tokens,
      f.cache_read_tokens, f.cache_creation_tokens, f.model, f.task_title)
  }

  it('only counts the tasks it was asked for', () => {
    // token_usage.task_title also holds kanban card titles written by
    // correlateWithKanban() -- a time-window guess. Letting those into a cost
    // figure would mix exact attribution with a heuristic one.
    insert({ task_title: 'memoria-heartbeat', session_id: 'a', cache_read_tokens: 1_000_000 })
    insert({ task_title: 'Some kanban card title', session_id: 'b', cache_read_tokens: 9_000_000 })
    const r = getContextAttribution(getDb(), { start: 0, end: T0 + 999, tasks: ['memoria-heartbeat'] })
    expect(r.tasks).toHaveLength(1)
    expect(r.tasks[0].task).toBe('memoria-heartbeat')
    expect(r.totals.inherited_cost).toBeCloseTo(0.5, 6)
  })

  it('returns an empty report rather than everything when given no task list', () => {
    insert({ task_title: 'memoria-heartbeat', cache_read_tokens: 1_000_000 })
    const r = getContextAttribution(getDb(), { start: 0, end: T0 + 999, tasks: [] })
    expect(r.tasks).toEqual([])
    expect(r.totals.total_cost).toBe(0)
  })

  it('splits two firings of the same task into two runs', () => {
    insert({ task_title: 'kanban-audit', timestamp: T0, cache_read_tokens: 500_000 })
    insert({ task_title: 'kanban-audit', timestamp: T0 + 3600, cache_read_tokens: 500_001 })
    const r = getContextAttribution(getDb(), { start: 0, end: T0 + 99999, tasks: ['kanban-audit'] })
    expect(r.tasks[0].runs).toBe(2)
  })

  it('reports the within/between variance instead of asserting it', () => {
    // The report carries the evidence for its own caveat: if one task's runs
    // vary more than the tasks differ, cost cannot signal complexity.
    // Distinct sessions per task: the dedup index is keyed on
    // (agent, session_id, timestamp, input, output), so two tasks sharing a
    // session and a timestamp would collide rather than both being stored.
    for (const [i, cr] of [10_000, 5_000_000, 20_000, 8_000_000].entries())
      insert({ task_title: 'memoria-heartbeat', session_id: 'hb', timestamp: T0 + i * 3600, cache_read_tokens: cr })
    for (const [i, cr] of [1_000_000, 1_100_000, 1_050_000, 1_020_000].entries())
      insert({ task_title: 'kanban-audit', session_id: 'ka', timestamp: T0 + i * 3600, cache_read_tokens: cr })
    const r = getContextAttribution(getDb(), { start: 0, end: T0 + 999999, tasks: ['memoria-heartbeat', 'kanban-audit'] })
    expect(r.complexity_signal.within_task_ratio_median).toBeGreaterThan(r.complexity_signal.between_task_ratio)
    expect(r.complexity_signal.verdict).toContain('cannot discriminate')
  })

  it('labels its basis and states its assumption', () => {
    const r = getContextAttribution(getDb(), { start: 0, end: T0, tasks: [] })
    expect(r.basis).toBe('list_price_equivalent')
    expect(r.currency).toBe('USD')
    expect(r.assumption).toContain('upper bound')
  })

  it('counts unpriced runs separately', () => {
    insert({ task_title: 'kanban-audit', model: '<synthetic>', cache_read_tokens: 1_000_000 })
    const r = getContextAttribution(getDb(), { start: 0, end: T0 + 999, tasks: ['kanban-audit'] })
    expect(r.unpriced_runs).toBe(1)
    expect(r.tasks).toEqual([])
  })
})
