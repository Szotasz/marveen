// CostOps Phase 3 (GAP-12) -- persistence for Anvil's alerts.ts lifecycle
// core. alerts.ts is pure computation (detectors + reconcileAlerts); this is
// the thin DB layer that applies an AlertReconcileResult and serves reads/
// acknowledgement. The actual SIGNAL-GATHERING orchestration (running all 13
// detectors against real ledger/forecast/fx/sync data each round) is a
// separate, larger piece -- deferred to alerts-capture.ts (Anvil, per
// alert dispatch) so this module can land now and alerts-capture.ts
// slots in later without touching this file's contract.

import type Database from 'better-sqlite3'
import { serializeEvidence, deserializeEvidence, type AlertRecord, type AlertReconcileResult, reconcileAlerts, type AlertCandidate } from './alerts.js'

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

function rowToRecord(row: AlertRow): AlertRecord {
  return {
    dedup_key: row.dedup_key, type: row.type as AlertRecord['type'], severity: row.severity as AlertRecord['severity'],
    evidence: deserializeEvidence(row.evidence_json), first_seen: row.first_seen, last_seen: row.last_seen,
    acknowledged_at: row.acknowledged_at, acknowledged_by: row.acknowledged_by, resolved_at: row.resolved_at,
    recurrence_count: row.recurrence_count, owner: row.owner, cooldown_until: row.cooldown_until,
  }
}

/** All alerts currently stored (any state), for feeding into reconcileAlerts as `existing`. */
export function listAllAlerts(db: Database.Database): AlertRecord[] {
  return (db.prepare(`SELECT * FROM costops_alerts`).all() as AlertRow[]).map(rowToRecord)
}

export interface ListAlertsOptions {
  status?: 'active' | 'resolved' | 'all'
  type?: string
}

/** Alerts for API/dashboard consumption -- defaults to active (unresolved) only. */
export function listAlerts(db: Database.Database, opts: ListAlertsOptions = {}): AlertRecord[] {
  const status = opts.status ?? 'active'
  const conditions: string[] = []
  const params: unknown[] = []
  if (status === 'active') conditions.push('resolved_at IS NULL')
  if (status === 'resolved') conditions.push('resolved_at IS NOT NULL')
  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM costops_alerts ${where} ORDER BY last_seen DESC`).all(...params) as AlertRow[]
  return rows.map(rowToRecord)
}

/**
 * Apply an AlertReconcileResult (insert/touch/resolve) to the DB in one
 * transaction. Pure DB write, no detection logic -- the caller already ran
 * reconcileAlerts() against listAllAlerts()'s current state.
 */
export function applyAlertReconciliation(db: Database.Database, result: AlertReconcileResult, now: number): void {
  const insertStmt = db.prepare(`
    INSERT INTO costops_alerts
      (type, severity, evidence_json, dedup_key, first_seen, last_seen, acknowledged_at, acknowledged_by,
       resolved_at, recurrence_count, owner, cooldown_until, created_at)
    VALUES (@type, @severity, @evidence_json, @dedup_key, @first_seen, @last_seen, NULL, NULL,
       NULL, @recurrence_count, NULL, @cooldown_until, @now)
  `)
  const touchStmt = db.prepare(`
    UPDATE costops_alerts SET last_seen = @last_seen, severity = @severity, evidence_json = @evidence_json,
      resolved_at = @resolved_at, recurrence_count = @recurrence_count, cooldown_until = @cooldown_until
    WHERE dedup_key = @dedup_key
  `)
  const resolveStmt = db.prepare(`UPDATE costops_alerts SET resolved_at = @resolved_at WHERE dedup_key = @dedup_key`)

  const tx = db.transaction(() => {
    for (const r of result.toInsert) {
      insertStmt.run({
        type: r.type, severity: r.severity, evidence_json: serializeEvidence(r.evidence), dedup_key: r.dedup_key,
        first_seen: r.first_seen, last_seen: r.last_seen, recurrence_count: r.recurrence_count,
        cooldown_until: r.cooldown_until, now,
      })
    }
    for (const t of result.toTouch) {
      touchStmt.run({
        dedup_key: t.dedup_key, last_seen: t.patch.last_seen, severity: t.patch.severity,
        evidence_json: serializeEvidence(t.patch.evidence), resolved_at: t.patch.resolved_at,
        recurrence_count: t.patch.recurrence_count, cooldown_until: t.patch.cooldown_until,
      })
    }
    for (const r of result.toResolve) {
      resolveStmt.run({ dedup_key: r.dedup_key, resolved_at: r.resolved_at })
    }
  })
  tx()
}

/** Convenience: detect candidates elsewhere, then reconcile+persist in one call. */
export function reconcileAndPersist(db: Database.Database, candidates: AlertCandidate[], now: number, cooldownSeconds?: number): AlertReconcileResult {
  const existing = listAllAlerts(db)
  const result = reconcileAlerts(existing, candidates, now, cooldownSeconds)
  applyAlertReconciliation(db, result, now)
  return result
}

export interface AcknowledgeResult {
  ok: boolean
  error?: string
  status?: number
}

/** Operator acknowledges an active alert (never clears resolution/recurrence). */
export function acknowledgeAlertByKey(db: Database.Database, dedupKey: string, actor: string, now: number): AcknowledgeResult {
  const existing = db.prepare(`SELECT dedup_key FROM costops_alerts WHERE dedup_key = ?`).get(dedupKey)
  if (!existing) return { ok: false, error: `no alert with dedup_key '${dedupKey}'`, status: 404 }
  db.prepare(`UPDATE costops_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE dedup_key = ?`).run(now, actor, dedupKey)
  return { ok: true }
}

/** Manual/explicit early resolve (an operator dismissing before the underlying condition clears itself). */
export function resolveAlertByKey(db: Database.Database, dedupKey: string, now: number): AcknowledgeResult {
  const existing = db.prepare(`SELECT dedup_key FROM costops_alerts WHERE dedup_key = ?`).get(dedupKey)
  if (!existing) return { ok: false, error: `no alert with dedup_key '${dedupKey}'`, status: 404 }
  db.prepare(`UPDATE costops_alerts SET resolved_at = ? WHERE dedup_key = ?`).run(now, dedupKey)
  return { ok: true }
}
