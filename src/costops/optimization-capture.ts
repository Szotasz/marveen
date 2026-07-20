// CostOps -- optimization recommendation capture (GAP-17 orchestration layer).
//
// Mirrors alerts-capture.ts's shape exactly: adapt each already-live
// module's real data into optimization.ts's narrow SIGNAL interfaces, run
// the detectors, reconcile against `costops_recommendations` via
// reconcileRecommendations(), and persist. NOT done here (seam-owner is
// Mason, same as alerts-capture.ts): any GET route and the boot-time
// capture cadence (startCostOpsBackgroundTasks) -- one more line in the
// daily cycle alongside captureForecastSnapshots/captureAlerts.
//
// Signal sources actually available today (verified against the live
// codebase, 2026-07-15) -- 4 of the 9 recommendation types have a real,
// non-fabricated signal to wire; the other 5 are HONESTLY LEFT EMPTY, not
// guessed at, each documented below with what would be needed:
//
// - underused_subscription_downgrade: subscriptions.ts + limits.ts's
//   fromSubscriptions() usage_pct. Only the CANCEL option is ever offered
//   (never a fabricated "downgrade to a cheaper tier") -- no plan-tier
//   pricing map exists anywhere in this codebase's data model.
// - duplicate_subscription: subscriptions.ts, grouped by PROVIDER (the
//   finest real grouping key that exists -- costops-subscriptions.json has
//   no product/category field beyond provider).
// - duplicate_hosting_saas: cost_line_items/cost_sources, grouped by
//   (provider, source_type) -- an observable fact, not a text-similarity
//   guess on service names.
// - automate_long_manual_source: cost_line_items history, the SAME
//   "N consecutive estimate-tier periods" query alerts-capture.ts's
//   long_estimate_only_source detector uses (duplicated locally per this
//   codebase's small-self-contained-query convention, not re-exported).
//
// - switch_to_annual_billing: NO live "annual plan monthly-equivalent
//   price" data exists anywhere (costops-subscriptions.json has no such
//   field) -- estimating one generically (e.g. "usually ~15% off") would be
//   exactly the kind of fabrication this codebase's conventions forbid.
// - unused_domain_or_storage: this dispatch assumed a "source-inventory
//   confirmed_unused flag" exists -- IT DOES NOT (checked inventory.ts,
//   expiry-checks.ts, warnings.ts: none track domain/storage USAGE, only
//   expiry dates). Flagged back to the dispatcher; honestly empty here.
// - forgotten_service: no "last meaningful activity" signal exists beyond
//   billing-line freshness, which isn't meaningful for a recurring fixed
//   subscription (it "shows activity" every month regardless of real use).
// - oversized_fixed_package: no tier-capacity/pricing map exists anywhere.
// - provider_credit_or_discount: no live "known available discount" data
//   source exists (would need a business-knowledge config this codebase
//   doesn't have, distinct from pricing.ts's per-model rates).

import type Database from 'better-sqlite3'
import { monthWindow, CONF_PRIORITY } from './ledger.js'
import { loadSubscriptionsConfig, deriveLifecycle } from './subscriptions.js'
import { fromSubscriptions } from './limits.js'
import {
  detectUnderusedSubscriptionRecommendation,
  detectDuplicateSubscriptionRecommendations,
  detectDuplicateHostingSaasRecommendations,
  detectAutomateLongManualSourceRecommendation,
  reconcileRecommendations,
  serializeEvidence,
  deserializeEvidence,
  type RecommendationCandidate,
  type RecommendationRecord,
  type RecommendationType,
  type RecommendationRisk,
  type RecommendationConfidence,
  type RecommendationStatus,
} from './optimization.js'

// mirrors alerts-capture.ts's UTILIZATION_UNDER_THRESHOLD
const UNDERUSED_THRESHOLD_PCT = 0.1
// mirrors alerts-capture.ts's ESTIMATE_ONLY_LOOKBACK_PERIODS/ESTIMATE_ONLY_CONF
const AUTOMATION_LOOKBACK_PERIODS = 3
const AUTOMATION_CONF = new Set(['manual', 'estimate', 'local_usage'])

// ---- signal gathering ------------------------------------------------------------------

function gatherUnderusedSubscriptionCandidates(now: number): RecommendationCandidate[] {
  const { config } = loadSubscriptionsConfig()
  const subs = deriveLifecycle(config, now)
  const limitStatuses = fromSubscriptions(subs)
  const byId = new Map(subs.map(s => [s.id, s]))
  const out: RecommendationCandidate[] = []
  for (const ls of limitStatuses) {
    if (ls.usage_pct == null || ls.sub_id == null) continue
    const sub = byId.get(ls.sub_id)
    if (!sub || sub.amount == null || sub.status !== 'active') continue // no known real cost -- never fabricated
    const c = detectUnderusedSubscriptionRecommendation({
      subscription_id: sub.id, provider: sub.provider, monthly_cost: sub.amount,
      usage_pct: ls.usage_pct, under_threshold_pct: UNDERUSED_THRESHOLD_PCT,
      cancel_or_downgrade_option: 'cancel', downgrade_monthly_cost: null,
    })
    if (c) out.push(c)
  }
  return out
}

function gatherDuplicateSubscriptionCandidates(now: number): RecommendationCandidate[] {
  const { config } = loadSubscriptionsConfig()
  const subs = deriveLifecycle(config, now)
  const signals = subs.filter(s => s.amount != null).map(s => ({
    subscription_id: s.id, provider: s.provider, product: s.provider,
    monthly_cost: s.amount as number, status: s.status,
  }))
  return detectDuplicateSubscriptionRecommendations(signals)
}

interface SourceSpendRow { source_id: string; provider: string; source_type: string; billed_cost: number; confidence: string }

function gatherDuplicateHostingSaasCandidates(db: Database.Database, now: number): RecommendationCandidate[] {
  const win = monthWindow(now)
  const rows = db.prepare(`
    SELECT cli.source_id as source_id, cs.provider as provider, cs.source_type as source_type,
           cli.billed_cost as billed_cost, cli.confidence as confidence
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.charge_period_start < @end AND cli.charge_period_end > @start AND cli.voided_at IS NULL
      AND cs.source_type IN ('hosting', 'saas', 'domain', 'storage')
      AND cli.confidence NOT IN ('pending_permission', 'provider_plan_estimate')
  `).all({ start: win.start, end: win.end }) as SourceSpendRow[]
  const bySource = new Map<string, SourceSpendRow>()
  for (const r of rows) {
    const cur = bySource.get(r.source_id)
    if (!cur || (CONF_PRIORITY[r.confidence] || 0) > (CONF_PRIORITY[cur.confidence] || 0)) bySource.set(r.source_id, r)
  }
  const signals = [...bySource.values()].map(r => ({
    source_id: r.source_id, provider: r.provider, source_type: r.source_type,
    service_key: `${r.provider}|${r.source_type}`, monthly_cost: r.billed_cost,
  }))
  return detectDuplicateHostingSaasRecommendations(signals)
}

function gatherAutomateLongManualSourceCandidates(db: Database.Database): RecommendationCandidate[] {
  const out: RecommendationCandidate[] = []
  const sources = db.prepare(`SELECT id, provider FROM cost_sources WHERE active = 1`).all() as Array<{ id: string; provider: string }>
  for (const s of sources) {
    const periodRows = db.prepare(`
      SELECT DISTINCT charge_period_start FROM cost_line_items
      WHERE source_id = ? AND voided_at IS NULL ORDER BY charge_period_start DESC LIMIT ?
    `).all(s.id, AUTOMATION_LOOKBACK_PERIODS) as Array<{ charge_period_start: number }>
    if (periodRows.length < AUTOMATION_LOOKBACK_PERIODS) continue

    let allManual = true
    let latestCost = 0
    periodRows.forEach((p, i) => {
      const lines = db.prepare(`SELECT billed_cost, confidence FROM cost_line_items WHERE source_id = ? AND charge_period_start = ? AND voided_at IS NULL`).all(s.id, p.charge_period_start) as Array<{ billed_cost: number; confidence: string }>
      const resolved = lines.reduce((best, l) => (CONF_PRIORITY[l.confidence] || 0) > (CONF_PRIORITY[best.confidence] || 0) ? l : best, lines[0])
      if (!resolved || !AUTOMATION_CONF.has(resolved.confidence)) allManual = false
      if (i === 0 && resolved) latestCost = resolved.billed_cost
    })
    if (allManual) {
      const c = detectAutomateLongManualSourceRecommendation({ source_id: s.id, provider: s.provider, monthly_cost: latestCost, consecutive_manual_only_months: periodRows.length, threshold_months: AUTOMATION_LOOKBACK_PERIODS })
      if (c) out.push(c)
    }
  }
  return out
}

// No live data source for these 5 -- honestly empty, see file header.
function gatherAnnualBillingCandidates(): RecommendationCandidate[] { return [] }
function gatherUnusedDomainOrStorageCandidates(): RecommendationCandidate[] { return [] }
function gatherForgottenServiceCandidates(): RecommendationCandidate[] { return [] }
function gatherOversizedPackageCandidates(): RecommendationCandidate[] { return [] }
function gatherProviderCreditCandidates(): RecommendationCandidate[] { return [] }

/** Gather every recommendation candidate this round. Pure DB/config READS only -- captureRecommendations below is the only function that persists anything. */
export function gatherRecommendationCandidates(db: Database.Database, now: number): RecommendationCandidate[] {
  return [
    ...gatherUnderusedSubscriptionCandidates(now),
    ...gatherDuplicateSubscriptionCandidates(now),
    ...gatherDuplicateHostingSaasCandidates(db, now),
    ...gatherAnnualBillingCandidates(),
    ...gatherUnusedDomainOrStorageCandidates(),
    ...gatherForgottenServiceCandidates(),
    ...gatherOversizedPackageCandidates(),
    ...gatherAutomateLongManualSourceCandidates(db),
    ...gatherProviderCreditCandidates(),
  ]
}

// ---- persistence (costops_recommendations) -----------------------------------------------

interface RecommendationRow {
  dedup_key: string
  type: string
  evidence_json: string
  current_monthly_cost: number
  estimated_monthly_saving: number
  estimated_annual_saving: number
  switching_cost: number
  risk: string
  confidence: string
  human_decision_required: string
  rollback_note: string
  status: string
  status_changed_at: number | null
  status_changed_by: string | null
  expires_at: number | null
  first_seen: number
  last_seen: number
}

function rowToRecord(r: RecommendationRow): RecommendationRecord {
  return {
    type: r.type as RecommendationType, dedup_key: r.dedup_key, evidence: deserializeEvidence(r.evidence_json),
    current_monthly_cost: r.current_monthly_cost, estimated_monthly_saving: r.estimated_monthly_saving,
    estimated_annual_saving: r.estimated_annual_saving, switching_cost: r.switching_cost,
    risk: r.risk as RecommendationRisk, confidence: r.confidence as RecommendationConfidence,
    human_decision_required: r.human_decision_required, rollback_note: r.rollback_note,
    first_seen: r.first_seen, last_seen: r.last_seen, status: r.status as RecommendationStatus,
    status_changed_at: r.status_changed_at, status_changed_by: r.status_changed_by, expires_at: r.expires_at,
  }
}

function loadExistingRecommendations(db: Database.Database): RecommendationRecord[] {
  const rows = db.prepare(`SELECT * FROM costops_recommendations`).all() as RecommendationRow[]
  return rows.map(rowToRecord)
}

export interface RecommendationCaptureSummary {
  candidates: number
  inserted: number
  touched: number
  resolved: number
  expired: number
}

/**
 * Gather this round's candidates, reconcile against `costops_recommendations`,
 * and persist: insert new 'open' rows, touch active ones, mark resolved rows
 * whose condition disappeared, and expire unaddressed ones past their
 * expires_at. Requires `initOptimizationSchema` to have already run (Mason's
 * seam call) -- not invoked here.
 */
export function captureRecommendations(db: Database.Database, now: number, opts: { expirySeconds?: number } = {}): RecommendationCaptureSummary {
  const existing = loadExistingRecommendations(db)
  const candidates = gatherRecommendationCandidates(db, now)
  const result = reconcileRecommendations(existing, candidates, now, opts.expirySeconds)

  const insertStmt = db.prepare(`
    INSERT INTO costops_recommendations
      (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving, switching_cost, risk, confidence, human_decision_required, rollback_note, status, status_changed_at, status_changed_by, expires_at, first_seen, last_seen, created_at)
    VALUES (@type, @evidence_json, @dedup_key, @current_monthly_cost, @estimated_monthly_saving, @estimated_annual_saving, @switching_cost, @risk, @confidence, @human_decision_required, @rollback_note, 'open', NULL, NULL, @expires_at, @first_seen, @last_seen, @now)
  `)
  for (const r of result.toInsert) {
    insertStmt.run({
      type: r.type, evidence_json: serializeEvidence(r.evidence), dedup_key: r.dedup_key,
      current_monthly_cost: r.current_monthly_cost, estimated_monthly_saving: r.estimated_monthly_saving,
      estimated_annual_saving: r.estimated_annual_saving, switching_cost: r.switching_cost,
      risk: r.risk, confidence: r.confidence, human_decision_required: r.human_decision_required,
      rollback_note: r.rollback_note, expires_at: r.expires_at, first_seen: r.first_seen, last_seen: r.last_seen, now,
    })
  }

  const touchStmt = db.prepare(`
    UPDATE costops_recommendations SET
      last_seen=@last_seen, evidence_json=@evidence_json, current_monthly_cost=@current_monthly_cost,
      estimated_monthly_saving=@estimated_monthly_saving, estimated_annual_saving=@estimated_annual_saving,
      switching_cost=@switching_cost, risk=@risk, confidence=@confidence
    WHERE dedup_key=@dedup_key
  `)
  for (const t of result.toTouch) {
    touchStmt.run({
      dedup_key: t.dedup_key, last_seen: t.patch.last_seen, evidence_json: serializeEvidence(t.patch.evidence),
      current_monthly_cost: t.patch.current_monthly_cost, estimated_monthly_saving: t.patch.estimated_monthly_saving,
      estimated_annual_saving: t.patch.estimated_annual_saving, switching_cost: t.patch.switching_cost,
      risk: t.patch.risk, confidence: t.patch.confidence,
    })
  }

  const resolveStmt = db.prepare(`UPDATE costops_recommendations SET status='resolved' WHERE dedup_key=?`)
  for (const r of result.toResolve) resolveStmt.run(r.dedup_key)

  const expireStmt = db.prepare(`UPDATE costops_recommendations SET status='expired' WHERE dedup_key=?`)
  for (const e of result.toExpire) expireStmt.run(e.dedup_key)

  return { candidates: candidates.length, inserted: result.toInsert.length, touched: result.toTouch.length, resolved: result.toResolve.length, expired: result.toExpire.length }
}

export interface RecommendationListRow {
  dedup_key: string
  type: string
  evidence: Record<string, unknown>
  current_monthly_cost: number
  estimated_monthly_saving: number
  estimated_annual_saving: number
  switching_cost: number
  risk: string
  confidence: string
  human_decision_required: string
  rollback_note: string
  status: string
  first_seen: number
  last_seen: number
  expires_at: number | null
}

/** Read back stored recommendations. 'open' only by default (the likely GET route default view), sorted by estimated saving descending. */
export function listRecommendations(db: Database.Database, opts: { status?: RecommendationStatus; limit?: number } = {}): RecommendationListRow[] {
  const limit = opts.limit ?? 200
  const rows = (
    opts.status
      ? db.prepare(`SELECT * FROM costops_recommendations WHERE status = ? ORDER BY estimated_monthly_saving DESC LIMIT ?`).all(opts.status, limit)
      : db.prepare(`SELECT * FROM costops_recommendations WHERE status = 'open' ORDER BY estimated_monthly_saving DESC LIMIT ?`).all(limit)
  ) as RecommendationRow[]
  return rows.map(r => ({
    dedup_key: r.dedup_key, type: r.type, evidence: deserializeEvidence(r.evidence_json),
    current_monthly_cost: r.current_monthly_cost, estimated_monthly_saving: r.estimated_monthly_saving,
    estimated_annual_saving: r.estimated_annual_saving, switching_cost: r.switching_cost, risk: r.risk, confidence: r.confidence,
    human_decision_required: r.human_decision_required, rollback_note: r.rollback_note, status: r.status,
    first_seen: r.first_seen, last_seen: r.last_seen, expires_at: r.expires_at,
  }))
}
