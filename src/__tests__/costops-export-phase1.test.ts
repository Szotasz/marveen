import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncFixedCostsToLedger, monthWindow, getCostSummary } from '../costops/ledger.js'
import { captureForecastSnapshots } from '../costops/forecast-capture.js'
import {
  exportLedgerJson,
  exportLedgerCsv,
  exportSourceInventory,
  sourceInventoryToCsv,
  exportProviderSummary,
  providerSummaryToCsv,
  exportCategorySummary,
  categorySummaryToCsv,
  exportBudgetVariance,
  exportReconciliationReport,
  reconciliationReportToCsv,
  exportForecastHistory,
  exportDataQualityReport,
  exportMonthlySnapshot,
  exportAlerts,
  alertsToCsv,
  objectsToCsv,
} from '../costops/export.js'
import { reconcileAndPersist } from '../costops/alerts-store.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
      { source_id: 'render-hosting', name: 'Render', provider: 'render', source_type: 'hosting', amount: 12000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, currency: 'HUF', warning_threshold: 0.8, hard_threshold: 1.0 },
    ],
    ...over,
  }
}

describe('objectsToCsv', () => {
  it('renders a header row + escaped rows', () => {
    const csv = objectsToCsv([{ a: 'x,y', b: 2 }], ['a', 'b'])
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('a,b')
    expect(lines[1]).toBe('"x,y",2')
  })
})

describe('export meta envelope (GAP-18: schema_version + generated_at on every export)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('exportLedgerJson carries schema_version + generated_at + scope + month', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportLedgerJson(db, NOW, { month: '2026-07' })
    expect(exp.meta.schema_version).toBe(1)
    expect(exp.meta.generated_at).toBe(NOW)
    expect(exp.meta.scope).toBe('ledger')
    expect(exp.meta.month).toBe('2026-07')
    expect(exp.rows).toHaveLength(2)
  })

  it('exportLedgerCsv wraps the same CSV rowsToCsv produces, with meta alongside', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportLedgerCsv(db, NOW, { month: '2026-07' })
    expect(exp.meta.scope).toBe('ledger')
    expect(exp.csv.split('\n')[0]).toBe('provider,source_type,service_name,period,amount,currency,confidence,original_amount,original_currency')
  })
})

describe('exportSourceInventory', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('never leaks a raw account_ref or secret field', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportSourceInventory(db, cfg(), NOW, { credentialChecker: () => false })
    expect(exp.meta.scope).toBe('source_inventory')
    expect(exp.sources.length).toBeGreaterThan(0)
    for (const s of exp.sources) {
      expect(Object.keys(s)).not.toContain('account_ref')
      expect(Object.keys(s)).not.toContain('secret')
    }
  })

  it('sourceInventoryToCsv renders without throwing on real data', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportSourceInventory(db, cfg(), NOW, { credentialChecker: () => false })
    const csv = sourceInventoryToCsv(exp.sources)
    expect(csv.split('\n')[0]).toBe('source_id,name,provider,source_type,lifecycle,provenance,collection_method,freshness,sync_cadence,owner,operational_inclusion_rule,manual_fallback,blocker')
  })
})

describe('exportProviderSummary / exportCategorySummary -- match getCostSummary (same source, so totals agree)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('provider_breakdown is literally getCostSummary().operational.provider_breakdown', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const summary = getCostSummary(db, cfg(), NOW)
    const exp = exportProviderSummary(db, cfg(), NOW, { month: '2026-07' })
    expect(exp.provider_breakdown).toEqual(summary.operational.provider_breakdown)
    expect(exp.operational_spend).toBe(summary.operational_spend)
  })

  it('category summary aggregates by source_type and sums to the same total as provider summary', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const providerExp = exportProviderSummary(db, cfg(), NOW, { month: '2026-07' })
    const categoryExp = exportCategorySummary(db, NOW, { month: '2026-07' })
    const categoryTotal = categoryExp.categories.reduce((s, c) => s + c.spend, 0)
    expect(Math.round(categoryTotal * 100) / 100).toBe(Math.round(providerExp.operational_spend * 100) / 100)
    expect(categoryExp.categories.map(c => c.source_type).sort()).toEqual(['hosting', 'subscription'])
  })

  it('CSV variants render', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const providerExp = exportProviderSummary(db, cfg(), NOW, { month: '2026-07' })
    const categoryExp = exportCategorySummary(db, NOW, { month: '2026-07' })
    expect(providerSummaryToCsv(providerExp.provider_breakdown).split('\n')[0]).toBe('provider,spend,confidence')
    expect(categorySummaryToCsv(categoryExp.categories).split('\n')[0]).toBe('source_type,spend')
  })
})

describe('exportBudgetVariance', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('computes spend_variance and forecast_variance against the configured budget', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW) // 22000 + 12000 = 34000 operational spend, budget 60000
    const exp = exportBudgetVariance(db, cfg(), NOW, { month: '2026-07' })
    expect(exp.budget).not.toBeNull()
    expect(exp.budget!.spend_variance).toBe(34000 - 60000)
  })

  it('is null when no budget is configured -- never fabricated', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({ budgets: [] }), NOW)
    const exp = exportBudgetVariance(db, cfg({ budgets: [] }), NOW, { month: '2026-07' })
    expect(exp.budget).toBeNull()
  })
})

describe('exportReconciliationReport', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('wraps buildReconciliation output with meta', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportReconciliationReport(db, NOW, '2026-07')
    expect(exp.meta.scope).toBe('reconciliation_report')
    expect(exp.meta.month).toBe('2026-07')
    expect(exp.sources.length).toBeGreaterThan(0)
  })

  it('CSV variant renders', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportReconciliationReport(db, NOW, '2026-07')
    expect(reconciliationReportToCsv(exp.sources).split('\n')[0]).toBe('source_id,name,provider,month,expected_amount,observed_provider_amount,invoice_amount,operationally_selected_amount,variance,variance_reason,status')
  })
})

describe('exportForecastHistory', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('reflects captured forecast snapshots for the month', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    captureForecastSnapshots(db, NOW)
    const exp = exportForecastHistory(db, NOW, { month: '2026-07' })
    expect(exp.meta.scope).toBe('forecast_history')
    expect(exp.snapshots.length).toBeGreaterThan(0)
    expect(exp.snapshots.every(s => s.month === '2026-07')).toBe(true)
  })

  it('is empty (never fabricated) before any capture has run', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportForecastHistory(db, NOW, { month: '2026-07' })
    expect(exp.snapshots).toEqual([])
  })
})

describe('exportDataQualityReport', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('matches getCostSummary confidence/breakdown/freshness, plus per-freshness source counts', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const summary = getCostSummary(db, cfg(), NOW)
    const exp = exportDataQualityReport(db, cfg(), NOW, { month: '2026-07' })
    expect(exp.confidence_breakdown).toEqual(summary.confidence_breakdown)
    expect(exp.breakdown).toEqual(summary.breakdown)
    expect(exp.data_freshness).toBe(summary.data_freshness)
    const totalSources = Object.values(exp.source_freshness_counts).reduce((s, n) => s + n, 0)
    expect(totalSources).toBe(2) // anthropic-max + render-hosting
  })
})

describe('exportAlerts (GAP-12, added once alerts-capture landed on this branch)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('defaults to active alerts only, matching listAlerts(status: active)', () => {
    const db = getDb()
    reconcileAndPersist(db, [{ type: 'budget_threshold', severity: 'warning', evidence: {}, dedup_key: 'a' }], NOW)
    reconcileAndPersist(db, [{ type: 'stale_collector', severity: 'info', evidence: {}, dedup_key: 'b' }], NOW)
    reconcileAndPersist(db, [{ type: 'budget_threshold', severity: 'warning', evidence: {}, dedup_key: 'a' }], NOW + 10) // 'b' drops off -> resolved
    const exp = exportAlerts(db, NOW + 10)
    expect(exp.meta.scope).toBe('alerts_active')
    expect(exp.alerts.map(a => a.dedup_key)).toEqual(['a'])
  })

  it('includeResolved:true returns the full history', () => {
    const db = getDb()
    reconcileAndPersist(db, [{ type: 'budget_threshold', severity: 'warning', evidence: {}, dedup_key: 'a' }], NOW)
    reconcileAndPersist(db, [], NOW + 10) // resolves it
    const exp = exportAlerts(db, NOW + 10, { includeResolved: true })
    expect(exp.meta.scope).toBe('alerts_all')
    expect(exp.alerts).toHaveLength(1)
    expect(exp.alerts[0].resolved_at).toBe(NOW + 10)
  })

  it('alertsToCsv produces a header row plus one row per alert, no secret/evidence leakage beyond the declared columns', () => {
    const db = getDb()
    reconcileAndPersist(db, [{ type: 'budget_threshold', severity: 'warning', evidence: { api_key: 'sk-should-not-appear' }, dedup_key: 'a' }], NOW)
    const exp = exportAlerts(db, NOW)
    const csv = alertsToCsv(exp.alerts)
    expect(csv.split('\n')).toEqual(['dedup_key,type,severity,first_seen,last_seen,acknowledged_at,resolved_at,recurrence_count', expect.stringContaining('a,budget_threshold,warning'), ''])
    expect(csv).not.toContain('sk-should-not-appear') // evidence is deliberately excluded from the CSV columns
  })
})

describe('exportMonthlySnapshot', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('bundles everything and explicitly disclaims being the frozen close record', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const exp = exportMonthlySnapshot(db, cfg(), NOW, '2026-07')
    expect(exp.meta.scope).toBe('monthly_snapshot')
    // period-close.ts landed on this branch after this test was written --
    // the bundle now reports the real period_status and points a consumer at
    // the true immutable record (GET /api/costs/period-close) for a closed
    // month, instead of a blanket "close doesn't exist yet" disclaimer.
    expect(exp.note).toMatch(/not the frozen close record/)
    expect(exp.period_status).toBe('open') // untouched month in this test
    expect(exp.ledger.length).toBe(2)
    expect(exp.provider_summary.length).toBeGreaterThan(0)
    expect(exp.category_summary.length).toBeGreaterThan(0)
    expect(exp.budget?.spend_variance).toBeDefined()
    expect(exp.reconciliation.length).toBeGreaterThan(0)
    expect(exp.data_quality.data_freshness).not.toBeNull()
  })

  it('re-running it after new data lands produces a different result -- honest about not being frozen', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const before = exportMonthlySnapshot(db, cfg(), NOW, '2026-07')
    const winPrev = monthWindow(NOW)
    db.prepare(`
      INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('late-addition','Late','other','saas','HUF',1,@now,@now)
    `).run({ now: NOW })
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at)
      VALUES ('late-addition', @start, @end, 'usage', 5000, 'HUF', 'manual', @now, 'late-1', @now)
    `).run({ start: winPrev.start, end: winPrev.end, now: NOW })
    const after = exportMonthlySnapshot(db, cfg(), NOW, '2026-07')
    expect(after.ledger.length).toBe(before.ledger.length + 1)
  })
})
