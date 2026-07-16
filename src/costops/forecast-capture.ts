// CostOps Phase 1 -- forecast-snapshot capture (GAP-10 orchestration layer).
//
// Anvil's forecast.ts (buildfejleszto-costops-forecast) is pure computation
// only, by design -- no DB reads. This module is the thin orchestration on
// top: gather each active source's current-month signals from the DB, call
// resolveSourceForecast() per source, and persist one snapshot row per source
// (+ one whole-deployment TOTAL row) via forecast_snapshots. Wired into the
// boot seam (startCostOpsBackgroundTasks) for the daily capture cadence.

import type Database from 'better-sqlite3'
import { monthWindow, CONF_PRIORITY, type MonthWindow } from './ledger.js'
import { resolveSourceForecast, forecastSnapshotDedupKey, type ForecastResult, type ForecastContext } from './forecast.js'
import type { BalanceSnapshot } from './collectors/deepseek.js'

interface SourceRow {
  id: string
  provider: string
}

interface LineRow {
  source_id: string
  billed_cost: number
  charge_category: string
  confidence: string
}

function resolveBestLinePerSource(db: Database.Database, win: MonthWindow): Map<string, LineRow> {
  const lines = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start
      AND voided_at IS NULL AND confidence NOT IN ('pending_permission', 'provider_plan_estimate')
  `).all({ start: win.start, end: win.end }) as LineRow[]
  const bySource = new Map<string, LineRow[]>()
  for (const l of lines) {
    const arr = bySource.get(l.source_id); if (arr) arr.push(l); else bySource.set(l.source_id, [l])
  }
  const resolved = new Map<string, LineRow>()
  for (const [sid, ls] of bySource) {
    resolved.set(sid, ls.reduce((a, b) => (CONF_PRIORITY[b.confidence] || 0) > (CONF_PRIORITY[a.confidence] || 0) ? b : a))
  }
  return resolved
}

function balanceSnapshotsForProvider(db: Database.Database, provider: string): BalanceSnapshot[] {
  return db.prepare(`
    SELECT balance, captured_at FROM provider_balance_snapshots
    WHERE provider = ? ORDER BY captured_at ASC
  `).all(provider) as BalanceSnapshot[]
}

interface StoredForecast {
  source_id: string | null
  result: ForecastResult
}

function insertSnapshot(db: Database.Database, opts: { sourceId: string | null; month: string; now: number; result: ForecastResult }): void {
  const dedup = forecastSnapshotDedupKey(opts.sourceId, opts.month, opts.now)
  db.prepare(`
    INSERT OR IGNORE INTO forecast_snapshots
      (source_id, month, snapshot_at, method, forecast_amount, confidence, note, dedup_key, created_at)
    VALUES (@source_id, @month, @now, @method, @amount, @confidence, @note, @dedup, @now)
  `).run({
    source_id: opts.sourceId, month: opts.month, now: opts.now,
    method: opts.result.method, amount: opts.result.amount, confidence: opts.result.confidence,
    note: opts.result.note, dedup: dedup,
  })
}

/**
 * Capture one forecast snapshot per active source for the current month,
 * plus one whole-deployment TOTAL snapshot (source_id null, per
 * forecast.ts's documented convention). Idempotent per calendar day (dedup_key
 * includes the day) -- a second capture the same day is a no-op, matching
 * "every historical forecast stays reproducible, never silently rewritten."
 *
 * Signal availability today: cadence/last_invoice_amount/manual_override are
 * not yet threaded from costops-subscriptions.json, so resolveSourceForecast
 * falls through to its usage/fixed-subscription defaults for those sources --
 * honest given the data actually on hand, not a fabricated cadence guess.
 * Wiring subscriptions-derived cadence is a natural Phase 1 follow-up, not
 * done here to keep this capture pass additive and independently testable.
 */
export function captureForecastSnapshots(db: Database.Database, now: number): StoredForecast[] {
  const win = monthWindow(now)
  const sources = db.prepare(`SELECT id, provider FROM cost_sources WHERE active = 1`).all() as SourceRow[]
  const bestLine = resolveBestLinePerSource(db, win)
  const results: StoredForecast[] = []
  let total = 0

  for (const s of sources) {
    const line = bestLine.get(s.id)
    const mtd_amount = line?.billed_cost ?? 0
    const ctx: ForecastContext = {
      mtd_amount,
      win,
      now,
      data_confidence: (line?.confidence as ForecastContext['data_confidence']) ?? 'manual',
      charge_category: line?.charge_category,
      balance_snapshots: (() => {
        const snaps = balanceSnapshotsForProvider(db, s.provider)
        return snaps.length > 0 ? snaps : undefined
      })(),
    }
    const result = resolveSourceForecast(ctx)
    insertSnapshot(db, { sourceId: s.id, month: win.key, now, result })
    results.push({ source_id: s.id, result })
    total += result.amount
  }

  const totalResult: ForecastResult = {
    method: 'fixed_subscription',
    amount: Math.round(total * 100) / 100,
    confidence: results.length > 0 ? 'medium' : 'low',
    note: `whole-deployment total -- sum of ${results.length} per-source forecasts`,
  }
  insertSnapshot(db, { sourceId: null, month: win.key, now, result: totalResult })
  results.push({ source_id: null, result: totalResult })

  return results
}

export interface ForecastSnapshotRow {
  source_id: string | null
  month: string
  snapshot_at: number
  method: string
  forecast_amount: number
  confidence: string
  note: string | null
  actual_amount: number | null
  forecast_error_absolute: number | null
  forecast_error_percent: number | null
}

/** Read back stored forecast snapshots, most recent first, optionally filtered to one month. */
export function listForecastSnapshots(db: Database.Database, opts: { month?: string; limit?: number } = {}): ForecastSnapshotRow[] {
  const limit = opts.limit ?? 200
  if (opts.month) {
    return db.prepare(`
      SELECT source_id, month, snapshot_at, method, forecast_amount, confidence, note,
        actual_amount, forecast_error_absolute, forecast_error_percent
      FROM forecast_snapshots WHERE month = ? ORDER BY snapshot_at DESC LIMIT ?
    `).all(opts.month, limit) as ForecastSnapshotRow[]
  }
  return db.prepare(`
    SELECT source_id, month, snapshot_at, method, forecast_amount, confidence, note,
      actual_amount, forecast_error_absolute, forecast_error_percent
    FROM forecast_snapshots ORDER BY snapshot_at DESC LIMIT ?
  `).all(limit) as ForecastSnapshotRow[]
}
