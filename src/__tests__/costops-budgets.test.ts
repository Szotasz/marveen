import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { resolveBudgetStatus, getAllBudgetStatuses, upsertBudget, deleteBudget, getBudgetAuditHistory } from '../costops/budgets.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

// upsertBudget/deleteBudget call the real saveCostopsConfig(), which writes
// store/costops-config.json on disk -- mocked here so these unit tests never
// touch that real file (a prior version of this file didn't mock this and
// left 'a'/'b' budget entries behind in the actual config, which would have
// shown up as fake budgets on a real dashboard -- flagged by Marveen 2026-07-15).
vi.mock('../costops/config.js', async () => {
  const actual = await vi.importActual<typeof import('../costops/config.js')>('../costops/config.js')
  return { ...actual, saveCostopsConfig: vi.fn() }
})

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const MONTH = monthWindow(NOW).key

function baseConfig(overrides: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [], ...overrides }
}

function insertLine(sourceId: string, provider: string, sourceType: string, amount: number) {
  const db = getDb()
  const win = monthWindow(NOW)
  db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'HUF', 1, ?, ?)`)
    .run(sourceId, sourceId, provider, sourceType, NOW, NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, 'subscription', ?, 'HUF', 'manual', ?, ?, ?, 'manual_entry')
  `).run(sourceId, win.start, win.end, amount, NOW, NOW, `test|${sourceId}|${Math.random()}`)
}

describe('resolveBudgetStatus / getAllBudgetStatuses (CostOps Phase 3, GAP-11)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a global budget resolves against operational_spend/forecast, matching the summary', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'global-monthly', scope: 'global', amount: 50000, warning_threshold: 0.8, hard_threshold: 1.0 }] })
    const summary = getCostSummary(db, config, NOW)
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.scope).toBe('global')
    expect(status.current_spend).toBe(summary.operational_spend)
    expect(status.forecast).toBe(summary.operational_forecast_month_end)
  })

  it('a provider budget only sums that provider\'s sources', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    insertLine('openai-api', 'openai', 'usage', 5000)
    const config = baseConfig({ budgets: [{ id: 'render-budget', scope: 'provider', scope_ref: 'render', amount: 20000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(10000) // render only, not openai
  })

  it('a category budget sums by source_type across providers', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    insertLine('aws-s3', 'aws', 'hosting', 3000)
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    const config = baseConfig({ budgets: [{ id: 'hosting-budget', scope: 'category', scope_ref: 'hosting', amount: 20000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(13000) // render + aws hosting only
  })

  it('a source-scoped budget resolves to just that one source', () => {
    const db = getDb()
    insertLine('anthropic-max', 'anthropic', 'subscription', 22000)
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'claude-max-budget', scope: 'source', scope_ref: 'anthropic-max', amount: 25000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(22000)
  })

  it('product/agent scopes explicitly resolve to zero -- GAP-11 excludes them, never fabricated', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 10000)
    const config = baseConfig({ budgets: [{ id: 'weird-budget', scope: 'product', scope_ref: 'whatever', amount: 5000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.current_spend).toBe(0)
    expect(status.forecast).toBe(0)
  })

  it('status escalates ok -> warning -> hard by used_pct vs thresholds', () => {
    const db = getDb()
    insertLine('render-hosting', 'render', 'hosting', 8500)
    const config = baseConfig({ budgets: [{ id: 'b', scope: 'global', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.used_pct).toBeCloseTo(0.85, 2)
    expect(status.status).toBe('warning')
  })

  it('variance is forecast minus amount -- positive means a projected overage', () => {
    const summary = getCostSummary(getDb(), baseConfig(), NOW)
    const status = resolveBudgetStatus({ id: 'b', scope: 'global', amount: 1000 }, { ...summary, operational_forecast_month_end: 1500 })
    expect(status.variance).toBe(500)
  })

  it('owner defaults to operator when not configured on the budget entry', () => {
    const db = getDb()
    const config = baseConfig({ budgets: [{ id: 'b', scope: 'global', amount: 1000 }] })
    const [status] = getAllBudgetStatuses(db, config, NOW)
    expect(status.owner).toBe('operator')
  })
})

describe('upsertBudget / deleteBudget audit trail (CostOps Phase 3, GAP-11)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creating a new budget records a "created" audit entry', () => {
    const db = getDb()
    const config = baseConfig()
    const r = upsertBudget(db, config, { id: 'global-monthly', scope: 'global', amount: 50000 }, 'istvan', NOW)
    expect(r.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'global-monthly')
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('created')
    expect(history[0].before).toBeNull()
    expect(history[0].after!.amount).toBe(50000)
  })

  it('updating an existing budget records an "updated" entry with before/after', () => {
    const db = getDb()
    let config = baseConfig()
    upsertBudget(db, config, { id: 'b', scope: 'global', amount: 50000 }, 'istvan', NOW)
    config = { ...config, budgets: [{ id: 'b', scope: 'global', amount: 50000 }] } // simulate a reload
    const r2 = upsertBudget(db, config, { id: 'b', scope: 'global', amount: 70000 }, 'istvan', NOW + 10)
    expect(r2.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'b')
    expect(history).toHaveLength(2)
    expect(history[1].action).toBe('updated')
    expect(history[1].before!.amount).toBe(50000)
    expect(history[1].after!.amount).toBe(70000)
  })

  it('deleting a budget records a "deleted" entry with before only', () => {
    const db = getDb()
    let config = baseConfig()
    upsertBudget(db, config, { id: 'b', scope: 'global', amount: 50000 }, 'istvan', NOW)
    config = { ...config, budgets: [{ id: 'b', scope: 'global', amount: 50000 }] }
    const r = deleteBudget(db, config, 'b', 'istvan', NOW + 10)
    expect(r.ok).toBe(true)
    const history = getBudgetAuditHistory(db, 'b')
    expect(history[1].action).toBe('deleted')
    expect(history[1].before!.amount).toBe(50000)
    expect(history[1].after).toBeNull()
  })

  it('requires an actor for both upsert and delete', () => {
    const db = getDb()
    const config = baseConfig()
    expect(upsertBudget(db, config, { id: 'b', amount: 1000 }, '', NOW).status).toBe(400)
    expect(deleteBudget(db, config, 'b', '', NOW).status).toBe(400)
  })

  it('rejects a negative or non-numeric amount', () => {
    const db = getDb()
    const config = baseConfig()
    expect(upsertBudget(db, config, { id: 'b', amount: -5 }, 'istvan', NOW).status).toBe(400)
  })

  it('deleteBudget 404s on an unknown id', () => {
    const db = getDb()
    const config = baseConfig()
    const r = deleteBudget(db, config, 'ghost', 'istvan', NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('getBudgetAuditHistory with no id returns every budget\'s history', () => {
    const db = getDb()
    const config = baseConfig()
    upsertBudget(db, config, { id: 'a', amount: 1000 }, 'istvan', NOW)
    upsertBudget(db, config, { id: 'b', amount: 2000 }, 'istvan', NOW + 1)
    expect(getBudgetAuditHistory(db)).toHaveLength(2)
  })
})
