import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncFixedCostsToLedger, getCostSummary, monthWindow } from '../costops/ledger.js'
import { getWarnings } from '../costops/warnings.js'
import { deriveLifecycle, type SubscriptionsConfig } from '../costops/subscriptions.js'
import type { CostOpsConfig } from '../costops/config.js'
import type { LimitStatus } from '../costops/limits.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [{ id: 'global-monthly', name: 'Global', scope: 'global', amount: 20000, warning_threshold: 0.8, hard_threshold: 1.0, currency: 'HUF' }],
    ...over,
  }
}

describe('costops warnings', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('is empty when everything is healthy (no noise)', () => {
    const db = getDb()
    const c = cfg({
      fixed_costs: [
        { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'provider_api', currency: 'HUF' },
      ],
      budgets: [{ id: 'global-monthly', name: 'Global', scope: 'global', amount: 100000, warning_threshold: 0.8, hard_threshold: 1.0, currency: 'HUF' }],
    })
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const warnings = getWarnings(db, c, NOW, summary, [])
    expect(warnings.filter(w => w.code === 'forecast_over_budget')).toHaveLength(0)
    expect(warnings.filter(w => w.code === 'high_cost_manual_fallback')).toHaveLength(0)
  })

  it('forecast_over_budget fires when operational spend crosses the hard threshold', () => {
    const db = getDb()
    const c = cfg() // 22000 spend vs 20000 budget -> over hard threshold
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const warnings = getWarnings(db, c, NOW, summary, [])
    const w = warnings.find(x => x.code === 'forecast_over_budget')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('high')
  })

  it('high_cost_manual_fallback fires when a manual-confidence source dominates spend', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const warnings = getWarnings(db, c, NOW, summary, [])
    const w = warnings.find(x => x.code === 'high_cost_manual_fallback')
    expect(w).toBeDefined()
    expect(w!.provider).toBe('anthropic')
  })

  it('expected_invoice_missing fires for a past_due active subscription', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const subsCfg: SubscriptionsConfig = { version: 1, subscriptions: [{ id: 'overdue-sub', name: 'Overdue Sub', provider: 'openai', source: 'openai', status: 'active', next_renewal: '2026-07-01', amount_source: 'no_invoice_found' }] }
    const subscriptions = deriveLifecycle(subsCfg, NOW)
    const warnings = getWarnings(db, c, NOW, summary, subscriptions)
    const w = warnings.find(x => x.code === 'expected_invoice_missing')
    expect(w).toBeDefined()
    expect(w!.provider).toBe('openai')
  })

  it('billing_access_needed fires for a pending_permission source, without fabricating an amount', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('aws','AWS','aws','usage','HUF',1,@now,@now)`).run({ now: NOW })
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at)
      VALUES ('aws', @start, @end, 'usage', 0, 'HUF', 'pending_permission', @now, @now)
    `).run({ start: win.start, end: win.end, now: NOW })
    const summary = getCostSummary(db, c, NOW)
    // v0.8: pending sources are no longer hidden from all_sources -- they appear with an
    // honest spend: null (never a fake 0), confidence/actual_source both 'pending_permission'.
    const awsRow = summary.all_sources.find(s => s.source_id === 'aws')
    expect(awsRow).toBeDefined()
    expect(awsRow!.spend).toBeNull()
    expect(awsRow!.confidence).toBe('pending_permission')
    const warnings = getWarnings(db, c, NOW, summary, [])
    const w = warnings.find(x => x.code === 'billing_access_needed')
    expect(w).toBeDefined()
    expect(w!.provider).toBe('aws')
    expect(w!.message).not.toMatch(/\d+\s*(HUF|Ft)/) // no fabricated amount in the message
  })

  it('is deterministic -- same inputs, same output, twice in a row', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const w1 = getWarnings(db, c, NOW, summary, [])
    const w2 = getWarnings(db, c, NOW, summary, [])
    expect(w1).toEqual(w2)
  })

  it('Render spend-limit and Claude Max weekly limit always surface as no_api_or_no_access (never fabricated)', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const warnings = getWarnings(db, c, NOW, summary, [])
    const render = warnings.find(w => w.code === 'render_spend_limit_unknown')
    const claude = warnings.find(w => w.code === 'claude_max_weekly_limit_unknown')
    expect(render?.confidence).toBe('no_api_or_no_access')
    expect(render?.severity).toBe('low')
    expect(claude?.confidence).toBe('no_api_or_no_access')
  })

  it('DeepSeek balance: no snapshots yet -> no_api_or_no_access, not a fabricated 0%', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    const summary = getCostSummary(db, c, NOW)
    const w = getWarnings(db, c, NOW, summary, []).find(x => x.code === 'deepseek_balance_unknown')
    expect(w).toBeDefined()
    expect(w!.confidence).toBe('no_api_or_no_access')
  })

  it('DeepSeek balance: low balance vs peak fires the generic tiered limit_usage_high rule (v0.8 -- escalation moved off deepseek_balance_low onto limits.ts + rule 11)', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',100,@t1)`).run({ t1: NOW - 3 * 86400 })
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',4,@t2)`).run({ t2: NOW })
    const summary = getCostSummary(db, c, NOW)
    // usage_pct = fraction CONSUMED = 1 - 4/100 = 0.96, matching limits.ts's fromDeepSeekBalance shape.
    const limits: LimitStatus[] = [{
      provider: 'deepseek', limit_type: 'balance', current_usage: 4, limit_value: 100,
      usage_pct: 0.96, reset_date: null, paid_until: null, expiry_date: null,
      status: 'critical', source: 'ledger', sub_id: null, unit: 'USD',
    }]
    const warnings = getWarnings(db, c, NOW, summary, [], limits)
    expect(warnings.find(x => x.code === 'deepseek_balance_low')).toBeUndefined() // rule retired
    const w = warnings.find(x => x.code === 'limit_usage_high' && x.provider === 'deepseek')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('critical') // 96% consumed >= 90% tier
    expect(w!.current_value).toBe(96)
  })

  it('DeepSeek balance: near-peak (healthy) balance -- no "low" warning, but the raw balance is still always visible (spec 65da75e6 A1)', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',100,@t1)`).run({ t1: NOW - 3 * 86400 })
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',90,@t2)`).run({ t2: NOW })
    const summary = getCostSummary(db, c, NOW)
    const warnings = getWarnings(db, c, NOW, summary, [])
    expect(warnings.find(x => x.code === 'deepseek_balance_low')).toBeUndefined()
    const info = warnings.find(x => x.code === 'deepseek_balance_info')
    expect(info).toBeDefined()
    expect(info!.severity).toBe('low')
    expect(info!.current_value).toBe(90)
    expect(info!.unit).toBe('USD')
  })

  it('DeepSeek balance: only one snapshot ever (no observed drop) -- raw balance shown, confidence manual (not fabricated %)', () => {
    const db = getDb()
    const c = cfg({ budgets: [] })
    syncFixedCostsToLedger(db, c, NOW)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',50,@t1)`).run({ t1: NOW })
    const summary = getCostSummary(db, c, NOW)
    const info = getWarnings(db, c, NOW, summary, []).find(x => x.code === 'deepseek_balance_info')
    expect(info).toBeDefined()
    expect(info!.confidence).toBe('manual')
    expect(info!.current_value).toBe(50)
  })
})
