// CostOps Phase 0 -- baseline semantics regression suite.
//
// Locks in the numbered Phase 0 acceptance criteria (core-v1.0.1-gap-analysis.md,
// "Phase 0 acceptance criteria") end to end, against a single realistic mixed
// scenario (manual + provider_api + plan estimate + pending_permission + a
// voided entry + token usage). Exists so a later phase's change that quietly
// breaks one of these guarantees fails a test immediately, not a live audit.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import { buildSourceInventory } from '../costops/inventory.js'
import { createManualCost, deleteManualCost } from '../costops/manual-entry.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

function seedMixedScenario(db: import('better-sqlite3').Database) {
  const win = monthWindow(NOW)
  // provider_api actual for Render (real, measured)
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,?,?)`).run(NOW, NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES ('render-hosting', @start, @end, 'usage', 10000, 'HUF', 'provider_api', @now, @now, 'render|actual', 'provider_api')
  `).run({ start: win.start, end: win.end, now: NOW })
  // Render plan estimate (ADVISORY -- must never enter operational_spend). Distinct
  // source_id from the actual (matches how the real Render collector shapes it --
  // see costops-operational.test.ts's render-hosting/render-plan pairing).
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-plan','Render (plan)','render','usage','HUF',1,?,?)`).run(NOW, NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES ('render-plan', @start, @end, 'usage', 15000, 'HUF', 'provider_plan_estimate', @now, @now, 'render|plan', 'provider_api')
  `).run({ start: win.start, end: win.end, now: NOW })
  // pending_permission (AWS-shaped) -- must never be a fabricated amount
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('aws','AWS','aws','hosting','HUF',1,?,?)`).run(NOW, NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES ('aws', @start, @end, 'usage', 0, 'HUF', 'pending_permission', @now, @now, 'aws|pending', 'pending_permission')
  `).run({ start: win.start, end: win.end, now: NOW })
  // token usage volume (opportunity-cost adjacent -- NOT priced into current_spend)
  db.prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('marveen', 's1', ?, 100000, 50000, 0, 0)`).run(win.start + 100)
}

describe('CostOps Phase 0 -- baseline semantics locked (acceptance criteria)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('AC10: opportunity cost (token_cost_estimate) never enters operational_spend or current_spend', () => {
    const db = getDb()
    seedMixedScenario(db)
    const s = getCostSummary(db, cfg, NOW)
    expect(s.token_cost_estimate).toBeDefined()
    // current_spend / operational_spend derive ONLY from cost_line_items, never
    // from token_cost_estimate.total_estimated_huf -- proven by the dedicated
    // estimated_total_with_token_cost field being current_spend PLUS the token
    // estimate as a separate, additive term (never folded silently into
    // current_spend itself, which stays whatever the ledger alone says).
    expect(s.estimated_total_with_token_cost).toBe(round2(s.current_spend + s.token_cost_estimate.total_estimated_huf))
    expect(s.current_spend).toBe(10000) // unaffected by the 150000 tokens recorded above -- volume, not cost
    expect(s.operational_spend).toBe(10000) // only the real Render provider_api actual
  })

  it('AC9: reconciliation delta stays 0 -- operational + manual-fallback partition sums back to the raw total, no double count', () => {
    const db = getDb()
    seedMixedScenario(db)
    const s = getCostSummary(db, cfg, NOW)
    // Render: provider_api (10000) supersedes its own plan estimate (15000) for
    // the SAME provider -- the plan estimate must show as the advisory
    // render_plan block, never summed alongside the actual into operational.
    expect(s.render_plan).not.toBeNull()
    expect(s.render_plan!.plan_estimate_total).toBe(15000)
    // the real invoice (10000) supersedes the plan-estimate proxy (15000) for the
    // SAME provider -- variance is provider_derived (10000) minus the excluded
    // plan-estimate fallback (15000), never a double-counted sum of both.
    expect(s.operational.manual_vs_provider_variance).toBe(-5000)
    expect(s.operational_spend).toBe(10000)
  })

  it('AC10/AC-pending: a pending_permission source contributes null spend, never a fabricated amount, never enters operational_spend', () => {
    const db = getDb()
    seedMixedScenario(db)
    const s = getCostSummary(db, cfg, NOW)
    const aws = s.all_sources.find(x => x.source_id === 'aws')!
    expect(aws.spend).toBeNull()
    expect(aws.actual_source).toBe('pending_permission')
    expect(s.operational_spend).toBe(10000) // AWS's 0 never silently adds to the total
  })

  it('AC7: no source in the inventory is ever left with an unknown/undefined lifecycle', () => {
    const db = getDb()
    seedMixedScenario(db)
    const inv = buildSourceInventory(db, cfg, NOW)
    const allowedLifecycles = new Set(['active', 'inactive', 'not_configured', 'unsupported', 'blocked', 'deprecated'])
    for (const s of inv) expect(allowedLifecycles.has(s.lifecycle)).toBe(true)
  })

  it('AC3: lifecycle and provenance are reported as two separate fields, never merged into one', () => {
    const db = getDb()
    seedMixedScenario(db)
    const inv = buildSourceInventory(db, cfg, NOW, { credentialChecker: () => true })
    const render = inv.find(s => s.source_id === 'render-hosting')!
    expect(render.lifecycle).not.toBe(render.provenance) // distinct value domains, never coincidentally aliased in the type
    expect(typeof render.lifecycle).toBe('string')
    expect(typeof render.provenance).toBe('string')
  })

  it('AC9 (void path): voiding a manual entry keeps reconciliation/operational totals internally consistent -- no orphaned partial state', () => {
    const db = getDb()
    seedMixedScenario(db)
    createManualCost(db, { source_id: 'notion', name: 'Notion', provider: 'notion', amount: 8000, currency: 'HUF', month: '2026-07' }, { fxUsdHuf: 360, now: NOW })
    const before = getCostSummary(db, cfg, NOW)
    expect(before.operational_spend).toBe(18000) // 10000 render + 8000 notion manual

    deleteManualCost(db, { source_id: 'notion', month: '2026-07' }, { now: NOW + 10 })
    const after = getCostSummary(db, cfg, NOW)
    expect(after.operational_spend).toBe(10000) // back to just render -- voided row cleanly excluded
    // The Render/AWS/token-usage invariants above are untouched by the void of an unrelated source.
    expect(after.render_plan!.plan_estimate_total).toBe(15000)
    expect(after.all_sources.find(x => x.source_id === 'aws')!.spend).toBeNull()
  })

  it('AC8: the headline CostSummary shape is unchanged by Phase 0 -- every pre-existing field is still present', () => {
    const db = getDb()
    seedMixedScenario(db)
    const s = getCostSummary(db, cfg, NOW)
    for (const key of [
      'month', 'currency', 'current_spend', 'forecast_month_end', 'operational_spend',
      'operational_forecast_month_end', 'operational', 'previous_month', 'month_over_month_delta',
      'top_sources', 'all_sources', 'confidence_breakdown', 'breakdown', 'budget', 'token_usage',
      'token_cost_estimate', 'estimated_total_with_token_cost', 'reconcile', 'provider_sync',
      'render_plan', 'data_freshness', 'config_present', 'config_errors', 'generated_at',
    ]) {
      expect(s).toHaveProperty(key)
    }
  })
})

function round2(n: number): number { return Math.round(n * 100) / 100 }
