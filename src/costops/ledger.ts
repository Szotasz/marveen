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

export type CostBucket = 'fixed_manual' | 'provider' | 'estimate'

export function confidenceBucket(c: CostConfidence): CostBucket {
  switch (c) {
    case 'actual_invoice':
    case 'provider_api':
    case 'billing_export':
      return 'provider'
    case 'estimate':
    case 'local_usage':
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

  for (const l of lines) {
    current_spend += l.billed_cost
    // Usage-type lines are prorated to month-end; committed/fixed lines are
    // already whole-month (no proration).
    forecast_month_end += l.charge_category === 'usage'
      ? l.billed_cost / win.fractionElapsed
      : l.billed_cost
    confidence_breakdown[l.confidence] = (confidence_breakdown[l.confidence] || 0) + l.billed_cost
    breakdown[confidenceBucket(l.confidence)] += l.billed_cost
    perSource.set(l.source_id, (perSource.get(l.source_id) || 0) + l.billed_cost)
    perSourceConfidence.set(l.source_id, l.confidence)
    if (latestFreshness === null || l.data_freshness > latestFreshness) latestFreshness = l.data_freshness
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
  const all_sources = srcRows
    .map(r => ({
      source_id: r.id, name: r.name, provider: r.provider, source_type: r.source_type,
      spend: round2(perSource.get(r.id) || 0), confidence: perSourceConfidence.get(r.id) || 'manual',
    }))
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

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
