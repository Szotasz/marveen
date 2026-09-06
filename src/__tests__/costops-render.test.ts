import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapRenderPlanCost, makeRenderCollector, type RenderPricing } from '../costops/collectors/render.js'
import { runCollector } from '../costops/collectors/runner.js'
import { dryRunCollector } from '../costops/collectors/runner.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'
import type { HttpGetJson } from '../costops/collectors/types.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

const PRICING: RenderPricing = {
  version: 1, currency: 'HUF', fx_usd_huf: 300,
  plans: {
    web_service: { free: 0, starter: 7, standard: 25, pro: 85 },
    static_site: { free: 0 },
    postgres: { free: 0, basic_1gb: 19 },
  },
}

// Offline fixture -- NO live Render API is ever called in tests.
const RAW = {
  services: [
    { service: { id: 'srv-1', type: 'web_service', serviceDetails: { plan: 'starter', numInstances: 1 } } },
    { service: { id: 'srv-2', type: 'web_service', serviceDetails: { plan: 'standard', numInstances: 2 } } }, // 25*2=50
    { service: { id: 'srv-3', type: 'static_site', serviceDetails: {} } },                                   // 0, bandwidth flag
    { service: { id: 'srv-4', type: 'web_service', suspended: 'suspended', serviceDetails: { plan: 'pro' } } }, // 0 suspended
    { service: { id: 'srv-5', type: 'web_service', serviceDetails: { plan: 'mystery', numInstances: 1 } } },   // unpriced
  ],
  postgres: [
    { postgres: { id: 'pg-1', plan: 'basic_1gb' } }, // 19
  ],
}

function opts() { const w = monthWindow(NOW); return { periodStart: w.start, periodEnd: w.end, pricing: PRICING, idSalt: 'salt', now: NOW } }

describe('mapRenderPlanCost (pure, offline)', () => {
  it('prices by plan, aggregates to one HUF line, flags the rest', () => {
    const { lines, breakdown } = mapRenderPlanCost(RAW, opts())
    // total USD = 7 + 50 + 19 = 76 ; HUF = 76 * 300 = 22800
    expect(breakdown.total_usd).toBe(76)
    expect(breakdown.total_huf).toBe(22800)
    expect(lines).toHaveLength(1)
    expect(lines[0].amount).toBe(22800)
    expect(lines[0].confidence).toBe('provider_plan_estimate')
    expect(lines[0].provider).toBe('render')
    expect(lines[0].service).toBe('render-plan')
    expect(lines[0].dedup_key).toBe('provider|render|render-plan|2026-07|provider_plan_estimate')
    // no raw service id in the line
    expect(JSON.stringify(lines[0])).not.toContain('srv-')
    expect(JSON.stringify(lines[0])).not.toContain('pg-')
  })
  it('handles static/suspended/unknown + records undercount flags', () => {
    const { breakdown } = mapRenderPlanCost(RAW, opts())
    expect(breakdown.suspended_count).toBe(1)
    expect(breakdown.unpriced.some(u => u.plan === 'mystery')).toBe(true)
    expect(breakdown.by_type_plan['web_service/standard']).toEqual({ count: 2, usd: 50 })
    expect(breakdown.undercount_flags.some(f => /static_site/.test(f))).toBe(true)
    expect(breakdown.undercount_flags.some(f => /unpriced/.test(f))).toBe(true)
  })
  it('fx=0 -> HUF total 0 + flag (no fabricated amount)', () => {
    const p = { ...PRICING, fx_usd_huf: 0 }
    const { lines, breakdown } = mapRenderPlanCost(RAW, { ...opts(), pricing: p })
    expect(breakdown.total_huf).toBe(0)
    expect(lines).toHaveLength(0)
    expect(breakdown.undercount_flags.some(f => /fx_usd_huf/.test(f))).toBe(true)
  })
})

describe('render collector via runner (offline)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('dry-run does NOT persist a render-plan line', async () => {
    const stub: HttpGetJson = async (url) => url.includes('postgres') ? RAW.postgres : RAW.services
    const col = makeRenderCollector(PRICING)
    const w = monthWindow(NOW)
    const rep = await dryRunCollector({ db: getDb(), collector: col, opts: { periodStart: w.start, periodEnd: w.end, secret: 'rnd_SECRET', fxUsdHuf: 0, idSalt: 'salt', httpGetJson: stub }, now: NOW })
    expect(rep.status).toBe('dry_run')
    expect(rep.plannedLines[0].amount).toBe(22800)
    const n = getDb().prepare("SELECT COUNT(*) n FROM cost_line_items").get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('import writes a provider_plan_estimate line; idempotent', async () => {
    const stub: HttpGetJson = async (url) => url.includes('postgres') ? RAW.postgres : RAW.services
    const col = makeRenderCollector(PRICING)
    const w = monthWindow(NOW)
    const o = { periodStart: w.start, periodEnd: w.end, secret: 'rnd_SECRET', fxUsdHuf: 0, idSalt: 'salt', httpGetJson: stub }
    await runCollector({ db: getDb(), collector: col, opts: o, now: NOW })
    await runCollector({ db: getDb(), collector: col, opts: o, now: NOW }) // re-run
    const rows = getDb().prepare("SELECT confidence, billed_cost FROM cost_line_items WHERE source_id='render-plan'").all() as Array<{ confidence: string; billed_cost: number }>
    expect(rows).toHaveLength(1) // idempotent
    expect(rows[0].confidence).toBe('provider_plan_estimate')
    expect(rows[0].billed_cost).toBe(22800)
    // secret never in import_runs
    expect(JSON.stringify(getDb().prepare('SELECT * FROM import_runs').all())).not.toContain('rnd_SECRET')
  })
})

describe('summary: render plan is advisory (no override of manual)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function emptyConfig(): CostOpsConfig { return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] } }

  it('render_plan block shows manual vs plan vs variance; current_spend excludes plan estimate', async () => {
    const db = getDb()
    const w = monthWindow(NOW)
    // seed a MANUAL render-hosting estimate (like the config sync)
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('render-hosting','Render hosting','render','hosting','HUF',1,?,?)").run(NOW, NOW)
    db.prepare("INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at) VALUES ('render-hosting',?,?,'subscription','Render hosting',30000,'HUF','manual',?,'fixed|render-hosting|2026-07',?)").run(w.start, w.end, NOW, NOW)
    // import the plan-based estimate
    const stub: HttpGetJson = async (url) => url.includes('postgres') ? RAW.postgres : RAW.services
    await runCollector({ db, collector: makeRenderCollector(PRICING), opts: { periodStart: w.start, periodEnd: w.end, secret: 'x', fxUsdHuf: 0, idSalt: 'salt', httpGetJson: stub }, now: NOW })

    const s = getCostSummary(db, emptyConfig(), NOW)
    // headline current_spend = manual 30000 ONLY (plan estimate excluded)
    expect(s.current_spend).toBe(30000)
    // render-plan source NOT in all_sources
    expect(s.all_sources.find(x => x.source_id === 'render-plan')).toBeUndefined()
    // render_plan advisory block present with variance
    expect(s.render_plan).not.toBeNull()
    expect(s.render_plan!.plan_estimate_total).toBe(22800)
    expect(s.render_plan!.manual_estimate).toBe(30000)
    expect(s.render_plan!.variance).toBe(-7200) // plan - manual
    expect(s.render_plan!.not_covered.length).toBeGreaterThan(0)
  })

  it('render_plan is null when no plan import exists', () => {
    const s = getCostSummary(getDb(), emptyConfig(), NOW)
    expect(s.render_plan).toBeNull()
  })
})
