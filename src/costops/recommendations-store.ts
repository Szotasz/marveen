// CostOps Phase 4 (GAP-17) -- persistence for Anvil's optimization.ts lifecycle
// core. optimization.ts is pure computation (detectors + reconcileRecommendations);
// this is the thin DB layer that applies a RecommendationReconcileResult and
// serves reads/accept/dismiss. Same split as alerts.ts/alerts-store.ts. The
// actual SIGNAL-GATHERING orchestration (running all 9 detectors against real
// subscription/ledger/utilisation data each round) is a separate piece
// (optimization-capture.ts, Anvil, still in progress) -- deferred so this
// module can land now and slot in later without touching this file's contract.

import type Database from 'better-sqlite3'
import {
  serializeEvidence, deserializeEvidence,
  type RecommendationRecord, type RecommendationReconcileResult, reconcileRecommendations,
  type RecommendationCandidate, acceptRecommendation, dismissRecommendation,
} from './optimization.js'

interface RecommendationRow {
  type: string
  evidence_json: string
  dedup_key: string
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

function rowToRecord(row: RecommendationRow): RecommendationRecord {
  return {
    type: row.type as RecommendationRecord['type'], evidence: deserializeEvidence(row.evidence_json), dedup_key: row.dedup_key,
    current_monthly_cost: row.current_monthly_cost, estimated_monthly_saving: row.estimated_monthly_saving,
    estimated_annual_saving: row.estimated_annual_saving, switching_cost: row.switching_cost,
    risk: row.risk as RecommendationRecord['risk'], confidence: row.confidence as RecommendationRecord['confidence'],
    human_decision_required: row.human_decision_required, rollback_note: row.rollback_note,
    status: row.status as RecommendationRecord['status'], status_changed_at: row.status_changed_at, status_changed_by: row.status_changed_by,
    expires_at: row.expires_at, first_seen: row.first_seen, last_seen: row.last_seen,
  }
}

/** All recommendations currently stored (any state), for feeding into reconcileRecommendations as `existing`. */
export function listAllRecommendations(db: Database.Database): RecommendationRecord[] {
  return (db.prepare(`SELECT * FROM costops_recommendations`).all() as RecommendationRow[]).map(rowToRecord)
}

export interface ListRecommendationsOptions {
  status?: 'open' | 'accepted' | 'dismissed' | 'resolved' | 'expired' | 'all'
  type?: string
}

/** Recommendations for API/dashboard consumption -- defaults to 'open' only. */
export function listRecommendations(db: Database.Database, opts: ListRecommendationsOptions = {}): RecommendationRecord[] {
  const status = opts.status ?? 'open'
  const conditions: string[] = []
  const params: unknown[] = []
  if (status !== 'all') { conditions.push('status = ?'); params.push(status) }
  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM costops_recommendations ${where} ORDER BY last_seen DESC`).all(...params) as RecommendationRow[]
  return rows.map(rowToRecord)
}

/**
 * Apply a RecommendationReconcileResult to the DB in one transaction. Pure DB
 * write, no detection logic -- the caller already ran reconcileRecommendations()
 * against listAllRecommendations()'s current state.
 */
export function applyRecommendationReconciliation(db: Database.Database, result: RecommendationReconcileResult, now: number): void {
  const insertStmt = db.prepare(`
    INSERT INTO costops_recommendations
      (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving,
       switching_cost, risk, confidence, human_decision_required, rollback_note, status,
       status_changed_at, status_changed_by, expires_at, first_seen, last_seen, created_at)
    VALUES (@type, @evidence_json, @dedup_key, @current_monthly_cost, @estimated_monthly_saving, @estimated_annual_saving,
       @switching_cost, @risk, @confidence, @human_decision_required, @rollback_note, @status,
       @status_changed_at, @status_changed_by, @expires_at, @first_seen, @last_seen, @now)
  `)
  const touchStmt = db.prepare(`
    UPDATE costops_recommendations SET last_seen = @last_seen, evidence_json = @evidence_json,
      current_monthly_cost = @current_monthly_cost, estimated_monthly_saving = @estimated_monthly_saving,
      estimated_annual_saving = @estimated_annual_saving, switching_cost = @switching_cost,
      risk = @risk, confidence = @confidence
    WHERE dedup_key = @dedup_key
  `)
  const resolveStmt = db.prepare(`UPDATE costops_recommendations SET status = 'resolved', status_changed_at = @now WHERE dedup_key = @dedup_key`)
  const expireStmt = db.prepare(`UPDATE costops_recommendations SET status = 'expired', status_changed_at = @now WHERE dedup_key = @dedup_key`)

  const tx = db.transaction(() => {
    for (const r of result.toInsert) {
      insertStmt.run({
        type: r.type, evidence_json: serializeEvidence(r.evidence), dedup_key: r.dedup_key,
        current_monthly_cost: r.current_monthly_cost, estimated_monthly_saving: r.estimated_monthly_saving,
        estimated_annual_saving: r.estimated_annual_saving, switching_cost: r.switching_cost,
        risk: r.risk, confidence: r.confidence, human_decision_required: r.human_decision_required,
        rollback_note: r.rollback_note, status: r.status, status_changed_at: r.status_changed_at,
        status_changed_by: r.status_changed_by, expires_at: r.expires_at, first_seen: r.first_seen, last_seen: r.last_seen, now,
      })
    }
    for (const t of result.toTouch) {
      touchStmt.run({
        dedup_key: t.dedup_key, last_seen: t.patch.last_seen, evidence_json: serializeEvidence(t.patch.evidence),
        current_monthly_cost: t.patch.current_monthly_cost, estimated_monthly_saving: t.patch.estimated_monthly_saving,
        estimated_annual_saving: t.patch.estimated_annual_saving, switching_cost: t.patch.switching_cost,
        risk: t.patch.risk, confidence: t.patch.confidence,
      })
    }
    for (const r of result.toResolve) resolveStmt.run({ dedup_key: r.dedup_key, now })
    for (const r of result.toExpire) expireStmt.run({ dedup_key: r.dedup_key, now })
  })
  tx()
}

/** Convenience: detect candidates elsewhere, then reconcile+persist in one call -- the shape optimization-capture.ts (Anvil, in progress) will call once it lands. */
export function reconcileAndPersistRecommendations(db: Database.Database, candidates: RecommendationCandidate[], now: number, expirySeconds?: number): RecommendationReconcileResult {
  const existing = listAllRecommendations(db)
  const result = reconcileRecommendations(existing, candidates, now, expirySeconds)
  applyRecommendationReconciliation(db, result, now)
  return result
}

export interface RecommendationDecisionResult {
  ok: boolean
  error?: string
  status?: number
  recommendation?: RecommendationRecord
}

function loadOne(db: Database.Database, dedupKey: string): RecommendationRecord | null {
  const row = db.prepare(`SELECT * FROM costops_recommendations WHERE dedup_key = ?`).get(dedupKey) as RecommendationRow | undefined
  return row ? rowToRecord(row) : null
}

function writeStatus(db: Database.Database, r: RecommendationRecord): void {
  db.prepare(`UPDATE costops_recommendations SET status = ?, status_changed_at = ?, status_changed_by = ? WHERE dedup_key = ?`)
    .run(r.status, r.status_changed_at, r.status_changed_by, r.dedup_key)
}

/** Human accepts a recommendation (intends to act on it outside this codebase) -- frozen from further re-detection thereafter (optimization.ts's reconcile). */
export function acceptRecommendationByKey(db: Database.Database, dedupKey: string, actor: string, now: number): RecommendationDecisionResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required to accept a recommendation', status: 400 }
  const existing = loadOne(db, dedupKey)
  if (!existing) return { ok: false, error: `no recommendation with dedup_key '${dedupKey}'`, status: 404 }
  const updated = acceptRecommendation(existing, actor, now)
  writeStatus(db, updated)
  return { ok: true, recommendation: updated }
}

/** Human dismisses a recommendation (decided against it) -- frozen from further re-detection thereafter. */
export function dismissRecommendationByKey(db: Database.Database, dedupKey: string, actor: string, now: number): RecommendationDecisionResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required to dismiss a recommendation', status: 400 }
  const existing = loadOne(db, dedupKey)
  if (!existing) return { ok: false, error: `no recommendation with dedup_key '${dedupKey}'`, status: 404 }
  const updated = dismissRecommendation(existing, actor, now)
  writeStatus(db, updated)
  return { ok: true, recommendation: updated }
}
