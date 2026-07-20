import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { monthWindow } from '../costops/ledger.js'
import { initAlertsSchema } from '../costops/alerts.js'
import { initInvoiceSchema } from '../costops/invoice.js'
import {
  classifyErrorCode,
  gatherAlertCandidates,
  captureAlerts,
  listAlerts,
} from '../costops/alerts-capture.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

// gatherAlertCandidates always queries costops_invoices (GAP-14's
// missing_invoice signal) -- every test that exercises it needs the table,
// same assumed-precondition convention as costops_alerts itself.
function initDb(): void {
  initDatabase(':memory:')
  initInvoiceSchema(getDb())
}

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [],
    budgets: [
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 1000, currency: 'HUF', warning_threshold: 0.8, hard_threshold: 1.0 },
    ],
    ...over,
  }
}

function insertSource(db: ReturnType<typeof getDb>, id: string, provider: string, source_type = 'usage'): void {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'HUF', 1, ?, ?)`).run(id, id, provider, source_type, NOW, NOW)
}

function insertLine(db: ReturnType<typeof getDb>, opts: {
  source: string; start: number; end: number; amount: number; confidence: string
  actualSource?: string | null; dedupKey: string
}): void {
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at, actual_source)
    VALUES (@source, @start, @end, 'usage', @amount, 'HUF', @confidence, @now, @dedupKey, @now, @actualSource)
  `).run({ source: opts.source, start: opts.start, end: opts.end, amount: opts.amount, confidence: opts.confidence, now: NOW, dedupKey: opts.dedupKey, actualSource: opts.actualSource ?? null })
}

describe('classifyErrorCode', () => {
  it('classifies credential-flavored codes', () => {
    expect(classifyErrorCode('401')).toBe('credential_error')
    expect(classifyErrorCode('invalid_api_key')).toBe('credential_error')
    expect(classifyErrorCode('Unauthorized')).toBe('credential_error')
  })
  it('classifies permission-flavored codes', () => {
    expect(classifyErrorCode('403')).toBe('permission_error')
    expect(classifyErrorCode('Forbidden')).toBe('permission_error')
  })
  it('leaves unrecognized codes unclassified (never guessed)', () => {
    expect(classifyErrorCode('ETIMEDOUT')).toBeNull()
    expect(classifyErrorCode('balance_error')).toBeNull()
    expect(classifyErrorCode(null)).toBeNull()
  })
})

describe('gatherAlertCandidates -- budget signals', () => {
  beforeEach(() => { initDb() })

  it('fires budget_threshold once spend crosses the hard threshold', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    insertLine(db, { source: 'anthropic-max', start: win.start, end: win.end, amount: 1200, confidence: 'manual', dedupKey: 'l1' })
    const candidates = gatherAlertCandidates(db, cfg(), NOW)
    const budget = candidates.find(c => c.type === 'budget_threshold')
    expect(budget?.severity).toBe('critical')
  })

  it('does not fire when spend is well under the warning threshold', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    insertLine(db, { source: 'anthropic-max', start: win.start, end: win.end, amount: 100, confidence: 'manual', dedupKey: 'l1' })
    const candidates = gatherAlertCandidates(db, cfg(), NOW)
    expect(candidates.find(c => c.type === 'budget_threshold')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- balance exhaustion (entitlements)', () => {
  beforeEach(() => { initDb() })

  it('fires critical once the stored forecast_exhaustion_at has passed', () => {
    const db = getDb()
    db.prepare(`
      INSERT INTO entitlements (provider, product, billing_period, entitlement_type, remaining, included_unit, usage_source, forecast_exhaustion_at, status, dedup_key, last_updated, created_at)
      VALUES ('deepseek', 'deepseek-api', 'ongoing', 'prepaid_balance', 0.5, 'USD', 'provider_api', @past, 'critical', 'deepseek|prepaid_balance', @now, @now)
    `).run({ past: NOW - 86400, now: NOW })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const a = candidates.find(c => c.type === 'balance_exhaustion')
    expect(a?.severity).toBe('critical')
    expect(a?.evidence.provider).toBe('deepseek')
  })

  it('does not fire with no forecast_exhaustion_at recorded', () => {
    const db = getDb()
    db.prepare(`
      INSERT INTO entitlements (provider, product, billing_period, entitlement_type, remaining, included_unit, usage_source, forecast_exhaustion_at, status, dedup_key, last_updated, created_at)
      VALUES ('deepseek', 'deepseek-api', 'ongoing', 'prepaid_balance', 50, 'USD', 'provider_api', NULL, 'ok', 'deepseek|prepaid_balance', @now, @now)
    `).run({ now: NOW })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'balance_exhaustion')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- sync/credential (import_runs)', () => {
  beforeEach(() => { initDb() })

  it('fires failed_sync (critical) + credential_permission_error together for a 401', () => {
    const db = getDb()
    db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count, error_code) VALUES ('openai','openai-cost',@now,@now,'error',0,'401')`).run({ now: NOW })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const failed = candidates.find(c => c.type === 'failed_sync')
    const cred = candidates.find(c => c.type === 'credential_permission_error')
    expect(failed?.severity).toBe('critical')
    expect(cred?.severity).toBe('critical')
    expect(cred?.evidence.issue).toBe('credential_error')
  })

  it('fires stale_collector (capped at warning) for an old-but-ok sync', () => {
    const db = getDb()
    const old = NOW - 10 * 86400
    db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count, error_code) VALUES ('render','render-plan',@old,@old,'ok',3,NULL)`).run({ old })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const stale = candidates.find(c => c.type === 'stale_collector')
    expect(stale?.severity).toBe('warning')
    expect(candidates.find(c => c.type === 'credential_permission_error')).toBeUndefined()
  })

  it('does not fire for a fresh, ok sync', () => {
    const db = getDb()
    db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count, error_code) VALUES ('github','github-billing',@now,@now,'ok',1,NULL)`).run({ now: NOW })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'stale_collector' || c.type === 'failed_sync')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- reconciliation mismatch', () => {
  beforeEach(() => { initDb() })

  it('fires when provider API and invoice amounts diverge past tolerance', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting', start: win.start, end: win.end, amount: 10000, confidence: 'provider_api', actualSource: 'provider_api', dedupKey: 'r1' })
    insertLine(db, { source: 'render-hosting', start: win.start, end: win.end, amount: 12000, confidence: 'actual_invoice', actualSource: 'email_invoice', dedupKey: 'r2' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const a = candidates.find(c => c.type === 'reconciliation_mismatch')
    expect(a).toBeDefined()
    expect(a?.evidence.source_id).toBe('render-hosting')
  })

  it('does not fire when the two amounts are within tolerance', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render', 'hosting')
    insertLine(db, { source: 'render-hosting', start: win.start, end: win.end, amount: 10000, confidence: 'provider_api', actualSource: 'provider_api', dedupKey: 'r1' })
    insertLine(db, { source: 'render-hosting', start: win.start, end: win.end, amount: 10050, confidence: 'actual_invoice', actualSource: 'email_invoice', dedupKey: 'r2' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'reconciliation_mismatch')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- new source / long estimate-only', () => {
  beforeEach(() => { initDb() })

  it('flags a source whose earliest activity is THIS month as new_unknown_source', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'brand-new-saas', 'other', 'saas')
    insertLine(db, { source: 'brand-new-saas', start: win.start, end: win.end, amount: 500, confidence: 'manual', dedupKey: 'n1' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const a = candidates.find(c => c.type === 'new_unknown_source')
    expect(a?.evidence.source_id).toBe('brand-new-saas')
  })

  it('does NOT flag a source with older history as new', () => {
    const db = getDb()
    const winPrev = monthWindow(NOW - 60 * 86400)
    insertSource(db, 'old-hosting', 'render', 'hosting')
    insertLine(db, { source: 'old-hosting', start: winPrev.start, end: winPrev.end, amount: 500, confidence: 'manual', dedupKey: 'o1' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'new_unknown_source' && c.evidence.source_id === 'old-hosting')).toBeUndefined()
  })

  it('flags long_estimate_only_source after 3 consecutive manual-only periods', () => {
    const db = getDb()
    insertSource(db, 'always-manual', 'other', 'saas')
    const months = [NOW, NOW - 32 * 86400, NOW - 64 * 86400]
    months.forEach((t, i) => {
      const w = monthWindow(t)
      insertLine(db, { source: 'always-manual', start: w.start, end: w.end, amount: 500, confidence: 'manual', dedupKey: `m${i}` })
    })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const a = candidates.find(c => c.type === 'long_estimate_only_source')
    expect(a?.evidence.consecutive_estimate_only_months).toBe(3)
  })

  it('does not flag long_estimate_only_source with fewer than 3 periods of history', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'too-new-to-tell', 'other', 'saas')
    insertLine(db, { source: 'too-new-to-tell', start: win.start, end: win.end, amount: 500, confidence: 'manual', dedupKey: 'q1' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'long_estimate_only_source')).toBeUndefined()
  })

  it('does not flag long_estimate_only_source once a provider_api actual has landed', () => {
    const db = getDb()
    insertSource(db, 'now-real', 'render', 'hosting')
    const months = [NOW, NOW - 32 * 86400, NOW - 64 * 86400]
    months.forEach((t, i) => {
      const w = monthWindow(t)
      insertLine(db, { source: 'now-real', start: w.start, end: w.end, amount: 500, confidence: i === 0 ? 'provider_api' : 'manual', dedupKey: `p${i}` })
    })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'long_estimate_only_source' && c.evidence.source_id === 'now-real')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- unusual spend growth', () => {
  beforeEach(() => { initDb() })

  it('fires when current month spend grows past the threshold vs the previous month', () => {
    const db = getDb()
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    const winPrev = monthWindow(NOW - 32 * 86400)
    const winCur = monthWindow(NOW)
    insertLine(db, { source: 'anthropic-max', start: winPrev.start, end: winPrev.end, amount: 1000, confidence: 'manual', dedupKey: 'g-prev' })
    insertLine(db, { source: 'anthropic-max', start: winCur.start, end: winCur.end, amount: 2000, confidence: 'manual', dedupKey: 'g-cur' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'unusual_spend_growth' && c.evidence.key === 'global')).toBeDefined()
  })

  it('does not fire without a previous month to compare against (never fabricated baseline)', () => {
    const db = getDb()
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    const winCur = monthWindow(NOW)
    insertLine(db, { source: 'anthropic-max', start: winCur.start, end: winCur.end, amount: 2000, confidence: 'manual', dedupKey: 'g-cur' })
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'unusual_spend_growth')).toBeUndefined()
  })
})

describe('gatherAlertCandidates -- subscription utilization with no config present', () => {
  it('is empty, never fabricated, when no costops-subscriptions.json exists', () => {
    initDb()
    const db = getDb()
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.filter(c => c.type === 'subscription_utilization')).toEqual([])
  })
})

describe('gatherAlertCandidates -- missing invoice (GAP-14 wiring)', () => {
  beforeEach(() => { initDb() })

  function insertInvoice(db: ReturnType<typeof getDb>, sourceId: string, periodEnd: number): void {
    db.prepare(`
      INSERT INTO costops_invoices (source_id, provider, billing_period_start, billing_period_end, currency, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount, status, dedup_key, recorded_at, created_at)
      VALUES (?, 'render', ?, ?, 'HUF', 100, 0, 0, 0, 0, 0, 100, 'recorded', ?, ?, ?)
    `).run(sourceId, periodEnd - 30 * 86400, periodEnd, `render|ref-${periodEnd}|x`, NOW, NOW)
  }

  it('is empty with fewer than 2 recorded invoices -- no inferable cadence', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertInvoice(db, 'render-hosting', NOW - 60 * 86400)
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'missing_invoice')).toBeUndefined()
  })

  it('fires once the inferred next-invoice date has passed with no newer invoice recorded', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertInvoice(db, 'render-hosting', NOW - 120 * 86400) // ~4 months ago
    insertInvoice(db, 'render-hosting', NOW - 90 * 86400)  // ~3 months ago, 30-day gap
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    const a = candidates.find(c => c.type === 'missing_invoice')
    expect(a).toBeDefined()
    expect(a?.evidence.source_id).toBe('render-hosting')
  })

  it('does not fire once a recent invoice pushes the inferred cadence past now', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertInvoice(db, 'render-hosting', NOW - 60 * 86400)
    insertInvoice(db, 'render-hosting', NOW - 30 * 86400)
    insertInvoice(db, 'render-hosting', NOW - 2 * 86400) // just landed
    const candidates = gatherAlertCandidates(db, cfg({ budgets: [] }), NOW)
    expect(candidates.find(c => c.type === 'missing_invoice')).toBeUndefined()
  })
})

describe('captureAlerts persistence round-trip', () => {
  beforeEach(() => { initDb(); initAlertsSchema(getDb()) })

  it('inserts a new alert on first capture', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    insertLine(db, { source: 'anthropic-max', start: win.start, end: win.end, amount: 1200, confidence: 'manual', dedupKey: 'l1' })
    const summary = captureAlerts(db, cfg(), NOW)
    expect(summary.inserted).toBeGreaterThanOrEqual(1)
    const active = listAlerts(db)
    expect(active.some(a => a.type === 'budget_threshold' && a.severity === 'critical')).toBe(true)
  })

  it('dedups on a second capture with the same condition -- no duplicate row, only a touch', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    insertLine(db, { source: 'anthropic-max', start: win.start, end: win.end, amount: 1200, confidence: 'manual', dedupKey: 'l1' })
    captureAlerts(db, cfg(), NOW)
    const second = captureAlerts(db, cfg(), NOW + 3600)
    expect(second.inserted).toBe(0)
    const rows = db.prepare(`SELECT COUNT(*) as n FROM costops_alerts WHERE type = 'budget_threshold'`).get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('resolves an alert once its condition disappears', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'anthropic-max', 'anthropic', 'subscription')
    insertLine(db, { source: 'anthropic-max', start: win.start, end: win.end, amount: 1200, confidence: 'manual', dedupKey: 'l1' })
    captureAlerts(db, cfg(), NOW)
    // spend drops back under the budget (e.g. a void/correction happened) -- simulate by
    // voiding the line so the source no longer contributes to operational spend.
    db.prepare(`UPDATE cost_line_items SET voided_at = ? WHERE dedup_key = 'l1'`).run(NOW + 100)
    const summary = captureAlerts(db, cfg(), NOW + 3600)
    expect(summary.resolved).toBeGreaterThanOrEqual(1)
    const unresolved = listAlerts(db)
    expect(unresolved.find(a => a.type === 'budget_threshold')).toBeUndefined()
    const all = listAlerts(db, { includeResolved: true })
    const resolvedRow = all.find(a => a.type === 'budget_threshold')
    expect(resolvedRow?.resolved_at).not.toBeNull()
  })
})
