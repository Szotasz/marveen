// CostOps Phase 2 (GAP-13) -- monthly period close/reopen workflow.
//
// A month's accounting state is one of: open (current/default), provisional
// (an operator-chosen "getting ready to close" marker -- same write rules as
// open, purely informational), closed (immutable snapshot taken, new writes
// blocked except via correction.ts), reopened (explicitly reopened from
// closed, audited, write rules revert to open until closed again).
//
// Every close/reopen is an audited event (actor + reason + timestamp) in
// period_close_events, never a silent status flip. A close event also
// carries an IMMUTABLE snapshot (the full month's CostSummary at close time)
// so "what did we believe the numbers were when we closed this month" stays
// reproducible even if later corrections change the live numbers.

import type Database from 'better-sqlite3'
import { getCostSummary, monthWindow, type CostSummary } from './ledger.js'
import type { CostOpsConfig } from './config.js'
import { loadSubscriptionsConfig, deriveLifecycle } from './subscriptions.js'
import { buildReconciliation } from './reconciliation.js'
import { getAllBudgetStatuses, type BudgetStatus } from './budgets.js'

export type PeriodCloseStatus = 'open' | 'provisional' | 'closed' | 'reopened'

export function initPeriodCloseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS period_status (
      month TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS period_close_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      snapshot_json TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_period_close_events_month ON period_close_events(month, created_at)`)
}

/** Current status for a month, defaulting to 'open' when no row exists yet -- every historical month is open until explicitly touched. */
export function getPeriodStatus(db: Database.Database, month: string): PeriodCloseStatus {
  const row = db.prepare(`SELECT status FROM period_status WHERE month = ?`).get(month) as { status: PeriodCloseStatus } | undefined
  return row?.status ?? 'open'
}

/** True only for 'closed' -- 'reopened' and 'provisional' both accept normal writes, matching 'open' rules. */
export function isPeriodClosed(db: Database.Database, month: string): boolean {
  return getPeriodStatus(db, month) === 'closed'
}

export interface WritableCheckResult {
  writable: boolean
  reason?: string
}

/**
 * Guard for any direct-write path (manual entry, email ingest, collector
 * upsert) that might target a closed month. Returns {writable:false} instead
 * of throwing -- callers decide their own error-response shape, same
 * convention as manual-entry.ts's {ok,error,status} results.
 */
export function checkPeriodWritable(db: Database.Database, month: string): WritableCheckResult {
  if (isPeriodClosed(db, month)) {
    return { writable: false, reason: `month ${month} is closed -- use a correction (createCorrection) instead of a direct write` }
  }
  return { writable: true }
}

export interface CloseReadinessResult {
  month: string
  ready: boolean
  checks: {
    expected_invoices_received: { ok: boolean; missing: string[] }
    collectors_fresh: { ok: boolean; failed_providers: string[]; stale_providers: string[] }
    reconciliation_clean: { ok: boolean; issues: Array<{ source_id: string; status: string }> }
    estimates_present: { ok: boolean; estimate_only_sources: string[] }
    unresolved_alerts: { ok: boolean; count: number; critical_count: number }
    fx_provenance_complete: { ok: boolean; missing_count: number }
  }
}

/**
 * The close-readiness checklist (functional-scope §13). `ready` is the
 * BLOCKING subset only (missing past-due invoices, a genuinely failed
 * collector sync, or an unresolved CRITICAL alert) -- estimates-present and
 * stale-but-not-failed collectors are surfaced as visibility, never block a
 * deliberate close (an operator may legitimately close a month knowing a
 * source is estimate-only forever).
 */
export function checkCloseReadiness(db: Database.Database, config: CostOpsConfig, now: number, month: string): CloseReadinessResult {
  const win = monthWindow(now, month)
  const summary = getCostSummary(db, config, now, { monthKey: month })

  const { config: subsConfig } = loadSubscriptionsConfig()
  const subscriptions = deriveLifecycle(subsConfig, now)
  const missing = subscriptions.filter(s => s.past_due).map(s => s.id)

  const failed_providers = summary.provider_sync.filter(p => p.status === 'failed').map(p => p.provider)
  const stale_providers = summary.provider_sync.filter(p => p.status === 'stale').map(p => p.provider)

  const reconciliation = buildReconciliation(db, now, month)
  const issues = reconciliation.filter(r => r.status === 'variance').map(r => ({ source_id: r.source_id, status: r.status }))

  const estimate_only_sources = reconciliation.filter(r => r.status === 'estimate_only').map(r => r.source_id)

  const alertRows = db.prepare(`SELECT severity FROM costops_alerts WHERE resolved_at IS NULL`).all() as Array<{ severity: string }>
  const critical_count = alertRows.filter(a => a.severity === 'critical').length

  const fxMissingRow = db.prepare(`
    SELECT COUNT(*) as c FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start AND voided_at IS NULL
      AND original_currency IS NOT NULL AND fx_source IS NULL
  `).get({ start: win.start, end: win.end }) as { c: number }

  const checks: CloseReadinessResult['checks'] = {
    expected_invoices_received: { ok: missing.length === 0, missing },
    collectors_fresh: { ok: failed_providers.length === 0, failed_providers, stale_providers },
    reconciliation_clean: { ok: issues.length === 0, issues },
    estimates_present: { ok: estimate_only_sources.length === 0, estimate_only_sources },
    unresolved_alerts: { ok: critical_count === 0, count: alertRows.length, critical_count },
    fx_provenance_complete: { ok: fxMissingRow.c === 0, missing_count: fxMissingRow.c },
  }

  const ready = checks.expected_invoices_received.ok && checks.collectors_fresh.ok
    && checks.reconciliation_clean.ok && checks.unresolved_alerts.ok

  return { month: win.key, ready, checks }
}

/** The full immutable record taken at close time -- the CostSummary plus every configured budget's status, so a closed month's budget picture is frozen too (GAP-11: "budget-snapshot legyen resze a period-close-nak"). */
export interface ImmutableCloseSnapshot {
  summary: CostSummary
  budgets: BudgetStatus[]
}

export interface CloseResult {
  ok: boolean
  error?: string
  status?: number
  readiness?: CloseReadinessResult
  snapshot?: ImmutableCloseSnapshot
}

/**
 * Close a month: takes an immutable snapshot (the full CostSummary + every
 * budget's status at close time) and records the close event. Blocked by
 * default if the readiness checklist has a blocking issue -- `force: true`
 * lets an operator deliberately override (still fully audited: the reason
 * is recorded either way). Already-closed months 409 (must reopen first,
 * never a silent re-close that would overwrite the earlier immutable
 * snapshot).
 */
export function closePeriod(
  db: Database.Database,
  config: CostOpsConfig,
  month: string,
  actor: string,
  reason: string | null,
  now: number,
  opts: { force?: boolean } = {},
): CloseResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required for a close event', status: 400 }
  const current = getPeriodStatus(db, month)
  if (current === 'closed') return { ok: false, error: `month ${month} is already closed -- reopen it first`, status: 409 }

  const readiness = checkCloseReadiness(db, config, now, month)
  if (!readiness.ready && !opts.force) {
    return { ok: false, error: 'close-readiness checklist has blocking issues -- pass force:true to override', status: 409, readiness }
  }

  const summary = getCostSummary(db, config, now, { monthKey: month })
  const budgets = getAllBudgetStatuses(db, config, now, month)
  const snapshot: ImmutableCloseSnapshot = { summary, budgets }
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO period_close_events (month, event_type, actor, reason, snapshot_json, created_at)
      VALUES (?, 'closed', ?, ?, ?, ?)
    `).run(month, actor, reason, JSON.stringify(snapshot), now)
    db.prepare(`
      INSERT INTO period_status (month, status, updated_at) VALUES (?, 'closed', ?)
      ON CONFLICT(month) DO UPDATE SET status = 'closed', updated_at = excluded.updated_at
    `).run(month, now)
  })
  tx()
  return { ok: true, readiness, snapshot }
}

export interface ReopenResult {
  ok: boolean
  error?: string
  status?: number
}

/** Reopen a closed month. Requires a reason (audit trail) -- write rules revert to 'open' until closed again. */
export function reopenPeriod(db: Database.Database, month: string, actor: string, reason: string, now: number): ReopenResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required for a reopen event', status: 400 }
  if (!reason || !reason.trim()) return { ok: false, error: 'reason is required to reopen a closed period', status: 400 }
  const current = getPeriodStatus(db, month)
  if (current !== 'closed') return { ok: false, error: `month ${month} is not closed (status='${current}')`, status: 409 }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO period_close_events (month, event_type, actor, reason, snapshot_json, created_at)
      VALUES (?, 'reopened', ?, ?, NULL, ?)
    `).run(month, actor, reason, now)
    db.prepare(`UPDATE period_status SET status = 'reopened', updated_at = ? WHERE month = ?`).run(now, month)
  })
  tx()
  return { ok: true }
}

export interface PeriodCloseEvent {
  event_type: 'closed' | 'reopened'
  actor: string
  reason: string | null
  created_at: number
}

/** Full close/reopen audit history for a month, oldest first. */
export function getPeriodCloseHistory(db: Database.Database, month: string): PeriodCloseEvent[] {
  return db.prepare(`
    SELECT event_type, actor, reason, created_at FROM period_close_events
    WHERE month = ? ORDER BY created_at ASC
  `).all(month) as PeriodCloseEvent[]
}

/** The immutable snapshot from the LATEST close event for a month, or null if it was never closed. */
export function getCloseSnapshot(db: Database.Database, month: string): ImmutableCloseSnapshot | null {
  const row = db.prepare(`
    SELECT snapshot_json FROM period_close_events
    WHERE month = ? AND event_type = 'closed' ORDER BY created_at DESC LIMIT 1
  `).get(month) as { snapshot_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.snapshot_json) as ImmutableCloseSnapshot
}
