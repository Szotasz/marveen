// CostOps -- alerts capture (GAP-12 orchestration layer).
//
// alerts.ts (Anvil, Phase 3) is pure computation only -- no DB reads, no
// knowledge of ledger.ts/forecast.ts/reconciliation.ts/inventory.ts shapes.
// This module is the thin orchestration on top: adapt each already-live
// module's real data into the 13 detectors' narrow SIGNAL interfaces, run
// them, reconcile the result against what's already stored in
// `costops_alerts` via reconcileAlerts(), and persist it.
//
// NOT done here (seam-owner is Mason, same as forecast-capture.ts): the
// GET /api/costs/alerts route and the boot-time capture cadence
// (startCostOpsBackgroundTasks). This file only exports the orchestration +
// persistence functions those call.
//
// Signal sources actually available today (verified against the live
// codebase, 2026-07-15):
// - budget/forecast_budget_breach: getCostSummary().budget + the latest
//   whole-deployment forecast_snapshots row (source_id NULL).
// - balance_exhaustion: entitlements (entitlement_type='prepaid_balance') --
//   reuses the exhaustion date collectors/deepseek.ts already computed and
//   stored, rather than recomputing it a second time from
//   provider_balance_snapshots.
// - stale_collector/failed_sync/credential_permission_error: import_runs,
//   same "latest run per provider" query ledger.ts's own (private)
//   provider_sync block uses -- small enough to duplicate locally rather
//   than export a helper from a file this feature doesn't own touching
//   right now.
// - reconciliation_mismatch: reconciliation.ts's buildReconciliation().
// - manual_provider_variance: getCostSummary().operational -- WHOLE-
//   DEPLOYMENT only; OperationalResult has no per-provider manual-vs-
//   provider-derived split today, so this is one coarser signal, not
//   fabricated per-provider noise.
// - unusual_spend_growth: period.ts's getPeriodTrend() (global + per
//   provider, current vs previous month).
// - new_unknown_source / long_estimate_only_source: derived directly from
//   cost_line_items history per source (earliest activity date / last N
//   billing periods' resolved confidence).
// - subscription_utilization: subscriptions.ts + limits.ts's
//   fromSubscriptions() (weekly_usage_pct and similar already-normalized
//   percentages).
// - missing_invoice: invoice.ts's costops_invoices (GAP-14, landed) --
//   inferExpectedInvoiceBy() projects the next expected invoice date from a
//   source's OWN observed invoice-period history (median gap + grace days),
//   never a fabricated "always monthly" assumption. A source with fewer
//   than 2 recorded invoices has no inferable cadence and is honestly
//   skipped (see the function below), not guessed at.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import { monthWindow, CONF_PRIORITY, getCostSummary, type CostSummary } from './ledger.js'
import { getPeriodTrend } from './period.js'
import { buildReconciliation } from './reconciliation.js'
import { loadSubscriptionsConfig, deriveLifecycle } from './subscriptions.js'
import { fromSubscriptions } from './limits.js'
import { getAllBudgetStatuses } from './budgets.js'
import { inferExpectedInvoiceBy } from './invoice.js'
import {
  detectBudgetThresholdAlert,
  detectForecastBudgetBreachAlert,
  detectBalanceExhaustionAlert,
  detectStaleCollectorAlert,
  detectFailedSyncAlert,
  detectCredentialPermissionAlert,
  detectReconciliationMismatchAlert,
  detectManualProviderVarianceAlert,
  detectMissingInvoiceAlert,
  detectUnusualSpendGrowthAlert,
  detectNewUnknownSourceAlert,
  detectLongEstimateOnlySourceAlert,
  detectSubscriptionUtilizationAlert,
  reconcileAlerts,
  serializeEvidence,
  deserializeEvidence,
  type AlertCandidate,
  type AlertRecord,
  type AlertType,
  type AlertSeverity,
  type SyncSignal,
} from './alerts.js'

// ---- thresholds -- reused from the codebase's own existing conventions, not invented ----

// mirrors reconciliation.ts's own (private) VARIANCE_TOLERANCE_FRACTION -- a
// row already flagged 'variance' upstream reliably clears this too.
const RECONCILIATION_VARIANCE_THRESHOLD = 0.02
// mirrors warnings.ts's MATERIAL_FRACTION
const MANUAL_PROVIDER_VARIANCE_THRESHOLD = 0.15
// mirrors warnings.ts's LARGE_INCREASE_FRACTION
const SPEND_GROWTH_THRESHOLD = 0.5
// mirrors ledger.ts's own (private) provider_sync STALE_SECS
const SYNC_STALE_SECS = 3 * 24 * 3600
// flagged placeholders (same convention as inventory.ts's freshness thresholds) -- tune once
// real utilisation data accumulates. Over mirrors limits.ts's own tierForPct critical=0.9.
const UTILIZATION_UNDER_THRESHOLD = 0.1
const UTILIZATION_OVER_THRESHOLD = 0.9
// a source needs this many CONSECUTIVE billing periods, all resolving to an estimate-tier
// confidence, before "long estimate-only" is claimed -- never fabricated from less history.
const ESTIMATE_ONLY_LOOKBACK_PERIODS = 3
const ESTIMATE_ONLY_CONF = new Set(['manual', 'estimate', 'local_usage'])

// ---- signal gathering ------------------------------------------------------------------

/**
 * Phase 3 (GAP-11): every configured budget (global/provider/category/source),
 * not just the legacy single global one -- getAllBudgetStatuses() already
 * resolves each scope's real spend/forecast against the same CostSummary, so
 * this just runs the two budget detectors per budget instead of once.
 * dedup_key is keyed by budget_id (alerts.ts), so distinct budgets never
 * collide even when several breach in the same capture pass.
 */
function gatherBudgetCandidates(db: Database.Database, config: CostOpsConfig, now: number): AlertCandidate[] {
  const out: AlertCandidate[] = []
  const win = monthWindow(now)
  const latestTotalForecastRow = db.prepare(`
    SELECT forecast_amount FROM forecast_snapshots WHERE source_id IS NULL AND month = ? ORDER BY snapshot_at DESC LIMIT 1
  `).get(win.key) as { forecast_amount: number } | undefined

  const statuses = getAllBudgetStatuses(db, config, now)
  for (const b of statuses) {
    const scopeLabel = b.scope_ref ? `${b.scope}:${b.scope_ref}` : b.scope
    const threshold = detectBudgetThresholdAlert({
      budget_id: b.id, scope: scopeLabel,
      used_pct: b.used_pct, warning_threshold: b.warning_threshold, hard_threshold: b.hard_threshold,
    })
    if (threshold) out.push(threshold)

    // Prefer the Phase-1 forecast module's captured TOTAL snapshot (more accurate than the
    // naive per-scope forecast) for the global budget only -- provider/category/source scopes
    // have no per-scope forecast snapshot yet, so they use resolveBudgetStatus's own
    // forecast_pct (summed forecast_month_end across that scope's sources), never fabricated.
    const forecastPct = (b.scope === 'global' && latestTotalForecastRow != null && b.amount > 0)
      ? latestTotalForecastRow.forecast_amount / b.amount
      : b.forecast_pct
    const breach = detectForecastBudgetBreachAlert({
      budget_id: b.id, scope: scopeLabel,
      used_pct: b.used_pct, forecast_pct: forecastPct,
      warning_threshold: b.warning_threshold, hard_threshold: b.hard_threshold,
    })
    if (breach) out.push(breach)
  }
  return out
}

interface EntitlementRow { provider: string; remaining: number | null; forecast_exhaustion_at: number | null; included_unit: string | null }

function gatherBalanceExhaustionCandidates(db: Database.Database, now: number): AlertCandidate[] {
  const rows = db.prepare(`
    SELECT provider, remaining, forecast_exhaustion_at, included_unit
    FROM entitlements WHERE entitlement_type = 'prepaid_balance'
  `).all() as EntitlementRow[]
  const out: AlertCandidate[] = []
  for (const r of rows) {
    if (r.remaining == null) continue
    const c = detectBalanceExhaustionAlert(
      { provider: r.provider, remaining: r.remaining, currency: r.included_unit ?? 'USD', forecast_exhaustion_at: r.forecast_exhaustion_at },
      now,
    )
    if (c) out.push(c)
  }
  return out
}

const CREDENTIAL_ERROR_MARKER = /credential|api[_-]?key|unauthorized|401/i
const PERMISSION_ERROR_MARKER = /permission|forbidden|403|access/i

/**
 * Real collector error_code values today are raw (HTTP-status-ish, Node error
 * names, or ad-hoc strings like deepseek.ts's 'balance_error') -- not the
 * clean 'credential_error'/'permission_error' vocabulary alerts.ts's
 * detectors expect. This adapts messy reality into that vocabulary; a code
 * that matches neither pattern stays unclassified (null), never guessed.
 */
export function classifyErrorCode(raw: string | null): 'credential_error' | 'permission_error' | null {
  if (!raw) return null
  if (CREDENTIAL_ERROR_MARKER.test(raw)) return 'credential_error'
  if (PERMISSION_ERROR_MARKER.test(raw)) return 'permission_error'
  return null
}

interface RunRow { provider: string; status: string; started_at: number; error_code: string | null }

function gatherSyncAndCredentialCandidates(db: Database.Database, now: number): AlertCandidate[] {
  const latestRows = db.prepare(`
    SELECT provider, status, started_at, error_code
    FROM import_runs r
    WHERE started_at = (SELECT MAX(started_at) FROM import_runs WHERE provider = r.provider)
    GROUP BY provider
  `).all() as RunRow[]
  const lastOkStmt = db.prepare(`SELECT MAX(started_at) t FROM import_runs WHERE provider = ? AND status = 'ok'`)
  const out: AlertCandidate[] = []
  for (const r of latestRows) {
    const lastOk = (lastOkStmt.get(r.provider) as { t: number | null }).t ?? null
    const age = now - r.started_at
    const stale = r.status === 'ok' && age > SYNC_STALE_SECS
    const classified = classifyErrorCode(r.error_code)
    const status: SyncSignal['status'] = r.status !== 'ok' ? 'failed' : (stale ? 'stale' : 'ok')
    const signal: SyncSignal = { provider: r.provider, status, last_success: lastOk, data_age_secs: age, error_code: classified ?? r.error_code }

    const staleAlert = detectStaleCollectorAlert(signal)
    if (staleAlert) out.push(staleAlert)
    const failedAlert = detectFailedSyncAlert(signal)
    if (failedAlert) out.push(failedAlert)
    // credential_permission_error is a DISTINCT alert type from failed_sync (both can fire
    // together from the same underlying event) -- provider used as source_id surrogate since
    // this codebase's credentials are provider-scoped, not per-source.
    if (status === 'failed' && classified) {
      out.push(detectCredentialPermissionAlert({ source_id: r.provider, provider: r.provider, issue: classified }))
    }
  }
  return out
}

function gatherReconciliationCandidates(db: Database.Database, now: number): AlertCandidate[] {
  const rows = buildReconciliation(db, now)
  const out: AlertCandidate[] = []
  for (const row of rows) {
    if (row.status !== 'variance') continue
    const actual = row.invoice_amount ?? row.operationally_selected_amount
    const estimate = row.observed_provider_amount ?? row.expected_amount
    if (actual == null || estimate == null || row.variance == null) continue
    const c = detectReconciliationMismatchAlert({ source_id: row.source_id, estimate, actual, variance: row.variance, variance_threshold_pct: RECONCILIATION_VARIANCE_THRESHOLD })
    if (c) out.push(c)
  }
  return out
}

function gatherManualProviderVarianceCandidates(summary: CostSummary): AlertCandidate[] {
  const providerDerived = summary.operational.provider_derived_spend
  if (providerDerived === 0) return []
  const c = detectManualProviderVarianceAlert({
    provider: 'global',
    manual_spend: summary.operational.manual_spend,
    provider_derived_spend: providerDerived,
    variance_threshold_pct: MANUAL_PROVIDER_VARIANCE_THRESHOLD,
  })
  return c ? [c] : []
}

function gatherUnusualSpendGrowthCandidates(db: Database.Database, config: CostOpsConfig, now: number): AlertCandidate[] {
  const trend = getPeriodTrend(db, config, now, 2)
  if (trend.current.no_data || trend.previous.no_data) return []
  const out: AlertCandidate[] = []
  const total = detectUnusualSpendGrowthAlert({
    key: 'global', current_amount: trend.current.operational_spend,
    baseline_amount: trend.previous.operational_spend, growth_threshold_pct: SPEND_GROWTH_THRESHOLD,
  })
  if (total) out.push(total)
  const prevByProvider = new Map(trend.previous.provider_breakdown.map(p => [p.provider, p.spend]))
  for (const cur of trend.current.provider_breakdown) {
    const baseline = prevByProvider.get(cur.provider)
    if (baseline == null) continue
    const c = detectUnusualSpendGrowthAlert({ key: cur.provider, current_amount: cur.spend, baseline_amount: baseline, growth_threshold_pct: SPEND_GROWTH_THRESHOLD })
    if (c) out.push(c)
  }
  return out
}

function gatherNewSourceAndEstimateOnlyCandidates(db: Database.Database, now: number): AlertCandidate[] {
  const out: AlertCandidate[] = []
  const win = monthWindow(now)
  const sources = db.prepare(`SELECT id FROM cost_sources WHERE active = 1`).all() as Array<{ id: string }>

  for (const s of sources) {
    const earliest = db.prepare(`SELECT MIN(charge_period_start) as t FROM cost_line_items WHERE source_id = ? AND voided_at IS NULL`).get(s.id) as { t: number | null }
    if (earliest.t != null) {
      const isFirst = earliest.t >= win.start && earliest.t < win.end
      const c = detectNewUnknownSourceAlert({ source_id: s.id, first_seen_month: win.key, is_first_appearance: isFirst })
      if (c) out.push(c)
    }

    const periodRows = db.prepare(`
      SELECT DISTINCT charge_period_start FROM cost_line_items
      WHERE source_id = ? AND voided_at IS NULL ORDER BY charge_period_start DESC LIMIT ?
    `).all(s.id, ESTIMATE_ONLY_LOOKBACK_PERIODS) as Array<{ charge_period_start: number }>
    if (periodRows.length < ESTIMATE_ONLY_LOOKBACK_PERIODS) continue // not enough history to claim "long" -- never fabricated

    let allEstimateOnly = true
    for (const p of periodRows) {
      const lines = db.prepare(`SELECT confidence FROM cost_line_items WHERE source_id = ? AND charge_period_start = ? AND voided_at IS NULL`).all(s.id, p.charge_period_start) as Array<{ confidence: string }>
      const resolved = lines.reduce((best, l) => (CONF_PRIORITY[l.confidence] || 0) > (CONF_PRIORITY[best] || 0) ? l.confidence : best, lines[0]?.confidence ?? 'manual')
      if (!ESTIMATE_ONLY_CONF.has(resolved)) { allEstimateOnly = false; break }
    }
    if (allEstimateOnly) {
      const c = detectLongEstimateOnlySourceAlert({ source_id: s.id, consecutive_estimate_only_months: periodRows.length, threshold_months: ESTIMATE_ONLY_LOOKBACK_PERIODS })
      if (c) out.push(c)
    }
  }
  return out
}

function gatherUtilizationCandidates(now: number): AlertCandidate[] {
  const { config } = loadSubscriptionsConfig()
  const subs = deriveLifecycle(config, now)
  const limitStatuses = fromSubscriptions(subs)
  const out: AlertCandidate[] = []
  for (const ls of limitStatuses) {
    if (ls.usage_pct == null || ls.sub_id == null) continue
    const c = detectSubscriptionUtilizationAlert({ subscription_id: ls.sub_id, usage_pct: ls.usage_pct, under_threshold_pct: UTILIZATION_UNDER_THRESHOLD, over_threshold_pct: UTILIZATION_OVER_THRESHOLD })
    if (c) out.push(c)
  }
  return out
}

/**
 * Per active source: infer the next expected invoice date from that
 * source's OWN recorded invoice history (invoice.ts's costops_invoices),
 * then check whether it's overdue. A source with fewer than 2 recorded
 * invoices has no inferable cadence -- honestly skipped, not guessed. Since
 * this queries the FULL history fresh each capture round, a newly-arrived
 * invoice becomes part of the history and naturally pushes the inferred
 * expected-by date forward -- no separate "received" flag needed (see
 * invoice.ts's inferExpectedInvoiceBy doc comment for why).
 */
function gatherMissingInvoiceCandidates(db: Database.Database, now: number): AlertCandidate[] {
  const out: AlertCandidate[] = []
  const sources = db.prepare(`SELECT DISTINCT source_id FROM costops_invoices`).all() as Array<{ source_id: string }>
  for (const s of sources) {
    const rows = db.prepare(`
      SELECT billing_period_end FROM costops_invoices
      WHERE source_id = ? AND status != 'voided' ORDER BY billing_period_end ASC
    `).all(s.source_id) as Array<{ billing_period_end: number }>
    const expectedBy = inferExpectedInvoiceBy(rows.map(r => r.billing_period_end))
    if (expectedBy == null) continue
    const c = detectMissingInvoiceAlert({ source_id: s.source_id, expected_by: expectedBy, received: false }, now)
    if (c) out.push(c)
  }
  return out
}

/**
 * Gather every alert candidate this round, from every live signal source
 * currently available in the codebase. Pure DB READS only (no writes) --
 * `captureAlerts` below is the only function that persists anything.
 */
export function gatherAlertCandidates(db: Database.Database, config: CostOpsConfig, now: number): AlertCandidate[] {
  const summary = getCostSummary(db, config, now)

  return [
    ...gatherBudgetCandidates(db, config, now),
    ...gatherBalanceExhaustionCandidates(db, now),
    ...gatherSyncAndCredentialCandidates(db, now),
    ...gatherReconciliationCandidates(db, now),
    ...gatherManualProviderVarianceCandidates(summary),
    ...gatherUnusualSpendGrowthCandidates(db, config, now),
    ...gatherNewSourceAndEstimateOnlyCandidates(db, now),
    ...gatherUtilizationCandidates(now),
    ...gatherMissingInvoiceCandidates(db, now),
  ]
}

// ---- persistence (costops_alerts) --------------------------------------------------------

interface AlertRow {
  dedup_key: string
  type: string
  severity: string
  evidence_json: string
  first_seen: number
  last_seen: number
  acknowledged_at: number | null
  acknowledged_by: string | null
  resolved_at: number | null
  recurrence_count: number
  owner: string | null
  cooldown_until: number | null
}

function rowToRecord(r: AlertRow): AlertRecord {
  return {
    dedup_key: r.dedup_key, type: r.type as AlertType, severity: r.severity as AlertSeverity,
    evidence: deserializeEvidence(r.evidence_json),
    first_seen: r.first_seen, last_seen: r.last_seen,
    acknowledged_at: r.acknowledged_at, acknowledged_by: r.acknowledged_by,
    resolved_at: r.resolved_at, recurrence_count: r.recurrence_count,
    owner: r.owner, cooldown_until: r.cooldown_until,
  }
}

function loadExistingAlerts(db: Database.Database): AlertRecord[] {
  const rows = db.prepare(`SELECT * FROM costops_alerts`).all() as AlertRow[]
  return rows.map(rowToRecord)
}

export interface AlertCaptureSummary {
  candidates: number
  inserted: number
  touched: number
  resolved: number
}

/**
 * Gather this round's candidates, reconcile against `costops_alerts`, and
 * persist the result (insert new rows, touch active/reopened ones, resolve
 * ones whose condition disappeared). Requires `initAlertsSchema` to have
 * already run (Mason's seam call) -- not invoked here (this file is
 * capture-orchestration, not schema setup).
 */
export function captureAlerts(db: Database.Database, config: CostOpsConfig, now: number, opts: { cooldownSeconds?: number } = {}): AlertCaptureSummary {
  const existing = loadExistingAlerts(db)
  const candidates = gatherAlertCandidates(db, config, now)
  const result = reconcileAlerts(existing, candidates, now, opts.cooldownSeconds)

  const insertStmt = db.prepare(`
    INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, acknowledged_at, acknowledged_by, resolved_at, recurrence_count, owner, cooldown_until, created_at)
    VALUES (@type, @severity, @evidence_json, @dedup_key, @first_seen, @last_seen, NULL, NULL, NULL, 0, NULL, @cooldown_until, @now)
  `)
  for (const a of result.toInsert) {
    insertStmt.run({ type: a.type, severity: a.severity, evidence_json: serializeEvidence(a.evidence), dedup_key: a.dedup_key, first_seen: a.first_seen, last_seen: a.last_seen, cooldown_until: a.cooldown_until, now })
  }

  const touchStmt = db.prepare(`
    UPDATE costops_alerts SET last_seen=@last_seen, severity=@severity, evidence_json=@evidence_json, resolved_at=@resolved_at, recurrence_count=@recurrence_count, cooldown_until=@cooldown_until
    WHERE dedup_key=@dedup_key
  `)
  for (const t of result.toTouch) {
    touchStmt.run({
      dedup_key: t.dedup_key, last_seen: t.patch.last_seen, severity: t.patch.severity,
      evidence_json: serializeEvidence(t.patch.evidence), resolved_at: t.patch.resolved_at,
      recurrence_count: t.patch.recurrence_count, cooldown_until: t.patch.cooldown_until,
    })
  }

  const resolveStmt = db.prepare(`UPDATE costops_alerts SET resolved_at=@resolved_at WHERE dedup_key=@dedup_key`)
  for (const r of result.toResolve) {
    resolveStmt.run({ dedup_key: r.dedup_key, resolved_at: r.resolved_at })
  }

  return { candidates: candidates.length, inserted: result.toInsert.length, touched: result.toTouch.length, resolved: result.toResolve.length }
}

export interface AlertListRow {
  dedup_key: string
  type: string
  severity: string
  evidence: Record<string, unknown>
  first_seen: number
  last_seen: number
  acknowledged_at: number | null
  acknowledged_by: string | null
  resolved_at: number | null
  recurrence_count: number
  owner: string | null
}

/** Read back stored alerts, most recent first. Unresolved-only by default (the GET route's likely default view). */
export function listAlerts(db: Database.Database, opts: { includeResolved?: boolean; limit?: number } = {}): AlertListRow[] {
  const limit = opts.limit ?? 200
  const rows = (
    opts.includeResolved
      ? db.prepare(`SELECT * FROM costops_alerts ORDER BY last_seen DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM costops_alerts WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT ?`).all(limit)
  ) as AlertRow[]
  return rows.map(r => ({
    dedup_key: r.dedup_key, type: r.type, severity: r.severity, evidence: deserializeEvidence(r.evidence_json),
    first_seen: r.first_seen, last_seen: r.last_seen, acknowledged_at: r.acknowledged_at, acknowledged_by: r.acknowledged_by,
    resolved_at: r.resolved_at, recurrence_count: r.recurrence_count, owner: r.owner,
  }))
}
