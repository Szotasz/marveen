// CostOps v0.7 -- sanitized export (CSV/JSON).
// CostOps Phase 1 (GAP-18 / core-functional-scope-v1.0.1.md §19) -- normalized
// export set: ledger CSV/JSON (v0.7, above), source inventory, provider
// summary, category summary, budget variance, reconciliation report,
// forecast history, data-quality report, and a monthly snapshot bundling
// them. Every export below REUSES the exact function the dashboard/summary
// route itself calls (getCostSummary, buildReconciliation,
// buildSourceInventory, listForecastSnapshots) -- never a second, parallel
// computation -- so "export totals match dashboard totals" holds by
// construction, not by a separate reconciliation check. Every export carries
// `meta.schema_version`/`meta.generated_at`; none contains a secret or a raw
// account reference (the underlying modules already exclude those).
//
// NOT included: optimization recommendations (GAP-17) -- that engine does
// not exist yet in this codebase (Phase 4, not built); no export function
// fabricates one. Alerts export (GAP-12) IS included below (exportAlerts) --
// alerts-capture.ts landed on this branch, reusing alerts-store.ts's
// listAlerts() (the same read path GET /api/costs/alerts uses).

import type Database from 'better-sqlite3'
import { monthWindow, CONF_PRIORITY, getCostSummary, type CostSummary } from './ledger.js'
import type { CostOpsConfig } from './config.js'
import { buildSourceInventory, type SourceInventoryEntry, type CredentialChecker, type Freshness } from './inventory.js'
import { buildReconciliation, type SourceReconciliation } from './reconciliation.js'
import { listForecastSnapshots, type ForecastSnapshotRow } from './forecast-capture.js'
import { getPeriodStatus, type PeriodCloseStatus } from './period-close.js'
import { listAlerts } from './alerts-store.js'
import type { AlertRecord } from './alerts.js'
import { resolveBudgetStatus, type BudgetStatus } from './budgets.js'

export interface ExportRow {
  provider: string
  source_type: string
  service_name: string | null
  period: string
  amount: number
  currency: string
  confidence: string
  // Currency-retention (v0.7, additive): populated only when this line was
  // converted from a foreign-currency invoice ("if any" per spec) -- never
  // fabricated for an already-HUF line.
  original_amount: number | null
  original_currency: string | null
}

interface Row {
  provider: string
  source_type: string
  service_name: string | null
  charge_period_start: number
  billed_cost: number
  currency: string
  confidence: string
  original_amount: number | null
  original_currency: string | null
}

/**
 * Sanitized cost-line export for a single month, or a [fromMonth, toMonth]
 * inclusive range. No fabrication: months with zero rows simply contribute no
 * rows (the caller can see that from an empty result, not a synthesized 0).
 */
export function exportCostRows(
  db: Database.Database,
  now: number,
  opts: { month?: string; fromMonth?: string; toMonth?: string },
): ExportRow[] {
  let start: number, end: number
  if (opts.fromMonth && opts.toMonth) {
    start = monthWindow(now, opts.fromMonth).start
    end = monthWindow(now, opts.toMonth).end
  } else {
    const w = monthWindow(now, opts.month)
    start = w.start
    end = w.end
  }
  const rows = db.prepare(`
    SELECT cs.provider as provider, cs.source_type as source_type, cli.service_name as service_name,
           cli.charge_period_start as charge_period_start, cli.billed_cost as billed_cost,
           cli.currency as currency, cli.confidence as confidence,
           cli.original_amount as original_amount, cli.original_currency as original_currency
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.charge_period_start < @end AND cli.charge_period_end > @start AND cli.voided_at IS NULL
    ORDER BY cli.charge_period_start ASC, cs.provider ASC
  `).all({ start, end }) as Row[]

  return rows.map(r => ({
    provider: r.provider,
    source_type: r.source_type,
    service_name: r.service_name,
    period: monthWindow(r.charge_period_start).key,
    amount: r.billed_cost,
    currency: r.currency,
    confidence: r.confidence,
    original_amount: r.original_amount ?? null,
    original_currency: r.original_currency ?? null,
  }))
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Generic CSV serializer -- header row + one row per object, in `headers` order. Reused by every *ToCsv export below (including `rowsToCsv`, kept byte-identical for the already-live GET /api/costs/export route). */
export function objectsToCsv<T extends Record<string, unknown>>(rows: T[], headers: string[]): string {
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h])).join(','))
  }
  return lines.join('\n') + '\n'
}

export function rowsToCsv(rows: ExportRow[]): string {
  const headers = ['provider', 'source_type', 'service_name', 'period', 'amount', 'currency', 'confidence', 'original_amount', 'original_currency']
  return objectsToCsv(rows as unknown as Record<string, unknown>[], headers)
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

// ---- export envelope (GAP-18: every export carries schema_version + generated_at) ---------

export interface ExportMeta {
  schema_version: number
  generated_at: number
  scope: string
  month?: string
  from_month?: string
  to_month?: string
}

const EXPORT_SCHEMA_VERSION = 1

function buildMeta(scope: string, now: number, opts: { month?: string; fromMonth?: string; toMonth?: string } = {}): ExportMeta {
  const meta: ExportMeta = { schema_version: EXPORT_SCHEMA_VERSION, generated_at: now, scope }
  if (opts.month) meta.month = opts.month
  if (opts.fromMonth) meta.from_month = opts.fromMonth
  if (opts.toMonth) meta.to_month = opts.toMonth
  return meta
}

// ---- 1. ledger (JSON/CSV with meta -- wraps the existing v0.7 exportCostRows/rowsToCsv) ----

export interface LedgerExport { meta: ExportMeta; rows: ExportRow[] }

export function exportLedgerJson(db: Database.Database, now: number, opts: { month?: string; fromMonth?: string; toMonth?: string } = {}): LedgerExport {
  return { meta: buildMeta('ledger', now, opts), rows: exportCostRows(db, now, opts) }
}

export function exportLedgerCsv(db: Database.Database, now: number, opts: { month?: string; fromMonth?: string; toMonth?: string } = {}): { meta: ExportMeta; csv: string } {
  return { meta: buildMeta('ledger', now, opts), csv: rowsToCsv(exportCostRows(db, now, opts)) }
}

// ---- 2. source inventory --------------------------------------------------------------------

export interface SourceInventoryExport { meta: ExportMeta; sources: SourceInventoryEntry[] }

/** Reuses inventory.ts's buildSourceInventory verbatim -- already excludes account_ref/secret. */
export function exportSourceInventory(db: Database.Database, config: CostOpsConfig, now: number, deps: { credentialChecker?: CredentialChecker } = {}): SourceInventoryExport {
  return { meta: buildMeta('source_inventory', now), sources: buildSourceInventory(db, config, now, deps) }
}

export function sourceInventoryToCsv(sources: SourceInventoryEntry[]): string {
  const headers = ['source_id', 'name', 'provider', 'source_type', 'lifecycle', 'provenance', 'collection_method', 'freshness', 'sync_cadence', 'owner', 'operational_inclusion_rule', 'manual_fallback', 'blocker']
  return objectsToCsv(sources as unknown as Record<string, unknown>[], headers)
}

// ---- 3. provider summary --------------------------------------------------------------------

export interface ProviderSummaryExport {
  meta: ExportMeta
  operational_spend: number
  provider_breakdown: CostSummary['operational']['provider_breakdown']
}

/** Reuses getCostSummary().operational.provider_breakdown -- the SAME provider aggregate the dashboard's operational KPI resolves, so this always matches it. */
export function exportProviderSummary(db: Database.Database, config: CostOpsConfig, now: number, opts: { month?: string } = {}): ProviderSummaryExport {
  const summary = getCostSummary(db, config, now, { monthKey: opts.month })
  return { meta: buildMeta('provider_summary', now, opts), operational_spend: summary.operational_spend, provider_breakdown: summary.operational.provider_breakdown }
}

export function providerSummaryToCsv(rows: CostSummary['operational']['provider_breakdown']): string {
  return objectsToCsv(rows as unknown as Record<string, unknown>[], ['provider', 'spend', 'confidence'])
}

// ---- 4. category summary (by cost_sources.source_type) --------------------------------------

export interface CategorySummaryRow { source_type: string; spend: number }
export interface CategorySummaryExport { meta: ExportMeta; categories: CategorySummaryRow[] }

interface CategoryLineRow { source_type: string; billed_cost: number; confidence: string; source_id: string }

/**
 * Groups the SAME confidence-resolved per-source line ledger.ts's own
 * headline resolution uses (best line per source by CONF_PRIORITY, excluding
 * pending/plan-estimate lines) by `cost_sources.source_type` -- a cost
 * CATEGORY in this codebase's vocabulary (subscription/hosting/domain/saas/
 * usage/manual), distinct from `charge_category` (usage/subscription/
 * purchase/tax/credit/adjustment).
 */
function resolveCategorySummary(db: Database.Database, win: ReturnType<typeof monthWindow>): CategorySummaryRow[] {
  const rows = db.prepare(`
    SELECT cs.source_type as source_type, cli.billed_cost as billed_cost, cli.confidence as confidence, cli.source_id as source_id
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.charge_period_start < @end AND cli.charge_period_end > @start AND cli.voided_at IS NULL
      AND cli.confidence NOT IN ('pending_permission', 'provider_plan_estimate')
  `).all({ start: win.start, end: win.end }) as CategoryLineRow[]
  const bySource = new Map<string, CategoryLineRow>()
  for (const r of rows) {
    const cur = bySource.get(r.source_id)
    if (!cur || (CONF_PRIORITY[r.confidence] || 0) > (CONF_PRIORITY[cur.confidence] || 0)) bySource.set(r.source_id, r)
  }
  const byCategory = new Map<string, number>()
  for (const r of bySource.values()) byCategory.set(r.source_type, round2((byCategory.get(r.source_type) || 0) + r.billed_cost))
  return [...byCategory.entries()].map(([source_type, spend]) => ({ source_type, spend })).sort((a, b) => b.spend - a.spend)
}

export function exportCategorySummary(db: Database.Database, now: number, opts: { month?: string } = {}): CategorySummaryExport {
  const win = monthWindow(now, opts.month)
  return { meta: buildMeta('category_summary', now, opts), categories: resolveCategorySummary(db, win) }
}

export function categorySummaryToCsv(rows: CategorySummaryRow[]): string {
  return objectsToCsv(rows as unknown as Record<string, unknown>[], ['source_type', 'spend'])
}

// ---- 5. budget variance ----------------------------------------------------------------------

export interface BudgetVarianceExport {
  meta: ExportMeta
  // Legacy single global-budget shape (v0.4-era, kept for back-compat).
  budget: (NonNullable<CostSummary['budget']> & { spend_variance: number; forecast_variance: number }) | null
  // Phase 3 (GAP-11): every configured budget -- global, provider, category,
  // source -- each with its own current_spend/forecast/variance/status.
  budgets: BudgetStatus[]
}

export function exportBudgetVariance(db: Database.Database, config: CostOpsConfig, now: number, opts: { month?: string } = {}): BudgetVarianceExport {
  const summary = getCostSummary(db, config, now, { monthKey: opts.month })
  const b = summary.budget
  const budget = b ? {
    ...b,
    spend_variance: round2(summary.operational_spend - b.amount),
    forecast_variance: round2(summary.operational_forecast_month_end - b.amount),
  } : null
  const budgets = config.budgets.map(entry => resolveBudgetStatus(entry, summary))
  return { meta: buildMeta('budget_variance', now, opts), budget, budgets }
}

// ---- 6. reconciliation report ------------------------------------------------------------------

export interface ReconciliationReportExport { meta: ExportMeta; sources: SourceReconciliation[] }

export function exportReconciliationReport(db: Database.Database, now: number, month?: string): ReconciliationReportExport {
  return { meta: buildMeta('reconciliation_report', now, month ? { month } : {}), sources: buildReconciliation(db, now, month) }
}

export function reconciliationReportToCsv(rows: SourceReconciliation[]): string {
  const headers = ['source_id', 'name', 'provider', 'month', 'expected_amount', 'observed_provider_amount', 'invoice_amount', 'operationally_selected_amount', 'variance', 'variance_reason', 'status']
  return objectsToCsv(rows as unknown as Record<string, unknown>[], headers)
}

// ---- 7. forecast history --------------------------------------------------------------------

export interface ForecastHistoryExport { meta: ExportMeta; snapshots: ForecastSnapshotRow[] }

export function exportForecastHistory(db: Database.Database, now: number, opts: { month?: string; limit?: number } = {}): ForecastHistoryExport {
  return { meta: buildMeta('forecast_history', now, opts.month ? { month: opts.month } : {}), snapshots: listForecastSnapshots(db, opts) }
}

// ---- 7b. alerts (GAP-12) --------------------------------------------------------------------

export interface AlertsExport { meta: ExportMeta; alerts: AlertRecord[] }

/** Active alerts by default (matches GET /api/costs/alerts' default view); includeResolved for the full history. */
export function exportAlerts(db: Database.Database, now: number, opts: { includeResolved?: boolean } = {}): AlertsExport {
  return {
    meta: buildMeta(opts.includeResolved ? 'alerts_all' : 'alerts_active', now),
    alerts: listAlerts(db, { status: opts.includeResolved ? 'all' : 'active' }),
  }
}

export function alertsToCsv(rows: AlertRecord[]): string {
  const headers = ['dedup_key', 'type', 'severity', 'first_seen', 'last_seen', 'acknowledged_at', 'resolved_at', 'recurrence_count']
  return objectsToCsv(rows as unknown as Record<string, unknown>[], headers)
}

// ---- 8. data quality report --------------------------------------------------------------------

export interface DataQualityExport {
  meta: ExportMeta
  confidence_breakdown: Record<string, number>
  breakdown: { fixed_manual: number; provider: number; estimate: number }
  data_freshness: number | null
  source_freshness_counts: Record<Freshness, number>
}

export function exportDataQualityReport(db: Database.Database, config: CostOpsConfig, now: number, opts: { month?: string } = {}): DataQualityExport {
  const summary = getCostSummary(db, config, now, { monthKey: opts.month })
  const inventory = buildSourceInventory(db, config, now)
  const counts: Record<Freshness, number> = { fresh: 0, aging: 0, stale: 0, unknown: 0 }
  for (const s of inventory) counts[s.freshness] += 1
  return {
    meta: buildMeta('data_quality_report', now, opts),
    confidence_breakdown: summary.confidence_breakdown,
    breakdown: summary.breakdown,
    data_freshness: summary.data_freshness,
    source_freshness_counts: counts,
  }
}

// ---- 9. monthly snapshot (bundle -- NOT an immutable close, see note) --------------------------

export interface MonthlySnapshotExport {
  meta: ExportMeta
  note: string
  period_status: PeriodCloseStatus
  ledger: ExportRow[]
  provider_summary: CostSummary['operational']['provider_breakdown']
  category_summary: CategorySummaryRow[]
  budget: BudgetVarianceExport['budget']
  reconciliation: SourceReconciliation[]
  data_quality: Omit<DataQualityExport, 'meta'>
}

/**
 * Bundles ledger + provider/category summary + budget + reconciliation +
 * data quality for one month into a single JSON artifact ("a month's state,
 * auditable without the dashboard" -- GAP-18's target).
 *
 * This is a LIVE recomputation, not the immutable close record -- period
 * close/reopen (GAP-13) landed on this branch (period-close.ts), so a real
 * `period_status` is included here for honesty, but if the month is
 * 'closed' the AUTHORITATIVE, frozen artifact is
 * `getCloseSnapshot()`/`GET /api/costs/period-close?month=` (the CostSummary
 * exactly as it was at close time). This bundle always reflects the
 * CURRENT live state instead -- for an open/reopened month that's the only
 * option; for a closed month it can still legitimately drift from the frozen
 * close snapshot if a correction lands afterward, which is why `note` below
 * says so explicitly rather than letting a consumer assume the two always
 * agree.
 */
export function exportMonthlySnapshot(db: Database.Database, config: CostOpsConfig, now: number, month?: string): MonthlySnapshotExport {
  const opts = month ? { month } : {}
  const win = monthWindow(now, month)
  const ledger = exportCostRows(db, now, opts)
  const provider = exportProviderSummary(db, config, now, opts)
  const category = exportCategorySummary(db, now, opts)
  const budget = exportBudgetVariance(db, config, now, opts)
  const reconciliation = exportReconciliationReport(db, now, month)
  const dq = exportDataQualityReport(db, config, now, opts)
  return {
    meta: buildMeta('monthly_snapshot', now, opts),
    note: 'Live recomputation of the current state, not the frozen close record -- for a closed month, GET /api/costs/period-close?month= returns the immutable snapshot taken at close time instead; this bundle can drift from it if a correction lands afterward.',
    period_status: getPeriodStatus(db, win.key),
    ledger,
    provider_summary: provider.provider_breakdown,
    category_summary: category.categories,
    budget: budget.budget,
    reconciliation: reconciliation.sources,
    data_quality: { confidence_breakdown: dq.confidence_breakdown, breakdown: dq.breakdown, data_freshness: dq.data_freshness, source_freshness_counts: dq.source_freshness_counts },
  }
}
