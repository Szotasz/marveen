// CostOps -- the reproducible half of a shadow review.
//
// The evaluation itself lives in shadow-eval.ts. This module holds the parts
// that decide WHAT gets evaluated: which transcript, over which window, and
// whether the inputs were even settled enough to be worth measuring.
//
// It exists because the first review (2026-08-01) was assembled ad hoc, and two
// of its three findings were about the measurement rather than the worker. When
// the next round is the input to a real routing decision, the method has to be
// the fixed variable -- so every boundary is a named function with a test, and
// the CLI prints the boundaries next to the numbers.
//
// Pure arithmetic and small decisions. File and DB access stay in the caller.

import type Database from 'better-sqlite3'
import { priceTokens, type TokenCostComponents, ZERO_COMPONENTS } from './pricing.js'

/**
 * How long a transcript must sit unchanged before a verdict means anything.
 *
 * The first review fired while the worker was mid-run and read "sent nothing".
 * 30 s is comfortably longer than the gap between two tool calls in a run like
 * this (observed: 3-10 s) and short enough that a review right after the task
 * does not wait on it.
 */
export const SETTLE_THRESHOLD_MS = 30_000

/** Default lookback of the report under test (reggeli-teteles-lista: ~10 hours). */
export const DEFAULT_WINDOW_HOURS = 10

export interface TranscriptCandidate {
  path: string
  mtimeMs: number
}

/**
 * The transcript to measure: the most recently written one.
 *
 * A worker directory accumulates sessions, and the one that just ran is the one
 * that was written last. Returns null rather than guessing when there is none.
 */
export function pickTranscript(candidates: TranscriptCandidate[]): TranscriptCandidate | null {
  if (candidates.length === 0) return null
  return [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
}

export interface SettleState {
  settled: boolean
  settledForMs: number
  thresholdMs: number
}

/** Has the transcript stopped growing long enough to judge the run? */
export function transcriptSettle(mtimeMs: number, nowMs: number, thresholdMs = SETTLE_THRESHOLD_MS): SettleState {
  const settledForMs = Math.max(0, nowMs - mtimeMs)
  return { settled: settledForMs >= thresholdMs, settledForMs, thresholdMs }
}

export interface RunWindow {
  start: number
  end: number
  hours: number
  /** Where `end` came from -- printed, because it changes what is being asked. */
  endSource: 'run_start' | 'file_mtime'
}

/**
 * The window the report was answerable for.
 *
 * It ends when the worker STARTED, not when it finished writing. The worker
 * queries the board in its first seconds; a card created after that could not
 * have been in the report, and holding it against the run measures the clock
 * instead of the worker. Seen for real: a review run 20 minutes late pulled in
 * a card the orchestrator had created in the meantime and counted it as missed.
 *
 * Falls back to the file mtime only when the transcript carries no usable
 * timestamp -- and says so, because then the window really is approximate.
 */
export function runWindow(runStartMs: number | null, mtimeMs: number, hours = DEFAULT_WINDOW_HOURS): RunWindow {
  const endMs = runStartMs ?? mtimeMs
  const end = Math.floor(endMs / 1000)
  return { start: end - hours * 3600, end, hours, endSource: runStartMs ? 'run_start' : 'file_mtime' }
}

/**
 * A worker session outlives its runs, so a gap this long means a new run.
 *
 * The tmux session is created once and the scheduler injects a prompt into it
 * each morning; the transcript therefore holds every run back to whenever the
 * session was started. Taking its FIRST timestamp as "the run began" put the
 * window a full day early on the first attempt and scored the worker 1/12
 * against cards it was never asked about. Runs of this task last minutes and
 * recur daily, so any gap over an hour is unambiguously a boundary.
 */
export const RUN_GAP_MS = 60 * 60_000

/** Every parseable ISO `timestamp` in a transcript, in epoch ms, in order. */
export function transcriptTimestamps(transcriptLines: string[]): number[] {
  const out: number[] = []
  for (const line of transcriptLines) {
    let obj: unknown
    try { obj = JSON.parse(line) } catch { continue }
    const ts = (obj as { timestamp?: unknown })?.timestamp
    if (typeof ts !== 'string') continue
    const ms = Date.parse(ts)
    if (!Number.isNaN(ms)) out.push(ms)
  }
  return out
}

/**
 * When the MOST RECENT run in this transcript began: the first timestamp after
 * the last long gap. Null when the transcript carries no timestamps at all.
 */
export function lastRunStartMs(transcriptLines: string[], gapMs = RUN_GAP_MS): number | null {
  const ts = transcriptTimestamps(transcriptLines)
  if (ts.length === 0) return null
  for (let i = ts.length - 1; i > 0; i--) {
    if (ts[i] - ts[i - 1] > gapMs) return ts[i]
  }
  return ts[0]
}

export type CollectorState = 'current' | 'behind' | 'unseen'

/**
 * Whether the token collector has caught up with this transcript.
 *
 * It polls hourly, so a review run soon after the task sees a file the
 * collector has not read yet -- and the cost half is then simply absent. That
 * absence must be reported as "not collected yet", never as "cost was zero":
 * the first review hit exactly this and the difference is the whole point.
 */
export function collectorState(cursorSize: number | null, fileSize: number): CollectorState {
  if (cursorSize === null) return 'unseen'
  return cursorSize >= fileSize ? 'current' : 'behind'
}

export interface UsageRow {
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  model: string | null
}

export interface RunCost {
  calls: number
  models: string[]
  /**
   * What the session carried on its FIRST call (cache read + cache write).
   * For a fresh worker session this is its own persona/skill baseline, not
   * inherited conversation -- which is the claim the eco-worker move rests on.
   */
  entry_context_tokens: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  list_price_equivalent_usd: number
  components: TokenCostComponents
  /** The same token volume priced at another model, for a like-for-like ratio. */
  comparison: { model: string; usd: number; ratio: number | null } | null
  unpriced_calls: number
}

/**
 * Cost of one run, from usage rows already scoped to it.
 *
 * `comparisonModel` answers "what would this exact volume have cost on the
 * expensive model" -- the model-swap effect alone. It deliberately does NOT
 * model the bigger context a main-session run would have carried: that is a
 * separate measurement, and mixing the two would report a guess as a saving.
 */
export function priceRun(rows: UsageRow[], comparisonModel?: string): RunCost {
  const components: TokenCostComponents = { ...ZERO_COMPONENTS }
  let total = 0
  let comparisonTotal = 0
  let unpriced = 0
  const models = new Set<string>()

  const ordered = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  for (const r of ordered) {
    if (r.model) models.add(r.model)
    const priced = priceTokens(r.model, r)
    if (!priced) { unpriced++; continue }
    components.input += priced.input
    components.output += priced.output
    components.cache_read += priced.cache_read
    components.cache_write += priced.cache_write
    total += priced.total
    if (comparisonModel) comparisonTotal += priceTokens(comparisonModel, r)?.total ?? 0
  }

  const first = ordered[0]
  const sum = (pick: (r: UsageRow) => number) => ordered.reduce((a, r) => a + pick(r), 0)
  return {
    calls: ordered.length,
    models: [...models].sort(),
    entry_context_tokens: first ? first.cache_read_tokens + first.cache_creation_tokens : null,
    input_tokens: sum(r => r.input_tokens),
    output_tokens: sum(r => r.output_tokens),
    cache_read_tokens: sum(r => r.cache_read_tokens),
    cache_creation_tokens: sum(r => r.cache_creation_tokens),
    list_price_equivalent_usd: round4(total),
    components: {
      input: round4(components.input),
      output: round4(components.output),
      cache_read: round4(components.cache_read),
      cache_write: round4(components.cache_write),
      total: round4(total),
    },
    comparison: comparisonModel
      ? { model: comparisonModel, usd: round4(comparisonTotal), ratio: total > 0 ? round2(comparisonTotal / total) : null }
      : null,
    unpriced_calls: unpriced,
  }
}

/** Usage rows for one agent inside a time span, oldest first. */
export function runUsageRows(db: Database.Database, agent: string, start: number, end: number): UsageRow[] {
  return db.prepare(`
    SELECT timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model
    FROM token_usage
    WHERE agent = ? AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp
  `).all(agent, start, end) as UsageRow[]
}

/** Average context carried per call by another agent, for scale. */
export function averageContextPerCall(db: Database.Database, agent: string, start: number, end: number): { calls: number; avg_cache_read: number } | null {
  const row = db.prepare(`
    SELECT COUNT(*) AS calls, AVG(cache_read_tokens) AS avg_cache_read
    FROM token_usage WHERE agent = ? AND timestamp >= ? AND timestamp < ?
  `).get(agent, start, end) as { calls: number; avg_cache_read: number | null }
  if (!row || row.calls === 0) return null
  return { calls: row.calls, avg_cache_read: Math.round(row.avg_cache_read ?? 0) }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000
const round2 = (n: number) => Math.round(n * 100) / 100
