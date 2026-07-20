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

  it('a REAL invoice supersedes the plan estimate for the same provider (no double count)', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      // same provider "render": a real invoice AND the plan-estimate proxy both present
      { source_id: 'render-hosting', provider: 'render', billed_cost: 4000, charge_category: 'hosting', confidence: 'actual_invoice', data_freshness: NOW },
      { source_id: 'render-plan', provider: 'render', billed_cost: 32000, charge_category: 'usage', confidence: 'provider_plan_estimate', data_freshness: NOW },
    ], win)
    // operational = 4000 (the real invoice), NOT 4000 + 32000; the plan proxy is dropped
    expect(r.operational_spend).toBe(4000)
    expect(r.provider_derived_spend).toBe(4000)
    const render = r.provider_breakdown.find(p => p.provider === 'render')!
    expect(render.spend).toBe(4000)
    expect(render.confidence).toBe('actual_invoice')
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
  // Card 097d8355 -- Istvan's ruling 2026-07-20: on an EQUAL tier the FRESHER row
  // is the current one. actual_invoice / provider_api / billing_export are all tier 4,
  // so before the fix a strict `>` kept the INCUMBENT and a freshly ingested invoice
  // was stored but never reached operational_spend.
  it('on an equal tier the fresher row wins -- new invoice over older provider_api', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'render-usage', provider: 'render', billed_cost: 9000, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW - 86400 },
      { source_id: 'render-usage', provider: 'render', billed_cost: 4200, charge_category: 'usage', confidence: 'actual_invoice', data_freshness: NOW },
    ], win)
    expect(r.operational_spend).toBe(4200)
  })

  // SUPERSEDED 2026-07-20 by Istvan's accounting rule (see the top-up / package
  // tests below). This case originally asserted that a fresher provider_api beats
  // an older actual_invoice on pure freshness. That is no longer the primary rule:
  // with NO source_type known, we now default to the PACKAGE branch and the
  // invoice wins. The default is deliberate -- an unknown source falling back to
  // a real billed amount understates nothing, whereas defaulting to consumption
  // would under-report, and an under-reported cost figure is the one nobody
  // investigates. Freshness still decides between two lines of the SAME kind.
  it('with no source_type, an equal tier defaults to the invoice (package rule)', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'render-usage', provider: 'render', billed_cost: 4200, charge_category: 'usage', confidence: 'actual_invoice', data_freshness: NOW - 86400 },
      { source_id: 'render-usage', provider: 'render', billed_cost: 9000, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW },
    ], win)
    expect(r.operational_spend).toBe(4200)
  })

  // Freshness must NOT beat tier -- a fresh estimate never outranks a real actual.
  it('a fresher LOWER-tier row does not win', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'render-usage', provider: 'render', billed_cost: 4200, charge_category: 'usage', confidence: 'actual_invoice', data_freshness: NOW - 86400 },
      { source_id: 'render-usage', provider: 'render', billed_cost: 999, charge_category: 'usage', confidence: 'estimate', data_freshness: NOW },
    ], win)
    expect(r.operational_spend).toBe(4200)
  })


  // ── Istvan's accounting rule, 2026-07-20 ──────────────────────────────────
  // Replaces freshness as the PRIMARY tiebreak for an equal-tier collision.
  it('TOP-UP (source_type usage): consumption wins over the funding invoice', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'openai-api', provider: 'openai', billed_cost: 2286, charge_category: 'invoice', confidence: 'actual_invoice', data_freshness: NOW, source_type: 'usage' },
      { source_id: 'openai-api', provider: 'openai', billed_cost: 20.51, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW - 86400, source_type: 'usage' },
    ], win)
    // funding the account is a real payment but NOT this period's cost
    expect(r.operational_spend).toBe(20.51)
  })

  it('PACKAGE (source_type subscription): the invoice wins over the API figure', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'anthropic-max', provider: 'anthropic', billed_cost: 32400, charge_category: 'invoice', confidence: 'actual_invoice', data_freshness: NOW - 86400, source_type: 'subscription' },
      { source_id: 'anthropic-max', provider: 'anthropic', billed_cost: 12, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW, source_type: 'subscription' },
    ], win)
    // the invoice states the period it covers; the API is only a stand-in until it arrives
    expect(r.operational_spend).toBe(32400)
  })

  it('the accounting rule beats freshness in BOTH directions', () => {
    const win = monthWindow(NOW)
    // package, and the API row is the FRESHER one -> invoice still wins
    const pkg = resolveOperational([
      { source_id: 'x-sub', provider: 'x', billed_cost: 9000, charge_category: 'invoice', confidence: 'actual_invoice', data_freshness: NOW - 999999, source_type: 'saas' },
      { source_id: 'x-sub', provider: 'x', billed_cost: 5, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW, source_type: 'saas' },
    ], win)
    expect(pkg.operational_spend).toBe(9000)
    // top-up, and the INVOICE is the fresher one -> consumption still wins
    const top = resolveOperational([
      { source_id: 'y-api', provider: 'y', billed_cost: 9000, charge_category: 'invoice', confidence: 'actual_invoice', data_freshness: NOW, source_type: 'usage' },
      { source_id: 'y-api', provider: 'y', billed_cost: 5, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW - 999999, source_type: 'usage' },
    ], win)
    expect(top.operational_spend).toBe(5)
  })

  // Card 320c477a: a period-END date reaching data_freshness must not win.
  it('a FUTURE freshness stamp cannot beat a real one', () => {
    const win = monthWindow(NOW)
    const r = resolveOperational([
      { source_id: 'z-api', provider: 'z', billed_cost: 100, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW },
      { source_id: 'z-api', provider: 'z', billed_cost: 7, charge_category: 'usage', confidence: 'provider_api', data_freshness: NOW + 12 * 86400 },
    ], win)
    expect(r.operational_spend).toBe(100)
  })
})
