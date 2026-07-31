// CostOps -- R1-A: what a scheduled task actually pays for.
//
// The router this was originally meant to shadow assumed the model is the
// dominant cost variable for a scheduled task. Measurement says otherwise:
// across the 13 labelled tasks, the spread WITHIN one task (11x median) is
// larger than the spread BETWEEN tasks (5.9x), and memoria-heartbeat alone
// ranges from $0.05 to $11.44 for identical work -- a 249x range tracking
// cache_read per call almost exactly ($11.44 at 730k, $0.05 at 47k).
//
// The reason is structural: the schedule runner injects into an already-running
// session, so a task pays to re-read whatever context that session had
// accumulated. What it costs is mostly a fact about its host, not about itself.
//
// So this module decomposes a task's spend into context it INHERITED and work
// it actually DID, and prices the alternative of running it in a fresh session.
// Read-only: it computes, stores nothing, changes nothing.

import type Database from 'better-sqlite3'
import { PRICE_MAP, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, isPriced } from './pricing.js'

/**
 * Context a fresh session loads before doing any work: system prompt, CLAUDE.md
 * and skill headers.
 *
 * Measured, not assumed: across the 40 sessions in token_usage with a usable
 * first call, the first call's input + cache_read + cache_write has a median of
 * 41,224 tokens (quartiles 36.3k / 43.5k, max 49.5k). Tight enough that a
 * single constant models it honestly; exported so a caller can override it if
 * the fleet's preamble grows.
 */
export const SESSION_STARTUP_TOKENS = 41_224

/**
 * Gap after which two calls of the same task in the same session are treated as
 * separate runs. The busiest schedule fires every 15-30 minutes, and a single
 * run's calls are seconds apart, so anything in between separates runs cleanly.
 */
export const RUN_GAP_SECONDS = 10 * 60

export interface UsageRow {
  task_title: string
  session_id: string
  model: string | null
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

/**
 * Split one task's rows into runs on a time gap.
 *
 * Rows must be ordered by timestamp. Grouping by clock hour instead would merge
 * a quarter-hourly heartbeat's separate firings into one "run" and understate
 * the run count by up to 4x, which would flow into every per-run figure.
 */
export function splitRuns(rows: UsageRow[], gapSeconds = RUN_GAP_SECONDS): UsageRow[][] {
  const runs: UsageRow[][] = []
  let current: UsageRow[] = []
  let last: number | null = null
  for (const r of rows) {
    if (last !== null && r.timestamp - last > gapSeconds) {
      runs.push(current)
      current = []
    }
    current.push(r)
    last = r.timestamp
  }
  if (current.length) runs.push(current)
  return runs
}

export interface RunCost {
  /** Paid to re-read context the host session already carried. */
  inherited: number
  /** The task's own tokens: its reasoning, its tool results, its output. */
  own: number
  total: number
  calls: number
}

/**
 * Split one run's cost into inherited context and own work.
 *
 * The run's first call's cache_read is the context that already existed when
 * the task started -- the task did not create it and would not pay for it in a
 * fresh session. Every later call re-reads that same baseline plus whatever the
 * task itself added, so the baseline is charged to `inherited` and the excess
 * to `own`.
 *
 * Returns null when the run's model has no published rate: a run we cannot
 * price is left out of the totals rather than counted as zero.
 */
export function decomposeRun(run: UsageRow[]): RunCost | null {
  if (!run.length) return null
  const model = run[0].model
  if (!isPriced(model)) return null
  const { input, output } = PRICE_MAP[model as string]
  const baseline = run[0].cache_read_tokens

  let inherited = 0
  let own = 0
  for (const r of run) {
    const inheritedTokens = Math.min(r.cache_read_tokens, baseline)
    const ownCacheTokens = Math.max(0, r.cache_read_tokens - baseline)
    inherited += (inheritedTokens * input * CACHE_READ_MULTIPLIER) / 1e6
    own +=
      (ownCacheTokens * input * CACHE_READ_MULTIPLIER) / 1e6 +
      (r.cache_creation_tokens * input * CACHE_WRITE_MULTIPLIER) / 1e6 +
      (r.input_tokens * input) / 1e6 +
      (r.output_tokens * output) / 1e6
  }
  return { inherited, own, total: inherited + own, calls: run.length }
}

/**
 * What the same run would cost started fresh.
 *
 * A fresh session is NOT free, and pretending otherwise would overstate every
 * saving in this report. It writes its own preamble into cache once (at the
 * 1.25x write multiplier) and re-reads it on every later call (at 0.1x). Only
 * the inherited host context disappears; the task's own work is unchanged.
 */
export function freshSessionCost(
  run: RunCost,
  model: string,
  startupTokens = SESSION_STARTUP_TOKENS,
): number {
  const { input } = PRICE_MAP[model]
  const write = (startupTokens * input * CACHE_WRITE_MULTIPLIER) / 1e6
  const reads = (Math.max(0, run.calls - 1) * startupTokens * input * CACHE_READ_MULTIPLIER) / 1e6
  return write + reads + run.own
}

export interface TaskAttribution {
  task: string
  runs: number
  calls: number
  inherited_cost: number
  own_cost: number
  total_cost: number
  fresh_session_cost: number
  saving: number
  saving_pct: number
  /** Median cost of one run, the figure a per-run ceiling would use. */
  median_run_cost: number
  /** Cheapest and dearest run of the SAME task -- the variance this all rests on. */
  min_run_cost: number
  max_run_cost: number
}

export interface ComplexitySignal {
  /**
   * Why a complexity heuristic built on observed cost cannot work here.
   * Both figures are computed from the data rather than asserted, so the
   * report carries its own evidence.
   */
  within_task_ratio_median: number
  between_task_ratio: number
  verdict: string
}

export interface ContextAttributionReport {
  basis: 'list_price_equivalent'
  currency: 'USD'
  startup_tokens: number
  assumption: string
  tasks: TaskAttribution[]
  totals: { inherited_cost: number; own_cost: number; total_cost: number; fresh_session_cost: number; saving: number }
  complexity_signal: ComplexitySignal
  unpriced_runs: number
}

const ASSUMPTION =
  'Assumes a scheduled task does not need the host session\'s conversation history -- it reads state from the database, the API or disk. That holds for the heartbeats and report builders measured here; it does NOT hold for interactive work, which is excluded. Savings are an upper bound: a fresh session also loses any warm knowledge the host had, and a task that turns out to need it would pay to rebuild it.'

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Decompose every labelled scheduled task in a window.
 *
 * `tasks` restricts the analysis to marker-labelled schedule names. That filter
 * is not optional: token_usage.task_title also carries kanban card titles
 * written by correlateWithKanban(), which are a time-window guess rather than a
 * statement of what the run was doing. Mixing the two would put unreliable
 * attribution into a cost figure.
 */
export function getContextAttribution(
  db: Database.Database,
  opts: { start: number; end: number; tasks: string[]; startupTokens?: number },
): ContextAttributionReport {
  const startupTokens = opts.startupTokens ?? SESSION_STARTUP_TOKENS
  const placeholders = opts.tasks.map(() => '?').join(',')
  const rows = (opts.tasks.length
    ? db.prepare(`
        SELECT task_title, session_id, model, timestamp, input_tokens, output_tokens,
               cache_read_tokens, cache_creation_tokens
        FROM token_usage
        WHERE timestamp >= ? AND timestamp < ? AND task_title IN (${placeholders})
        ORDER BY task_title, session_id, timestamp
      `).all(opts.start, opts.end, ...opts.tasks)
    : []) as UsageRow[]

  // Nested rather than one joined string key: any separator that can occur in a
  // task name or a session id would silently merge two groups into one run.
  const byTask = new Map<string, Map<string, UsageRow[]>>()
  for (const r of rows) {
    let sessions = byTask.get(r.task_title)
    if (!sessions) { sessions = new Map(); byTask.set(r.task_title, sessions) }
    const list = sessions.get(r.session_id)
    if (list) list.push(r)
    else sessions.set(r.session_id, [r])
  }

  const perTask = new Map<string, { costs: number[]; inherited: number; own: number; fresh: number; calls: number }>()
  let unpricedRuns = 0

  for (const [task, sessions] of byTask) {
    for (const list of sessions.values()) {
      for (const run of splitRuns(list)) {
      const cost = decomposeRun(run)
      if (!cost) { unpricedRuns++; continue }
      const fresh = freshSessionCost(cost, run[0].model as string, startupTokens)
      const agg = perTask.get(task) ?? { costs: [], inherited: 0, own: 0, fresh: 0, calls: 0 }
      agg.costs.push(cost.total)
      agg.inherited += cost.inherited
      agg.own += cost.own
      agg.fresh += fresh
      agg.calls += cost.calls
      perTask.set(task, agg)
    }
    }
  }

  const tasks: TaskAttribution[] = [...perTask.entries()]
    .map(([task, a]) => {
      const total = a.inherited + a.own
      return {
        task,
        runs: a.costs.length,
        calls: a.calls,
        inherited_cost: round4(a.inherited),
        own_cost: round4(a.own),
        total_cost: round4(total),
        fresh_session_cost: round4(a.fresh),
        saving: round4(total - a.fresh),
        saving_pct: total > 0 ? round4((total - a.fresh) / total) : 0,
        median_run_cost: round4(median(a.costs)),
        min_run_cost: round4(Math.min(...a.costs)),
        max_run_cost: round4(Math.max(...a.costs)),
      }
    })
    .sort((x, y) => y.total_cost - x.total_cost)

  // The complexity signal, computed rather than claimed: how much one task's
  // runs vary against how much the tasks vary from each other. Only tasks with
  // enough runs to have a spread at all are counted.
  const withRuns = [...perTask.values()].filter(a => a.costs.length >= 4)
  const withinRatios = withRuns.map(a => {
    const s = [...a.costs].sort((p, q) => p - q)
    return s[s.length - 1] / Math.max(s[0], 1e-6)
  })
  const medians = withRuns.map(a => median(a.costs)).filter(m => m > 0)
  const between = medians.length ? Math.max(...medians) / Math.min(...medians) : 0
  const within = median(withinRatios)

  const totals = tasks.reduce(
    (acc, t) => ({
      inherited_cost: acc.inherited_cost + t.inherited_cost,
      own_cost: acc.own_cost + t.own_cost,
      total_cost: acc.total_cost + t.total_cost,
      fresh_session_cost: acc.fresh_session_cost + t.fresh_session_cost,
      saving: acc.saving + t.saving,
    }),
    { inherited_cost: 0, own_cost: 0, total_cost: 0, fresh_session_cost: 0, saving: 0 },
  )

  return {
    basis: 'list_price_equivalent',
    currency: 'USD',
    startup_tokens: startupTokens,
    assumption: ASSUMPTION,
    tasks,
    totals: {
      inherited_cost: round4(totals.inherited_cost),
      own_cost: round4(totals.own_cost),
      total_cost: round4(totals.total_cost),
      fresh_session_cost: round4(totals.fresh_session_cost),
      saving: round4(totals.saving),
    },
    complexity_signal: {
      within_task_ratio_median: round4(within),
      between_task_ratio: round4(between),
      verdict: within > between
        ? 'A cost-based complexity heuristic cannot discriminate here: the same task varies more between its own runs than the tasks vary from each other, so observed cost measures the host session rather than the task.'
        : 'Tasks differ from each other more than each varies internally; a cost-based complexity signal may be usable.',
    },
    unpriced_runs: unpricedRuns,
  }
}

function round4(n: number): number { return Math.round(n * 10000) / 10000 }
