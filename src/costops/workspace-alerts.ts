// CostOps v0.7/v2 -- Google Workspace payment-failure/suspension signal.
//
// Gmail is NOT reachable from this backend process. An agent-side read-only
// sweep (same pattern as email-ingest.ts's cost receipts) POSTs a structured,
// sanitized entry per detected signal here -- no raw email body/subject/
// sender/message-id is ever stored, only a hash of the message ref, the
// account label, an issue_type, and when it was detected.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CostWarning } from './warnings.js'
import { severityForDays, EXPIRY_THRESHOLDS } from './expiry-checks.js'

export type WorkspaceIssueType = 'payment_failure' | 'suspension_notice' | 'suspended'

export interface WorkspaceAlertEntry {
  account: string             // 'google-private' | 'google-zst' | ...
  issue_type: WorkspaceIssueType
  detected_at: number         // epoch sec -- when the signal (email) was dated
  message_ref: string         // opaque per-email ref; hashed here, never stored raw
  // Gap-fill (card 65da75e6): the actual suspension DEADLINE, when the sweep can read it from
  // the email body (e.g. "suspended on Aug 4"). Optional -- never fabricated when absent.
  suspension_date?: number    // epoch sec
}

export interface WorkspaceAlertRow {
  account: string
  issue_type: WorkspaceIssueType
  detected_at: number
  suspension_date: number | null
}

// A signal older than this is assumed resolved (paid/reinstated) -- never
// treated as "currently ongoing" without a fresh re-detection.
const ACTIVE_WINDOW_SECS = 30 * 24 * 3600

const VALID_ISSUE_TYPES = new Set(['payment_failure', 'suspension_notice', 'suspended'])

export interface IngestWorkspaceAlertResult {
  ingested: number
  errors: Array<{ account: string; reason: string }>
}

/**
 * Idempotently upsert workspace alert signals. Dedup key =
 * `wsalert|<sha256(message_ref)[:32]>`, so re-running the same sweep never
 * duplicates. No raw email content in `entries` is ever persisted.
 */
export function ingestWorkspaceAlerts(
  db: Database.Database,
  entries: WorkspaceAlertEntry[],
  now: number,
  idSalt = 'costops-workspace-alert',
): IngestWorkspaceAlertResult {
  const upsert = db.prepare(`
    INSERT INTO workspace_alerts (account, issue_type, detected_at, suspension_date, message_ref, dedup_key, created_at)
    VALUES (@account, @issue_type, @detected_at, @suspension_date, @ref_hash, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      detected_at=excluded.detected_at, issue_type=excluded.issue_type, suspension_date=excluded.suspension_date
  `)
  const out: IngestWorkspaceAlertResult = { ingested: 0, errors: [] }
  const tx = db.transaction((list: WorkspaceAlertEntry[]) => {
    for (const e of list) {
      if (!e || typeof e.account !== 'string' || !e.account) { out.errors.push({ account: String(e?.account), reason: 'missing account' }); continue }
      if (!VALID_ISSUE_TYPES.has(e.issue_type)) { out.errors.push({ account: e.account, reason: `invalid issue_type '${e.issue_type}'` }); continue }
      if (typeof e.detected_at !== 'number' || !isFinite(e.detected_at)) { out.errors.push({ account: e.account, reason: 'missing/invalid detected_at' }); continue }
      if (e.suspension_date !== undefined && (typeof e.suspension_date !== 'number' || !isFinite(e.suspension_date))) {
        out.errors.push({ account: e.account, reason: 'invalid suspension_date' }); continue
      }
      const refHash = createHash('sha256').update(idSalt).update('|').update(String(e.message_ref)).digest('hex').slice(0, 32)
      upsert.run({
        account: e.account, issue_type: e.issue_type, detected_at: e.detected_at,
        suspension_date: e.suspension_date ?? null,
        ref_hash: refHash, dedup_key: `wsalert|${refHash}`, now,
      })
      out.ingested++
    }
  })
  tx(entries)
  return out
}

/** Alerts detected within the active window -- treated as a currently-relevant signal. */
export function getActiveWorkspaceAlerts(db: Database.Database, now: number): WorkspaceAlertRow[] {
  return db.prepare(`
    SELECT account, issue_type, detected_at, suspension_date FROM workspace_alerts
    WHERE detected_at >= @cutoff ORDER BY detected_at DESC
  `).all({ cutoff: now - ACTIVE_WINDOW_SECS }) as WorkspaceAlertRow[]
}

const ISSUE_MESSAGE: Record<WorkspaceIssueType, string> = {
  payment_failure: 'fizetési hiba a Google Workspace előfizetésen',
  suspension_notice: 'felfüggesztési értesítő érkezett a Google Workspace fiókra',
  suspended: 'a Google Workspace fiók felfüggesztve',
}
const ISSUE_SEVERITY: Record<WorkspaceIssueType, CostWarning['severity']> = {
  payment_failure: 'medium', suspension_notice: 'medium', suspended: 'high',
}

/** One warning per (account, issue_type) currently active, most-recent detection only. */
export function buildWorkspaceAlertWarnings(db: Database.Database, now: number): CostWarning[] {
  const rows = getActiveWorkspaceAlerts(db, now)
  const seen = new Set<string>()
  const warnings: CostWarning[] = []
  for (const r of rows) {
    const key = `${r.account}|${r.issue_type}`
    if (seen.has(key)) continue // rows are DESC by detected_at -- first hit is the most recent
    seen.add(key)

    // Gap-fill (card 65da75e6): when a real suspension DEADLINE is known, the date-based
    // lifecycle warning supersedes the flat flag -- strictly more informative (due_date +
    // severity rising as the date approaches), avoids showing two redundant entries for the
    // same underlying issue. Never fabricated: only fires when suspension_date was actually
    // extracted from the source email, not guessed from a generic grace-period assumption.
    if (r.suspension_date !== null) {
      // v0.8 (card 6f4d1332 §6.4): code carries issue_type too -- previously every date-based
      // row collapsed onto the same 'workspace_suspension_overdue'/'_scheduled' code regardless
      // of whether the underlying signal was a payment_failure, suspension_notice, or an already
      // -suspended account, losing that distinction for any code-keyed consumer (dedup, UI
      // grouping, requirements §6's per-type list). detail.issue_type carried it, but the code
      // itself did not.
      const daysRemaining = Math.floor((r.suspension_date - now) / 86400)
      if (daysRemaining < 0) {
        // Deadline already passed with no re-detection since -- treat as an active suspension,
        // not silently drop it (a stale-but-unresolved deadline is worse, not better).
        warnings.push({
          code: `workspace_${r.issue_type}_overdue`, severity: 'high', provider: 'google-workspace',
          message: `${r.account}: a felfüggesztési határidő (${new Date(r.suspension_date * 1000).toISOString().slice(0, 10)}) már elmúlt, a fiók állapota nem megerősített.`,
          detail: { account: r.account, issue_type: r.issue_type, suspension_date: r.suspension_date },
          warning_type: 'expiry', category: 'productivity', source: 'workspace_alert', confidence: 'measured',
          due_date: new Date(r.suspension_date * 1000).toISOString().slice(0, 10),
          action: 'Ellenőrizd azonnal a Workspace admin konzolt.',
        })
        continue
      }
      const severity = severityForDays(daysRemaining) ?? 'low' // always visible once a real deadline exists, even if >30d out
      warnings.push({
        code: `workspace_${r.issue_type}_scheduled`, severity, provider: 'google-workspace',
        message: `${r.account}: felfüggesztés ${daysRemaining} nap múlva (${new Date(r.suspension_date * 1000).toISOString().slice(0, 10)}), ha a fizetés nem rendeződik.`,
        detail: { account: r.account, issue_type: r.issue_type, suspension_date: r.suspension_date, days_remaining: daysRemaining },
        warning_type: 'expiry', category: 'productivity', source: 'workspace_alert', confidence: 'measured',
        due_date: new Date(r.suspension_date * 1000).toISOString().slice(0, 10),
        current_value: daysRemaining, threshold: EXPIRY_THRESHOLDS.warn, unit: 'day',
        action: 'Rendezd a fizetési módot a Workspace fiókon.',
      })
      continue
    }

    warnings.push({
      code: `workspace_${r.issue_type}`, severity: ISSUE_SEVERITY[r.issue_type], provider: 'google-workspace',
      message: `${r.account}: ${ISSUE_MESSAGE[r.issue_type]}.`,
      detail: { account: r.account, detected_at: r.detected_at },
      warning_type: 'access', category: 'productivity', source: 'workspace_alert', confidence: 'measured',
      action: 'Ellenőrizd a fizetési módot / Workspace admin konzolt.',
    })
  }
  return warnings
}
