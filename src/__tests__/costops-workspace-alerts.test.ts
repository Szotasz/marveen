import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestWorkspaceAlerts, getActiveWorkspaceAlerts, buildWorkspaceAlertWarnings } from '../costops/workspace-alerts.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

describe('workspace alerts ingest', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('ingests a valid entry and is idempotent per message_ref', () => {
    const db = getDb()
    const entry = { account: 'google-private', issue_type: 'payment_failure' as const, detected_at: NOW, message_ref: 'msg-1' }
    expect(ingestWorkspaceAlerts(db, [entry], NOW).ingested).toBe(1)
    ingestWorkspaceAlerts(db, [entry], NOW)
    const rows = db.prepare('SELECT COUNT(*) as n FROM workspace_alerts').get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('rejects an invalid issue_type without throwing', () => {
    const db = getDb()
    const result = ingestWorkspaceAlerts(db, [{ account: 'google-zst', issue_type: 'bogus' as never, detected_at: NOW, message_ref: 'msg-2' }], NOW)
    expect(result.ingested).toBe(0)
    expect(result.errors).toHaveLength(1)
  })

  it('never stores the raw message_ref -- only a hash', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [{ account: 'google-private', issue_type: 'suspended', detected_at: NOW, message_ref: 'super-secret-gmail-id-12345' }], NOW)
    const row = db.prepare('SELECT message_ref FROM workspace_alerts').get() as { message_ref: string }
    expect(row.message_ref).not.toContain('super-secret-gmail-id')
    expect(row.message_ref).toHaveLength(32)
  })

  it('getActiveWorkspaceAlerts excludes stale (>30d) signals', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [
      { account: 'google-private', issue_type: 'payment_failure', detected_at: NOW - 5 * 86400, message_ref: 'recent' },
      { account: 'google-zst', issue_type: 'payment_failure', detected_at: NOW - 60 * 86400, message_ref: 'stale' },
    ], NOW)
    const active = getActiveWorkspaceAlerts(db, NOW)
    expect(active).toHaveLength(1)
    expect(active[0].account).toBe('google-private')
  })

  it('buildWorkspaceAlertWarnings emits one warning per (account, issue_type), most recent only, never fabricated', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [
      { account: 'google-private', issue_type: 'payment_failure', detected_at: NOW - 10 * 86400, message_ref: 'old' },
      { account: 'google-private', issue_type: 'payment_failure', detected_at: NOW - 1 * 86400, message_ref: 'new' },
    ], NOW)
    const warnings = buildWorkspaceAlertWarnings(db, NOW)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('workspace_payment_failure')
    expect(warnings[0].warning_type).toBe('access')
    expect(warnings[0].category).toBe('productivity')
    expect((warnings[0].detail as { detected_at: number }).detected_at).toBe(NOW - 1 * 86400)
  })

  it('emits nothing when there is no signal at all (no noise)', () => {
    const db = getDb()
    expect(buildWorkspaceAlertWarnings(db, NOW)).toEqual([])
  })

  it('suspended is severity high, payment_failure is medium', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [
      { account: 'google-zst', issue_type: 'suspended', detected_at: NOW, message_ref: 'a' },
      { account: 'google-private', issue_type: 'payment_failure', detected_at: NOW, message_ref: 'b' },
    ], NOW)
    const warnings = buildWorkspaceAlertWarnings(db, NOW)
    expect(warnings.find(w => w.code === 'workspace_suspended')!.severity).toBe('high')
    expect(warnings.find(w => w.code === 'workspace_payment_failure')!.severity).toBe('medium')
  })

  // --- Gap-fill (card 65da75e6): suspension-date lifecycle -------------------------------

  it('a real suspension_date supersedes the flat flag with a due_date + days-remaining warning', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [
      { account: 'google-zst', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW + 10 * 86400, message_ref: 'c' },
    ], NOW)
    const warnings = buildWorkspaceAlertWarnings(db, NOW)
    expect(warnings).toHaveLength(1) // no redundant flat workspace_payment_failure entry too
    const w = warnings[0]
    expect(w.code).toBe('workspace_payment_failure_scheduled')
    expect(w.warning_type).toBe('expiry')
    expect(w.due_date).toBe(new Date((NOW + 10 * 86400) * 1000).toISOString().slice(0, 10))
    expect(w.current_value).toBe(10)
  })

  it('severity rises as the suspension date approaches (30/14/7-day ladder)', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [{ account: 'a1', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW + 20 * 86400, message_ref: 'd20' }], NOW)
    ingestWorkspaceAlerts(db, [{ account: 'a2', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW + 10 * 86400, message_ref: 'd10' }], NOW)
    ingestWorkspaceAlerts(db, [{ account: 'a3', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW + 3 * 86400, message_ref: 'd3' }], NOW)
    const warnings = buildWorkspaceAlertWarnings(db, NOW)
    expect(warnings.find(w => (w.detail as { account: string }).account === 'a1')!.severity).toBe('low')
    expect(warnings.find(w => (w.detail as { account: string }).account === 'a2')!.severity).toBe('medium')
    expect(warnings.find(w => (w.detail as { account: string }).account === 'a3')!.severity).toBe('high')
  })

  it('a suspension date far in the future (>30d) is still visible (not silent), just low severity', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [{ account: 'google-zst', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW + 90 * 86400, message_ref: 'far' }], NOW)
    const w = buildWorkspaceAlertWarnings(db, NOW)[0]
    expect(w.code).toBe('workspace_payment_failure_scheduled')
    expect(w.severity).toBe('low')
  })

  it('a suspension date already in the past (no re-detection since) is treated as overdue, not dropped', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [{ account: 'google-zst', issue_type: 'payment_failure', detected_at: NOW, suspension_date: NOW - 5 * 86400, message_ref: 'overdue' }], NOW)
    const w = buildWorkspaceAlertWarnings(db, NOW)[0]
    expect(w.code).toBe('workspace_payment_failure_overdue')
    expect(w.severity).toBe('high')
  })

  it('rejects an invalid suspension_date type without throwing', () => {
    const db = getDb()
    const result = ingestWorkspaceAlerts(db, [{ account: 'google-zst', issue_type: 'payment_failure', detected_at: NOW, suspension_date: 'not-a-number' as unknown as number, message_ref: 'bad' }], NOW)
    expect(result.ingested).toBe(0)
    expect(result.errors).toHaveLength(1)
  })

  it('no suspension_date -- falls back to the existing flat flag exactly as before (regression check)', () => {
    const db = getDb()
    ingestWorkspaceAlerts(db, [{ account: 'google-zst', issue_type: 'suspended', detected_at: NOW, message_ref: 'flat' }], NOW)
    const w = buildWorkspaceAlertWarnings(db, NOW)[0]
    expect(w.code).toBe('workspace_suspended')
    expect(w.due_date).toBeUndefined()
  })
})
