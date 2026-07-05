// CostOps v0.1 -- deterministic cost ledger core.
//
// Pure SQL + arithmetic. NO LLM, no network, no secrets. `db` and `now` are
// passed in so every function is deterministic and unit-testable against an
// in-memory database. FOCUS-inspired: cost_sources (ProviderName/BillingAccount),
// cost_line_items (ChargeRow: ChargePeriod, ChargeCategory, BilledCost,
// ConsumedQuantity/Unit, confidence), budgets (display-only).

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { CostOpsConfig, CostConfidence } from './config.js'

// ---- month math (UTC, deterministic given `now`) ---------------------------

export interface MonthWindow {
  key: string          // 'YYYY-MM'
  start: number        // epoch sec, inclusive
  end: number          // epoch sec, exclusive (start of next month)
  daysInMonth: number
  fractionElapsed: number  // (0,1], how much of the month has passed at `now`
}

export function monthWindow(now: number, monthKey?: string): MonthWindow {
  let year: number, month: number  // month 0-based
  if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
    year = parseInt(monthKey.slice(0, 4))
    month = parseInt(monthKey.slice(5, 7)) - 1
  } else {
    const d = new Date(now * 1000)
    year = d.getUTCFullYear()
    month = d.getUTCMonth()
  }
  const start = Math.floor(Date.UTC(year, month, 1) / 1000)
  const end = Math.floor(Date.UTC(year, month + 1, 1) / 1000)
  const daysInMonth = Math.round((end - start) / 86400)
  const elapsed = Math.min(Math.max(now - start, 1), end - start)
  const fractionElapsed = elapsed / (end - start)
  const key = `${year}-${String(month + 1).padStart(2, '0')}`
  return { key, start, end, daysInMonth, fractionElapsed }
}

// ---- hashing (no raw account IDs / invoice refs ever stored) ----------------

/** Deterministic, non-reversible ref for account/resource/invoice identifiers. */
export function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

// ---- confidence -> breakdown bucket ----------------------------------------

// Higher = more authoritative. Used to resolve a source to one headline line
// (v0.3) so a provider_api actual supersedes a manual estimate without double count.
export const CONF_PRIORITY: Record<string, number> = {
  actual_invoice: 6, provider_api: 5, billing_export: 4, local_usage: 3, estimate: 2, manual: 1,
  // provider_plan_estimate is ADVISORY only: it is excluded from the headline
  // current_spend entirely (see getCostSummary), so its priority never applies
  // to a headline resolution. Kept here for completeness / bucketing.
  provider_plan_estimate: 0,
}

// provider_plan_estimate lines never enter the headline spend; they surface in a
// dedicated render_plan block (manual vs plan vs variance).
export const ADVISORY_CONF = new Set<string>(['provider_plan_estimate'])

// Costs a plan-based Render estimate structurally CANNOT see -> the estimate is a
// lower bound. Surfaced verbatim so the number is never mistaken for an invoice.
export const RENDER_NOT_COVERED: string[] = [
  'bandwidth overage (web + static site)',
  'database storage / backup overage above the plan',
  'logs / metrics / observability add-ons',
  'team / workspace seats',
  'tax / VAT',
  'credits / discounts',
  'invoice adjustments',
  'one-off charges',
  'cron per-run compute above the flat approximation',
  'preview environments (excluded)',
]

export type CostBucket = 'fixed_manual' | 'provider' | 'estimate'

export function confidenceBucket(c: CostConfidence): CostBucket {
  switch (c) {
    case 'actual_invoice':
    case 'provider_api':
    case 'billing_export':
      return 'provider'
    case 'estimate':
    case 'local_usage':
    case 'provider_plan_estimate':
      return 'estimate'
    case 'manual':
    default:
      return 'fixed_manual'
  }
}

// ---- write path: reflect config fixed costs into the ledger (idempotent) -----

/**
 * Upsert the config's fixed/manual monthly costs as cost_line_items for the
 * target month, and upsert their cost_sources. Idempotent via a stable
 * dedup_key (`fixed|<source_id>|<YYYY-MM>`) so re-running never duplicates.
 * Returns the number of line items written/updated.
 */
export function syncFixedCostsToLedger(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  monthKey?: string,
): number {
  const win = monthWindow(now, monthKey)
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, @currency, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, provider=excluded.provider, source_type=excluded.source_type,
      currency=excluded.currency, active=1, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES
      (@source_id, @start, @end, @charge_category, @service_name,
       NULL, 1, 'month', @billed_cost, NULL, @currency,
       @confidence, @now, NULL, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, charge_category=excluded.charge_category,
      service_name=excluded.service_name, currency=excluded.currency,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness
  `)
  const tx = db.transaction((entries: CostOpsConfig['fixed_costs']) => {
    let count = 0
    for (const e of entries) {
      upsertSource.run({
        id: e.source_id, name: e.name, provider: e.provider,
        source_type: e.source_type, currency: e.currency ?? config.currency, now,
      })
      upsertLine.run({
        source_id: e.source_id, start: win.start, end: win.end,
        charge_category: e.charge_category ?? 'subscription', service_name: e.name,
        billed_cost: e.amount, currency: e.currency ?? config.currency,
        confidence: e.confidence ?? 'manual', now,
        dedup_key: `fixed|${e.source_id}|${win.key}`,
      })
      count++
    }
    return count
  })
  return tx(config.fixed_costs)
}

// ---- read path: deterministic monthly summary ------------------------------

export interface CostSummary {
  month: string
  currency: string
  current_spend: number
  forecast_month_end: number
  top_sources: Array<{ source_id: string; name: string; spend: number }>
  // Full list of every configured/active source (not capped) -- top_sources is
  // the top-5 by spend; all_sources is the complete set for the dashboard table.
  all_sources: Array<{ source_id: string; name: string; provider: string; source_type: string; spend: number; confidence: string }>
  confidence_breakdown: Record<string, number>
  breakdown: { fixed_manual: number; provider: number; estimate: number }
  budget: {
    id: string
    amount: number
    used_pct: number
    forecast_pct: number
    status: 'ok' | 'warning' | 'hard'
    warning_threshold: number
    hard_threshold: number
  } | null
  token_usage: {
    note: string
    calls: number
    agents: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }
  // v0.2: deterministic token-cost ESTIMATE (separate from fixed/manual spend).
  token_cost_estimate: TokenCostEstimate
  // current_spend (fixed/manual) + token_cost_estimate.total -- clearly labeled,
  // NOT folded into current_spend.
  estimated_total_with_token_cost: number
  // v0.3: per-source estimate-vs-actual (only sources that have a provider_api line).
  reconcile: Array<{ source_id: string; estimate: number; actual: number; variance: number; resolved_confidence: string }>
  // v0.3: last collector run per provider (from import_runs).
  provider_sync: Array<{ provider: string; collector_name: string; status: string; imported_count: number; data_freshness_at: number | null; last_sync: number; stale: boolean; error_code: string | null }>
  // v0.3 Render plan-based estimate (ADVISORY -- NOT in current_spend). null until a Render import.
  render_plan: {
    currency: string
    plan_estimate_total: number
    manual_estimate: number
    variance: number
    confidence: string
    data_freshness_at: number | null
    not_covered: string[]
  } | null
  data_freshness: number | null
  config_present: boolean
  config_errors: string[]
  generated_at: number
}

interface LineRow {
  source_id: string
  billed_cost: number
  charge_category: string
  confidence: CostConfidence
  data_freshness: number
}

export function getCostSummary(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  opts: { monthKey?: string; configExists?: boolean; configErrors?: string[] } = {},
): CostSummary {
  const win = monthWindow(now, opts.monthKey)

  const lines = db.prepare(`
    SELECT source_id, billed_cost, charge_category, confidence, data_freshness
    FROM cost_line_items
    WHERE charge_period_start < @end AND charge_period_end > @start
  `).all({ start: win.start, end: win.end }) as LineRow[]

  let current_spend = 0
  let forecast_month_end = 0
  const confidence_breakdown: Record<string, number> = {}
  const breakdown = { fixed_manual: 0, provider: 0, estimate: 0 }
  const perSource = new Map<string, number>()
  const perSourceConfidence = new Map<string, string>()
  let latestFreshness: number | null = null

  // Group lines per source. The HEADLINE spend resolves each source to its
  // single highest-confidence line (v0.3: a provider_api actual supersedes the
  // manual/estimate WITHOUT double-counting), while all lines are kept for the
  // estimate-vs-actual reconcile view.
  // provider_plan_estimate lines are ADVISORY -- excluded from the headline
  // current_spend and from all_sources; they surface only in the render_plan block.
  const headlineLines = lines.filter(l => !ADVISORY_CONF.has(l.confidence))
  const planLines = lines.filter(l => ADVISORY_CONF.has(l.confidence))
  const advisorySourceIds = new Set(planLines.map(l => l.source_id))
  const bySource = new Map<string, LineRow[]>()
  for (const l of headlineLines) {
    const arr = bySource.get(l.source_id); if (arr) arr.push(l); else bySource.set(l.source_id, [l])
  }
  for (const l of lines) {
    if (latestFreshness === null || l.data_freshness > latestFreshness) latestFreshness = l.data_freshness
  }
  const EST_CONF = ['manual', 'estimate', 'local_usage']
  const ACT_CONF = ['provider_api', 'billing_export', 'actual_invoice']
  const reconcile: CostSummary['reconcile'] = []
  for (const [sid, ls] of bySource) {
    const resolved = ls.reduce((a, b) => (CONF_PRIORITY[b.confidence] || 0) > (CONF_PRIORITY[a.confidence] || 0) ? b : a)
    current_spend += resolved.billed_cost
    forecast_month_end += resolved.charge_category === 'usage'
      ? resolved.billed_cost / win.fractionElapsed
      : resolved.billed_cost
    confidence_breakdown[resolved.confidence] = (confidence_breakdown[resolved.confidence] || 0) + resolved.billed_cost
    breakdown[confidenceBucket(resolved.confidence)] += resolved.billed_cost
    perSource.set(sid, resolved.billed_cost)
    perSourceConfidence.set(sid, resolved.confidence)
    const estAmt = ls.filter(l => EST_CONF.includes(l.confidence)).reduce((s, l) => s + l.billed_cost, 0)
    const actAmt = ls.filter(l => ACT_CONF.includes(l.confidence)).reduce((s, l) => s + l.billed_cost, 0)
    if (actAmt > 0) reconcile.push({ source_id: sid, estimate: round2(estAmt), actual: round2(actAmt), variance: round2(actAmt - estAmt), resolved_confidence: resolved.confidence })
  }
  current_spend = round2(current_spend)
  forecast_month_end = round2(forecast_month_end)

  // resolve source metadata (name/provider/source_type) for every active source
  const srcRows = db.prepare(`SELECT id, name, provider, source_type FROM cost_sources WHERE active = 1`).all() as Array<{ id: string; name: string; provider: string; source_type: string }>
  const nameMap = new Map(srcRows.map(r => [r.id, r.name]))
  const top_sources = [...perSource.entries()]
    .map(([source_id, spend]) => ({ source_id, name: nameMap.get(source_id) || source_id, spend: round2(spend) }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5)

  // Full list: every configured/active source with spend (0 if none this month).
  // Advisory-only sources (render-plan / provider_plan_estimate) are excluded --
  // they appear in the render_plan block, never in the headline source list.
  const all_sources = srcRows
    .filter(r => !advisorySourceIds.has(r.id))
    .map(r => ({
      source_id: r.id, name: r.name, provider: r.provider, source_type: r.source_type,
      spend: round2(perSource.get(r.id) || 0), confidence: perSourceConfidence.get(r.id) || 'manual',
    }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

  // v0.3 Render plan-based estimate (ADVISORY): manual render estimate vs plan-based
  // estimate vs variance. NEVER folded into current_spend. Empty until a Render import.
  const plan_estimate_total = round2(planLines.reduce((s, l) => s + l.billed_cost, 0))
  const manual_render_estimate = round2(
    srcRows.filter(r => r.provider === 'render' && !advisorySourceIds.has(r.id))
      .reduce((s, r) => s + (perSource.get(r.id) || 0), 0),
  )
  const planFreshness = planLines.reduce((m, l) => Math.max(m, l.data_freshness), 0) || null
  const render_plan: CostSummary['render_plan'] = planLines.length > 0 ? {
    currency: config.currency,
    plan_estimate_total,
    manual_estimate: manual_render_estimate,
    variance: round2(plan_estimate_total - manual_render_estimate),
    confidence: 'provider_plan_estimate',
    data_freshness_at: planFreshness,
    not_covered: RENDER_NOT_COVERED,
  } : null

  // budget (first budget, or the 'global-monthly' one if present)
  const budgetDef = config.budgets.find(b => b.id === 'global-monthly') || config.budgets[0] || null
  let budget: CostSummary['budget'] = null
  if (budgetDef && budgetDef.amount > 0) {
    const warning = budgetDef.warning_threshold ?? 0.8
    const hard = budgetDef.hard_threshold ?? 1.0
    const used_pct = current_spend / budgetDef.amount
    const forecast_pct = forecast_month_end / budgetDef.amount
    // Status is display-only. No action is ever taken here.
    const status: 'ok' | 'warning' | 'hard' =
      used_pct >= hard ? 'hard' : used_pct >= warning ? 'warning' : 'ok'
    budget = {
      id: budgetDef.id, amount: budgetDef.amount,
      used_pct: round4(used_pct), forecast_pct: round4(forecast_pct),
      status, warning_threshold: warning, hard_threshold: hard,
    }
  }

  // token_usage: VOLUME/ACTIVITY only -- NOT priced in v0.1 (no model column).
  const tu = db.prepare(`
    SELECT COUNT(*) as calls, COUNT(DISTINCT agent) as agents,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens,
      COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens),0) as cache_creation_tokens
    FROM token_usage WHERE timestamp >= @start AND timestamp < @end
  `).get({ start: win.start, end: win.end }) as {
    calls: number; agents: number; input_tokens: number; output_tokens: number
    cache_read_tokens: number; cache_creation_tokens: number
  }

  // v0.2 token-cost estimate (deterministic; unknown model / no rate -> unpriced).
  const pricing = opts.pricing ?? { version: 1, currency: config.currency, models: {} }
  const token_cost_estimate = getTokenCostEstimate(db, pricing, opts.pricingExists ?? false, win.start, win.end)
  const estimated_total_with_token_cost = round2(current_spend + token_cost_estimate.total_estimated_huf)

  // v0.3 per-source estimate-vs-actual reconciliation
  const reconcile: Array<{ source_id: string; estimate: number; actual: number; variance: number; resolved_confidence: string }> = []

  // v0.3 provider sync status: the latest import_runs row per provider.
  const STALE_SECS = 3 * 24 * 3600
  const syncRows = db.prepare(`
    SELECT provider, collector_name, status, imported_count, data_freshness_at, started_at, error_code
    FROM import_runs r
    WHERE started_at = (SELECT MAX(started_at) FROM import_runs WHERE provider = r.provider)
    GROUP BY provider
  `).all() as Array<{ provider: string; collector_name: string; status: string; imported_count: number; data_freshness_at: number | null; started_at: number; error_code: string | null }>
  const provider_sync = syncRows.map(r => ({
    provider: r.provider, collector_name: r.collector_name, status: r.status,
    imported_count: r.imported_count, data_freshness_at: r.data_freshness_at, last_sync: r.started_at,
    stale: r.data_freshness_at != null ? (now - r.data_freshness_at) > STALE_SECS : true,
    error_code: r.error_code,
  }))

  return {
    month: win.key,
    currency: config.currency,
    current_spend,
    forecast_month_end,
    top_sources,
    all_sources,
    confidence_breakdown: roundValues(confidence_breakdown),
    breakdown: { fixed_manual: round2(breakdown.fixed_manual), provider: round2(breakdown.provider), estimate: round2(breakdown.estimate) },
    budget,
    token_usage: {
      note: 'volume/activity only -- not priced in v0.1 (token_usage has no model column; token->cost mapping lands in v0.2 after model/session enrichment)',
      calls: tu.calls, agents: tu.agents,
      input_tokens: tu.input_tokens, output_tokens: tu.output_tokens,
      cache_read_tokens: tu.cache_read_tokens, cache_creation_tokens: tu.cache_creation_tokens,
    },
    token_cost_estimate,
    estimated_total_with_token_cost,
    reconcile,
    provider_sync,
    render_plan,
    data_freshness: latestFreshness,
    config_present: opts.configExists ?? true,
    config_errors: opts.configErrors ?? [],
    generated_at: now,
  }
}

export function getCostSources(db: Database.Database): unknown[] {
  return db.prepare(`SELECT id, name, provider, source_type, currency, active, updated_at FROM cost_sources WHERE active = 1 ORDER BY name`).all()
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round4(n: number): number { return Math.round(n * 10000) / 10000 }
function roundValues(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = round2(v)
  return out
}
