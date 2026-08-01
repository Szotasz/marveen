// CostOps v0.1 -- deterministic cost ledger core.
//
// Pure SQL + arithmetic. NO LLM, no network, no secrets. `db` and `now` are
// passed in so every function is deterministic and unit-testable against an
// in-memory database. FOCUS-inspired: cost_sources (ProviderName/BillingAccount),
// cost_line_items (ChargeRow: ChargePeriod, ChargeCategory, BilledCost,
// ConsumedQuantity/Unit, confidence), budgets (display-only).

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  normalizeProject,
  monthlyAmount,
  toDisplayCurrency,
  SHARED_PROJECT,
  type CostOpsConfig,
  type CostConfidence,
} from './config.js'
import {
  PRICE_MAP_VERSION,
  ZERO_COMPONENTS,
  priceTokens,
  dayKey,
  type TokenCostComponents,
} from './pricing.js'

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
    INSERT INTO cost_sources (id, name, provider, source_type, currency, project, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, @currency, @project, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, provider=excluded.provider, source_type=excluded.source_type,
      currency=excluded.currency, project=excluded.project, active=1, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES
      (@source_id, @start, @end, @charge_category, @service_name,
       @usage_type, 1, 'month', @billed_cost, NULL, @currency,
       @confidence, @now, NULL, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, charge_category=excluded.charge_category,
      service_name=excluded.service_name, currency=excluded.currency,
      usage_type=excluded.usage_type,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness
  `)
  const tx = db.transaction((entries: CostOpsConfig['fixed_costs']) => {
    let count = 0
    for (const e of entries) {
      upsertSource.run({
        id: e.source_id, name: e.name, provider: e.provider,
        source_type: e.source_type, currency: e.currency ?? config.currency,
        project: normalizeProject(e.project), now,
      })
      upsertLine.run({
        source_id: e.source_id, start: win.start, end: win.end,
        charge_category: e.charge_category ?? 'subscription', service_name: e.name,
        // A yearly cost lands as its monthly share (see monthlyAmount), tagged
        // so a reader can tell an amortized twelfth from a real monthly bill.
        billed_cost: monthlyAmount(e), usage_type: e.period === 'yearly' ? 'amortized_yearly' : null,
        currency: e.currency ?? config.currency,
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

export interface ProjectSpend {
  project: string
  /**
   * Real money for this project in the display currency, or null when at least
   * one of its currencies has no configured rate. Null means "cannot say", and
   * the UI must show it as such -- a partial sum presented as a total is the
   * kind of number people budget against.
   */
  spend_display: number | null
  /** The same money, per currency it was actually billed in. Always complete. */
  spend_by_currency: Record<string, number>
  /**
   * What this project's token volume would cost at published API rates. A
   * SEPARATE column, never added to spend: the subscription that pays for those
   * tokens is already in the money above, so summing the two double-counts.
   */
  ai_list_price_usd: number
  sources: string[]
}

export interface CostSummary {
  month: string
  currency: string
  current_spend: number
  forecast_month_end: number
  /** Money per currency as billed -- the unconverted truth behind current_spend. */
  spend_by_currency: Record<string, number>
  fx: {
    display_currency: string
    asof: string | null
    /** Currencies present in the ledger with no configured rate. */
    missing_rates: string[]
  }
  /** Per-project money and (separately) per-project token list-price equivalent. */
  by_project: ProjectSpend[]
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
    /**
     * What this token volume would cost at published API rates. Reported
     * alongside the money ledger, never summed into it: the operator is on a
     * subscription that already appears in current_spend as a fixed cost, so
     * adding this on top would double-count.
     */
    list_price_equivalent: {
      basis: 'list_price_equivalent'
      currency: 'USD'
      total: number
      components: TokenCostComponents
      price_map_version: string
      unpriced_calls: number
    }
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
  currency: string
  project: string | null
}

export function getCostSummary(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  opts: { monthKey?: string; configExists?: boolean; configErrors?: string[] } = {},
): CostSummary {
  const win = monthWindow(now, opts.monthKey)

  // The source join carries currency and project down to the line, so the
  // money can be grouped by both without a second pass over the ledger.
  const lines = db.prepare(`
    SELECT li.source_id, li.billed_cost, li.charge_category, li.confidence, li.data_freshness,
           li.currency, cs.project
    FROM cost_line_items li
    LEFT JOIN cost_sources cs ON cs.id = li.source_id
    WHERE li.charge_period_start < @end AND li.charge_period_end > @start
  `).all({ start: win.start, end: win.end }) as LineRow[]

  let current_spend = 0
  let forecast_month_end = 0
  const confidence_breakdown: Record<string, number> = {}
  const breakdown = { fixed_manual: 0, provider: 0, estimate: 0 }
  const perSource = new Map<string, number>()
  const perSourceConfidence = new Map<string, string>()
  const spend_by_currency: Record<string, number> = {}
  const missingRates = new Set<string>()
  // project -> per-currency money, kept unconverted until the very end
  const perProject = new Map<string, { byCurrency: Record<string, number>; sources: Set<string> }>()
  let latestFreshness: number | null = null

  for (const l of lines) {
    const currency = (l.currency || config.currency).toUpperCase()
    const converted = toDisplayCurrency(l.billed_cost, currency, config)
    // A line we cannot convert is NOT dropped from the per-currency view and
    // NOT counted at face value in the display total. Adding an unconverted
    // 20 USD to a HUF total is not a rounding error, it is a wrong number.
    if (converted === null) missingRates.add(currency)
    const display = converted ?? 0

    current_spend += display
    // Usage-type lines are prorated to month-end; committed/fixed lines are
    // already whole-month (no proration).
    forecast_month_end += l.charge_category === 'usage'
      ? display / win.fractionElapsed
      : display
    confidence_breakdown[l.confidence] = (confidence_breakdown[l.confidence] || 0) + display
    breakdown[confidenceBucket(l.confidence)] += display
    perSource.set(l.source_id, (perSource.get(l.source_id) || 0) + display)
    perSourceConfidence.set(l.source_id, l.confidence)
    spend_by_currency[currency] = round2((spend_by_currency[currency] || 0) + l.billed_cost)

    const project = normalizeProject(l.project)
    const bucket = perProject.get(project) ?? { byCurrency: {}, sources: new Set<string>() }
    bucket.byCurrency[currency] = round2((bucket.byCurrency[currency] || 0) + l.billed_cost)
    bucket.sources.add(l.source_id)
    perProject.set(project, bucket)

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

  // token_usage volume, plus (v0.2) its list-price equivalent. The two are
  // reported side by side but kept out of current_spend on purpose -- see the
  // field doc on CostSummary.token_usage.
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

  const tokenCost = getTokenCostReport(db, { start: win.start, end: win.end })

  // Per-project view: money (per currency, converted only where a rate exists)
  // next to the token list-price equivalent, which stays its own column.
  // A project can appear on either side alone -- a project with tokens but no
  // subscription is real, and so is the reverse.
  const tokenByProject = new Map(tokenCost.by_project.map(p => [p.project, p.cost]))
  const projectNames = new Set<string>([...perProject.keys(), ...tokenByProject.keys()])
  const by_project: ProjectSpend[] = [...projectNames].map(project => {
    const money = perProject.get(project)
    const byCurrency = money?.byCurrency ?? {}
    let display: number | null = 0
    for (const [currency, amount] of Object.entries(byCurrency)) {
      const converted = toDisplayCurrency(amount, currency, config)
      if (converted === null) { display = null; break }
      display += converted
    }
    return {
      project,
      spend_display: display === null ? null : round2(display),
      spend_by_currency: byCurrency,
      ai_list_price_usd: round4(tokenByProject.get(project) ?? 0),
      sources: [...(money?.sources ?? [])].sort(),
    }
  }).sort((a, b) =>
    (b.spend_display ?? 0) - (a.spend_display ?? 0) ||
    b.ai_list_price_usd - a.ai_list_price_usd ||
    a.project.localeCompare(b.project),
  )

  return {
    month: win.key,
    currency: config.currency,
    current_spend,
    forecast_month_end,
    spend_by_currency,
    fx: {
      display_currency: config.currency,
      asof: config.fx_asof ?? null,
      missing_rates: [...missingRates].sort(),
    },
    by_project,
    top_sources,
    all_sources,
    confidence_breakdown: roundValues(confidence_breakdown),
    breakdown: { fixed_manual: round2(breakdown.fixed_manual), provider: round2(breakdown.provider), estimate: round2(breakdown.estimate) },
    budget,
    token_usage: {
      note: 'volume plus a LIST-PRICE EQUIVALENT (v0.2): what this token volume would cost at published API rates. Not money owed and never added to current_spend -- the subscription is already counted there as a fixed cost.',
      calls: tu.calls, agents: tu.agents,
      input_tokens: tu.input_tokens, output_tokens: tu.output_tokens,
      cache_read_tokens: tu.cache_read_tokens, cache_creation_tokens: tu.cache_creation_tokens,
      list_price_equivalent: {
        basis: 'list_price_equivalent',
        currency: 'USD',
        total: tokenCost.total,
        components: tokenCost.components,
        price_map_version: tokenCost.price_map_version,
        unpriced_calls: tokenCost.unpriced.calls,
      },
    },
    data_freshness: latestFreshness,
    config_present: opts.configExists ?? true,
    config_errors: opts.configErrors ?? [],
    generated_at: now,
  }
}

// ---- read path: token list-price equivalent (CostOps v0.2) -----------------

export interface TokenCostReport {
  /** Always this literal. Not money owed -- see pricing.ts for why. */
  basis: 'list_price_equivalent'
  currency: 'USD'
  price_map_version: string
  window: { start: number; end: number; timezone: string }
  total: number
  components: TokenCostComponents
  by_model: Array<{ model: string; calls: number; cost: number }>
  by_agent: Array<{ agent: string; calls: number; cost: number }>
  /**
   * Per project, from token_usage.project. Rows with no project land under
   * UNTAGGED_PROJECT rather than being dropped or spread across the labelled
   * ones -- as of 2026-07-31 that is 55% of the spend, and hiding it would
   * make every per-project figure look more complete than it is.
   */
  by_project: Array<{ project: string; calls: number; cost: number }>
  by_day: Array<{ day: string; cost: number }>
  /**
   * Rows we hold no published rate for. Surfaced rather than folded into the
   * total as zero, so an unrecognised model shows up as a gap instead of
   * quietly shrinking the figure.
   */
  unpriced: { calls: number; models: string[] }
}

interface UsageRow {
  model: string | null
  agent: string
  project: string | null
  timestamp: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

/** Where token usage with no project label is reported. Never hidden. */
export const UNTAGGED_PROJECT = '(untagged)'

/**
 * List-price-equivalent token cost over an epoch-second window, [start, end).
 *
 * Rows are aggregated in JS rather than SQL because the day bucketing needs a
 * named timezone that SQLite cannot apply deterministically under test. The
 * window is indexed (idx_token_usage_ts) and a month of fleet traffic is a few
 * thousand rows, so the read stays cheap; revisit if the retention window grows
 * by orders of magnitude.
 */
export function getTokenCostReport(
  db: Database.Database,
  opts: { start: number; end: number; timeZone?: string },
): TokenCostReport {
  const timeZone = opts.timeZone ?? 'Europe/Budapest'
  const rows = db.prepare(`
    SELECT model, agent, project, timestamp, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens
    FROM token_usage
    WHERE timestamp >= @start AND timestamp < @end
  `).all({ start: opts.start, end: opts.end }) as UsageRow[]

  const components: TokenCostComponents = { ...ZERO_COMPONENTS }
  const perModel = new Map<string, { calls: number; cost: number }>()
  const perAgent = new Map<string, { calls: number; cost: number }>()
  const perProject = new Map<string, { calls: number; cost: number }>()
  const perDay = new Map<string, number>()
  const unpricedModels = new Set<string>()
  let unpricedCalls = 0

  for (const r of rows) {
    const priced = priceTokens(r.model, r)
    if (!priced) {
      unpricedCalls++
      unpricedModels.add(r.model ?? '(null)')
      continue
    }
    components.input += priced.input
    components.output += priced.output
    components.cache_read += priced.cache_read
    components.cache_write += priced.cache_write
    components.total += priced.total

    const model = r.model as string
    const m = perModel.get(model) ?? { calls: 0, cost: 0 }
    m.calls++; m.cost += priced.total; perModel.set(model, m)

    const a = perAgent.get(r.agent) ?? { calls: 0, cost: 0 }
    a.calls++; a.cost += priced.total; perAgent.set(r.agent, a)

    const projectKey = (r.project ?? '').trim() || UNTAGGED_PROJECT
    const p = perProject.get(projectKey) ?? { calls: 0, cost: 0 }
    p.calls++; p.cost += priced.total; perProject.set(projectKey, p)

    const d = dayKey(r.timestamp, timeZone)
    perDay.set(d, (perDay.get(d) ?? 0) + priced.total)
  }

  return {
    basis: 'list_price_equivalent',
    currency: 'USD',
    price_map_version: PRICE_MAP_VERSION,
    window: { start: opts.start, end: opts.end, timezone: timeZone },
    total: round4(components.total),
    components: {
      input: round4(components.input),
      output: round4(components.output),
      cache_read: round4(components.cache_read),
      cache_write: round4(components.cache_write),
      total: round4(components.total),
    },
    by_model: [...perModel.entries()]
      .map(([model, v]) => ({ model, calls: v.calls, cost: round4(v.cost) }))
      .sort((a, b) => b.cost - a.cost),
    by_agent: [...perAgent.entries()]
      .map(([agent, v]) => ({ agent, calls: v.calls, cost: round4(v.cost) }))
      .sort((a, b) => b.cost - a.cost),
    by_project: [...perProject.entries()]
      .map(([project, v]) => ({ project, calls: v.calls, cost: round4(v.cost) }))
      .sort((a, b) => b.cost - a.cost),
    by_day: [...perDay.entries()]
      .map(([day, cost]) => ({ day, cost: round4(cost) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    unpriced: { calls: unpricedCalls, models: [...unpricedModels].sort() },
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
