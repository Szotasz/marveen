// CostOps Phase 1 (GAP-06) -- per-source reconciliation view.
//
// Formalizes the "is this number believable" check the gap-analysis calls
// for: per source, what did the provider API say, what did the invoice say,
// what did we forecast, and what did the ledger actually select as the
// operational headline -- with an explicit variance and status, instead of
// only the existing summary-level reconciliation-delta-0 guarantee (which
// proves internal consistency, not cross-source-of-truth agreement).
//
// Read-only, additive: does not change getCostSummary's contract or write
// anything. Reuses the same CONF_PRIORITY resolution as ledger.ts so
// "operationally selected" here always matches what the dashboard actually
// shows for that source.

import type Database from 'better-sqlite3'
import { monthWindow, CONF_PRIORITY } from './ledger.js'

export type ReconciliationStatus =
  | 'matched'
  | 'variance'
  | 'missing_invoice'
  | 'missing_provider_data'
  | 'estimate_only'
  | 'no_data'

export interface SourceReconciliation {
  source_id: string
  name: string
  provider: string
  month: string
  expected_amount: number | null
  observed_provider_amount: number | null
  invoice_amount: number | null
  operationally_selected_amount: number | null
  variance: number | null
  variance_reason: string | null
  status: ReconciliationStatus
}

// Relative variance tolerance below which two numbers are considered
// "matched" rather than a genuine discrepancy worth flagging -- not
// business-specified (same flagged-placeholder convention as warnings.ts's
// MATERIAL_FRACTION/LARGE_INCREASE_FRACTION), tune once real invoice-vs-
// provider-API data accumulates.
const VARIANCE_TOLERANCE_FRACTION = 0.02

interface SourceRow { id: string; name: string; provider: string }
interface LineRow { source_id: string; billed_cost: number; confidence: string; actual_source: string | null }

function round2(n: number): number { return Math.round(n * 100) / 100 }

function isWithinTolerance(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) / base <= VARIANCE_TOLERANCE_FRACTION
}

/**
 * Build the reconciliation view for every active source, for `month`
 * (defaults to the month containing `now`). Pure DB read, no writes.
 */
export function buildReconciliation(db: Database.Database, now: number, month?: string): SourceReconciliation[] {
  const win = monthWindow(now, month)
  const sources = db.prepare(`SELECT id, name, provider FROM cost_sources WHERE active = 1`).all() as SourceRow[]
  const lines = db.prepare(`
    SELECT source_id, billed_cost, confidence, actual_source
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start AND voided_at IS NULL
  `).all({ start: win.start, end: win.end }) as LineRow[]

  const bySource = new Map<string, LineRow[]>()
  for (const l of lines) { const a = bySource.get(l.source_id); if (a) a.push(l); else bySource.set(l.source_id, [l]) }

  const latestForecast = db.prepare(`
    SELECT forecast_amount FROM forecast_snapshots
    WHERE source_id = ? AND month = ? ORDER BY snapshot_at DESC LIMIT 1
  `)

  return sources.map((s): SourceReconciliation => {
    const ls = bySource.get(s.id) ?? []
    if (ls.length === 0) {
      return {
        source_id: s.id, name: s.name, provider: s.provider, month: win.key,
        expected_amount: null, observed_provider_amount: null, invoice_amount: null,
        operationally_selected_amount: null, variance: null, variance_reason: null,
        status: 'no_data',
      }
    }

    const providerLines = ls.filter(l => l.actual_source === 'provider_api')
    const invoiceLines = ls.filter(l => l.actual_source === 'email_invoice')
    const observed_provider_amount = providerLines.length > 0 ? round2(providerLines.reduce((sum, l) => sum + l.billed_cost, 0)) : null
    const invoice_amount = invoiceLines.length > 0 ? round2(invoiceLines.reduce((sum, l) => sum + l.billed_cost, 0)) : null

    const resolved = ls.reduce((a, b) => (CONF_PRIORITY[b.confidence] || 0) > (CONF_PRIORITY[a.confidence] || 0) ? b : a)
    const operationally_selected_amount = round2(resolved.billed_cost)

    const forecastRow = latestForecast.get(s.id, win.key) as { forecast_amount: number } | undefined
    const expected_amount = forecastRow ? round2(forecastRow.forecast_amount) : null

    let variance: number | null = null
    let variance_reason: string | null = null
    if (observed_provider_amount != null && invoice_amount != null) {
      variance = round2(invoice_amount - observed_provider_amount)
      variance_reason = 'invoice vs provider API'
    } else if (expected_amount != null && operationally_selected_amount != null) {
      variance = round2(operationally_selected_amount - expected_amount)
      variance_reason = 'actual vs forecast'
    }

    let status: ReconciliationStatus
    if (observed_provider_amount != null && invoice_amount == null) {
      status = 'missing_invoice'
    } else if (invoice_amount != null && observed_provider_amount == null) {
      status = 'missing_provider_data'
    } else if (observed_provider_amount == null && invoice_amount == null) {
      status = 'estimate_only'
    } else if (variance != null && !isWithinTolerance(invoice_amount!, observed_provider_amount!)) {
      status = 'variance'
    } else {
      status = 'matched'
    }

    return {
      source_id: s.id, name: s.name, provider: s.provider, month: win.key,
      expected_amount, observed_provider_amount, invoice_amount, operationally_selected_amount,
      variance, variance_reason, status,
    }
  })
}
