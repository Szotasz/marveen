// CostOps v0.7 -- period view / monthly close.
//
// Current + previous + last-N-months operational-spend trend, per provider.
// READ-ONLY: unlike getCostSummary (which syncs the CURRENT month's fixed
// costs into the ledger before reading), this module never writes. A past
// month with zero cost_line_items rows is reported as no_data:true, NEVER a
// fabricated 0 -- e.g. a subscription that started in June 2026 legitimately
// has no_data for every month before June, even though it recurs today.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import { monthWindow, resolveOperational, PENDING_CONF, type MonthWindow, type OperationalResult } from './ledger.js'

export interface MonthlyPeriod {
  month: string
  no_data: boolean
  operational_spend: number
  operational_forecast_month_end: number
  provider_breakdown: OperationalResult['provider_breakdown']
}

interface LineRow {
  source_id: string
  billed_cost: number
  charge_category: string
  confidence: string
  data_freshness: number
}

function readMonth(db: Database.Database, win: MonthWindow, providerBySource: Map<string, string>): MonthlyPeriod {
  const rows = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence, data_freshness
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start AND voided_at IS NULL
  `).all({ start: win.start, end: win.end }) as LineRow[]

  if (rows.length === 0) {
    return { month: win.key, no_data: true, operational_spend: 0, operational_forecast_month_end: 0, provider_breakdown: [] }
  }
  const op = resolveOperational(
    rows.filter(l => !PENDING_CONF.has(l.confidence)).map(l => ({
      source_id: l.source_id, provider: providerBySource.get(l.source_id) || 'other',
      billed_cost: l.billed_cost, charge_category: l.charge_category, confidence: l.confidence, data_freshness: l.data_freshness,
    })),
    win,
  )
  return {
    month: win.key,
    no_data: false,
    operational_spend: op.operational_spend,
    operational_forecast_month_end: op.operational_forecast_month_end,
    provider_breakdown: op.provider_breakdown,
  }
}

export interface PeriodTrend {
  months: MonthlyPeriod[]  // oldest first
  current: MonthlyPeriod
  previous: MonthlyPeriod
  month_over_month_delta: number | null  // null if either side is no_data
}

/**
 * Last `monthsBack` months (inclusive of the current month), oldest first.
 * Pass the same `now`/`monthKey` semantics as getCostSummary's window anchor.
 */
export function getPeriodTrend(
  db: Database.Database,
  _config: CostOpsConfig,
  now: number,
  monthsBack = 6,
  monthKey?: string,
): PeriodTrend {
  const anchor = monthWindow(now, monthKey)
  const srcRows = db.prepare(`SELECT id, provider FROM cost_sources`).all() as Array<{ id: string; provider: string }>
  const providerBySource = new Map(srcRows.map(r => [r.id, r.provider]))

  const windows: MonthWindow[] = [anchor]
  for (let i = 1; i < monthsBack; i++) {
    windows.push(monthWindow(windows[windows.length - 1].start - 86400))
  }
  windows.reverse() // oldest first

  const months = windows.map(w => readMonth(db, w, providerBySource))
  const current = months[months.length - 1]
  const previous = months.length >= 2 ? months[months.length - 2] : readMonth(db, monthWindow(anchor.start - 86400), providerBySource)
  const month_over_month_delta = (!current.no_data && !previous.no_data)
    ? Math.round((current.operational_spend - previous.operational_spend) * 100) / 100
    : null

  return { months, current, previous, month_over_month_delta }
}
