import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getCostSummary, monthWindow, resolveOperational } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15
function emptyConfig(): CostOpsConfig { return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [{ id: 'global-monthly', amount: 200000, warning_threshold: 0.8, hard_threshold: 1.0 }] } }

function seedSource(db: any, id: string, provider: string) {
  db.prepare("INSERT OR IGNORE INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES (?,?,?,?,'HUF',1,?,?)").run(id, id, provider, 'usage', NOW, NOW)
}
function seedLine(db: any, sid: string, amount: number, conf: string, cat = 'subscription', win = monthWindow(NOW), dk?: string) {
  db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
    VALUES (?,?,?,?,?,?,'HUF',?,?,?,?)`).run(sid, win.start, win.end, cat, sid, amount, conf, NOW, dk || `${sid}|${conf}|${win.key}`, NOW)
}

// Synthetic amounts only -- NO real cost figures in this tracked test file.
describe('resolveOperational (provider-preferred, no double count)', () => {
  it('a provider plan estimate wins over the manual fallback; not summed', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'render-hosting', provider: 'render', billed_cost: 3000, charge_category: 'subscription', confidence: 'manual', data_freshness: NOW },
      { source_id: 'render-plan', provider: 'render', billed_cost: 2500, charge_category: 'usage', confidence: 'provider_plan_estimate', data_freshness: NOW },
      { source_id: 'sub-a', provider: 'acme', billed_cost: 5000, charge_category: 'subscription', confidence: 'manual', data_freshness: NOW },
    ], win)
    // operational: render 2500 (plan, not 3000) + acme 5000 (manual, no derived) = 7500
    expect(r.operational_spend).toBe(7500)
    expect(r.provider_derived_spend).toBe(2500)
    // manual_spend (fallback view) = 3000 + 5000 = 8000
    expect(r.manual_spend).toBe(8000)
    // variance for derived providers: 2500 - 3000 = -500
    expect(r.manual_vs_provider_variance).toBe(-500)
    const render = r.provider_breakdown.find(p => p.provider === 'render')!
    expect(render.spend).toBe(2500)
    expect(render.confidence).toBe('provider_plan_estimate')
  })

  it('provider_api_actual usage forecasts by run-rate; plan forecasts full monthly', () => {
    const win = monthWindow(NOW) // mid-month, fractionElapsed < 1
    const r = resolveOperational([
      { source_id: 'x-api', provider: 'x', billed_cost: 1000, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW },
      { source_id: 'render-plan', provider: 'render', billed_cost: 2500, charge_category: 'usage', confidence: 'provider_plan_estimate', data_freshness: NOW },
    ], win)
    // x-api actual usage -> 1000 / fractionElapsed (run-rate, > 1000); render plan -> full 2500
    expect(r.operational_forecast_month_end).toBeGreaterThan(1000 + 2500)
    expect(r.operational_spend).toBe(3500)
  })
})

describe('getCostSummary v0.4 operational fields', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('operational_spend prefers provider; current_spend legacy unaffected; render uses plan', () => {
    const db = getDb()
    seedSource(db, 'render-hosting', 'render'); seedLine(db, 'render-hosting', 3000, 'manual')
    seedSource(db, 'render-plan', 'render'); seedLine(db, 'render-plan', 2500, 'provider_plan_estimate', 'usage')
    seedSource(db, 'sub-a', 'acme'); seedLine(db, 'sub-a', 5000, 'manual')
    const s = getCostSummary(db, emptyConfig(), NOW)
    // operational: 2500 + 5000 = 7500 (render manual dropped)
    expect(s.operational_spend).toBe(7500)
    // legacy current_spend still EXCLUDES provider_plan_estimate -> render manual 3000 + acme 5000 = 8000
    expect(s.current_spend).toBe(8000)
    expect(s.operational.manual_vs_provider_variance).toBe(-500)
    // budget usage on operational
    expect(s.budget!.operational_used_pct).toBeCloseTo(7500 / 200000, 4)
  })

  it('previous_month: no data -> null (never fabricated)', () => {
    const db = getDb()
    seedSource(db, 'render-plan', 'render'); seedLine(db, 'render-plan', 2500, 'provider_plan_estimate', 'usage')
    const s = getCostSummary(db, emptyConfig(), NOW)
    expect(s.previous_month).toBeNull()
    expect(s.month_over_month_delta).toBeNull()
  })

  it('previous_month: aggregates from prior month lines + MoM delta', () => {
    const db = getDb()
    const prevWin = monthWindow(monthWindow(NOW).start - 86400) // June
    seedSource(db, 'render-plan', 'render')
    seedLine(db, 'render-plan', 2000, 'provider_plan_estimate', 'usage', prevWin, 'render-plan|prev')
    seedLine(db, 'render-plan', 2500, 'provider_plan_estimate', 'usage', monthWindow(NOW), 'render-plan|cur')
    const s = getCostSummary(db, emptyConfig(), NOW)
    expect(s.previous_month).not.toBeNull()
    expect(s.previous_month!.operational_spend).toBe(2000)
    expect(s.previous_month!.month).toBe(prevWin.key)
    expect(s.month_over_month_delta).toBe(500) // 2500 - 2000
  })
})
