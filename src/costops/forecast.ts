// CostOps -- Phase 1 forecasting (GAP-10 / core-functional-scope-v1.0.1.md §10).
//
// Pure, deterministic, I/O-free computation layer -- one function per forecast
// method (fixed subscription, time-proportional usage, balance-delta, invoice
// cadence, one-time, manual override), a dispatcher that picks a method per
// source, and forecast-vs-actual / forecast-error scoring once a month closes.
// NO db.ts/web.ts edits: `initForecastSchema` is a schema DEFINER only, not
// mounted anywhere yet -- the seam-refactor's `initCostOpsSchema(db)`
// aggregator (Mason, accounting-core seam) calls it, per
// docs/fork-upstream-policy.md §2a's thin-seam rule.

import type Database from 'better-sqlite3'
import type { MonthWindow } from './ledger.js'
import type { CostConfidence } from './config.js'
import { deriveMtdSpend, type BalanceSnapshot } from './collectors/deepseek.js'

// ---- shared types ------------------------------------------------------------

export type ForecastMethod =
  | 'fixed_subscription'
  | 'time_proportional_usage'
  | 'balance_delta'
  | 'invoice_cadence'
  | 'one_time'
  | 'manual_forecast'

export type ForecastConfidence = 'high' | 'medium' | 'low'

export interface ForecastResult {
  method: ForecastMethod
  amount: number
  confidence: ForecastConfidence
  note: string
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round4(n: number): number { return Math.round(n * 10000) / 10000 }

// ---- method 1: fixed monthly subscription / hosting / SaaS -------------------

/**
 * A fixed recurring fee (subscription, hosting, SaaS, domain) is owed in full
 * for the period whether observed on day 1 or day 30 -- NEVER prorated by
 * elapsed time (that would understate a fee seen early in the month).
 * Confidence reflects how the AMOUNT itself was sourced: an invoice/provider-
 * observed amount is a known fact (high); a manual/estimate amount is a known
 * fee but self-reported (medium) -- never low, a fixed fee is not volatile.
 */
export function forecastFixedSubscription(periodAmount: number, dataConfidence: CostConfidence = 'manual'): ForecastResult {
  const confidence: ForecastConfidence =
    dataConfidence === 'actual_invoice' || dataConfidence === 'provider_api' || dataConfidence === 'billing_export'
      ? 'high' : 'medium'
  return {
    method: 'fixed_subscription',
    amount: round2(periodAmount),
    confidence,
    note: 'fixed monthly fee -- full period amount, not prorated (a fixed cost is owed whether seen day 1 or day 30)',
  }
}

// ---- method 2: time-proportional usage ----------------------------------------

// Below this fraction of the month elapsed, a straight run-rate is noisy (a
// single heavy day can double it) -- confidence buckets, not a hard cutoff.
const EARLY_MONTH_FRACTION = 0.15
const MID_MONTH_FRACTION = 0.5

/**
 * Variable usage costs (metered API calls, token spend): month-end forecast =
 * MTD amount scaled by the inverse of the elapsed fraction (a straight
 * run-rate). Confidence rises as more of the month has actually been observed.
 */
export function forecastTimeProportionalUsage(mtdAmount: number, win: MonthWindow): ForecastResult {
  const projected = mtdAmount / win.fractionElapsed
  const confidence: ForecastConfidence =
    win.fractionElapsed < EARLY_MONTH_FRACTION ? 'low'
    : win.fractionElapsed < MID_MONTH_FRACTION ? 'medium'
    : 'high'
  return {
    method: 'time_proportional_usage',
    amount: round2(projected),
    confidence,
    note: `variable usage -- run-rate from ${Math.round(win.fractionElapsed * 100)}% of the month observed`,
  }
}

// ---- method 3: balance-delta (prepaid providers, e.g. DeepSeek) --------------

// Below this observed span, a burn rate is too noisy to extrapolate from --
// mirrors collectors/deepseek.ts's exhaustion-forecast guard, but a month-end
// AMOUNT forecast degrades to "MTD only" instead of returning null (there is
// always a real MTD figure to show, unlike an exhaustion date).
const MIN_FORECAST_SPAN_SECONDS = 86400

/**
 * Prepaid-balance sources: spend is derived from balance DROPS between
 * snapshots (reuses `deriveMtdSpend` from collectors/deepseek.ts -- one
 * definition of "a rise is a top-up, ignore it", not reimplemented here).
 * Month-end forecast = this month's observed spend + (daily burn rate,
 * computed from ALL supplied snapshots for a steadier base) * remaining days.
 */
export function forecastBalanceDelta(snapshotsAsc: BalanceSnapshot[], win: MonthWindow, now: number): ForecastResult {
  const monthSnapshots = snapshotsAsc.filter(s => s.captured_at >= win.start && s.captured_at < win.end)
  const mtd = deriveMtdSpend(monthSnapshots)

  if (snapshotsAsc.length < 2) {
    return { method: 'balance_delta', amount: round2(mtd), confidence: 'low', note: 'balance-delta: fewer than 2 snapshots -- MTD spend only, no extrapolation' }
  }
  const first = snapshotsAsc[0]
  const last = snapshotsAsc[snapshotsAsc.length - 1]
  const spanSeconds = last.captured_at - first.captured_at
  const allSpend = deriveMtdSpend(snapshotsAsc)
  if (spanSeconds < MIN_FORECAST_SPAN_SECONDS || allSpend <= 0) {
    return { method: 'balance_delta', amount: round2(mtd), confidence: 'low', note: 'balance-delta: insufficient span or no net spend observed -- MTD only, no extrapolation' }
  }
  const dailyBurn = allSpend / (spanSeconds / 86400)
  const remainingDays = Math.max(0, (win.end - now) / 86400)
  const projected = mtd + dailyBurn * remainingDays
  const confidence: ForecastConfidence =
    spanSeconds < 3 * 86400 ? 'low'
    : spanSeconds < 10 * 86400 ? 'medium'
    : 'high'
  return {
    method: 'balance_delta',
    amount: round2(projected),
    confidence,
    note: `balance-delta: MTD ${round2(mtd)} + ${round2(dailyBurn)}/day burn * ${round2(remainingDays)} remaining days`,
  }
}

// ---- method 4: invoice cadence (non-monthly billing) --------------------------

export type BillingCadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual'

const CADENCE_MONTHS: Record<BillingCadence, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }

/**
 * A cost billed less often than monthly (annual domain renewal, quarterly
 * SaaS plan): the forecast contribution for THIS month is an ACCRUAL --
 * the last known invoice divided evenly across its cadence -- not "the whole
 * annual fee lands in one month." If the current month IS the actual invoice
 * month, the full amount is used instead (the real cash event), via
 * `isInvoiceMonth` -- the caller knows the renewal/billing date, this
 * function does not guess it.
 */
export function forecastInvoiceCadence(
  lastInvoiceAmount: number,
  cadence: BillingCadence,
  opts: { isInvoiceMonth?: boolean } = {},
): ForecastResult {
  const months = CADENCE_MONTHS[cadence]
  if (opts.isInvoiceMonth) {
    return { method: 'invoice_cadence', amount: round2(lastInvoiceAmount), confidence: 'high', note: `invoice cadence (${cadence}): this month is the invoice month -- full amount` }
  }
  const monthlyAccrual = lastInvoiceAmount / months
  return {
    method: 'invoice_cadence',
    amount: round2(monthlyAccrual),
    confidence: months === 1 ? 'high' : 'medium',
    note: `invoice cadence (${cadence}): ${round2(lastInvoiceAmount)} / ${months} months monthly accrual, not an invoice month`,
  }
}

// ---- method 5: one-time cost ---------------------------------------------------

/**
 * A one-time cost is never extrapolated from a run-rate. Already occurred
 * this month -> the forecast equals the actual (no further growth expected).
 * Not yet occurred -> 0 unless a planned amount is explicitly known in
 * advance (e.g. a scheduled one-off) -- never fabricated.
 */
export function forecastOneTime(occurredAmount: number | null, plannedAmount: number | null = null): ForecastResult {
  if (occurredAmount != null) {
    return { method: 'one_time', amount: round2(occurredAmount), confidence: 'high', note: 'one-time cost already occurred this month -- forecast equals the actual, no extrapolation' }
  }
  if (plannedAmount != null) {
    return { method: 'one_time', amount: round2(plannedAmount), confidence: 'medium', note: 'one-time cost planned but not yet occurred -- forecast uses the known planned amount' }
  }
  return { method: 'one_time', amount: 0, confidence: 'low', note: 'one-time cost not yet occurred and no planned amount known -- forecast 0, never fabricated from a run-rate' }
}

// ---- method 6: manual override -------------------------------------------------

/** An operator-entered forecast figure, not derived from any observed data. */
export function forecastManual(manualEstimate: number): ForecastResult {
  return { method: 'manual_forecast', amount: round2(manualEstimate), confidence: 'low', note: 'operator-entered manual forecast -- not derived from observed data' }
}

// ---- dispatcher: pick a method per source --------------------------------------

export interface ForecastContext {
  mtd_amount: number
  win: MonthWindow
  now: number
  data_confidence?: CostConfidence
  balance_snapshots?: BalanceSnapshot[]
  cadence?: BillingCadence
  is_invoice_month?: boolean
  last_invoice_amount?: number
  charge_category?: string   // 'usage' | 'subscription' | 'purchase' | 'tax' | 'credit' | 'adjustment'
  occurred_amount?: number | null
  planned_amount?: number | null
  manual_override?: number
}

/**
 * Resolves ONE forecast method per source from context, in a fixed precedence
 * order (documented, not implicit):
 *   1. `manual_override` -- an operator's explicit figure always wins.
 *   2. `balance_snapshots` present -- prepaid-balance sources.
 *   3. non-monthly `cadence` + a known last invoice -- accrual/invoice-cadence.
 *   4. `charge_category === 'purchase'` -- one-time cost.
 *   5. `charge_category === 'usage'` -- time-proportional run-rate.
 *   6. default -- fixed monthly subscription/hosting/SaaS.
 */
export function resolveSourceForecast(ctx: ForecastContext): ForecastResult {
  if (ctx.manual_override != null) return forecastManual(ctx.manual_override)
  if (ctx.balance_snapshots && ctx.balance_snapshots.length > 0) return forecastBalanceDelta(ctx.balance_snapshots, ctx.win, ctx.now)
  if (ctx.cadence && ctx.cadence !== 'monthly' && ctx.last_invoice_amount != null) {
    return forecastInvoiceCadence(ctx.last_invoice_amount, ctx.cadence, { isInvoiceMonth: ctx.is_invoice_month })
  }
  if (ctx.charge_category === 'purchase') return forecastOneTime(ctx.occurred_amount ?? null, ctx.planned_amount ?? null)
  if (ctx.charge_category === 'usage') return forecastTimeProportionalUsage(ctx.mtd_amount, ctx.win)
  return forecastFixedSubscription(ctx.mtd_amount, ctx.data_confidence)
}

// ---- forecast-vs-actual / forecast error ---------------------------------------

export interface ForecastErrorResult {
  absolute_error: number        // actual - forecast; positive = under-forecast, negative = over-forecast
  percent_error: number | null  // (actual - forecast) / actual; null when actual is 0 (undefined, never fabricated)
}

/** Forecast-vs-actual once a month's real total is known (period close). */
export function computeForecastError(forecastAmount: number, actualAmount: number): ForecastErrorResult {
  return {
    absolute_error: round2(actualAmount - forecastAmount),
    percent_error: actualAmount !== 0 ? round4((actualAmount - forecastAmount) / actualAmount) : null,
  }
}

export interface ForecastAccuracyRecord {
  forecast_amount: number
  actual_amount: number
}

export interface ForecastAccuracySummary {
  key: string
  count: number
  mean_absolute_error: number
  mean_percent_error: number | null  // null only if every record's actual was 0
}

/**
 * Groups closed forecast/actual pairs by a caller-supplied key (provider,
 * category, source -- caller decides) and reports mean absolute + mean
 * percent error per group. GAP-10 acceptance: "provider- es kategoriaszintu
 * pontossag merheto." Pure aggregation, no DB access -- the aggregator
 * (Mason's seam) supplies already-closed rows from forecast_snapshots.
 */
export function summarizeForecastAccuracy<T extends ForecastAccuracyRecord>(records: T[], keyOf: (r: T) => string): ForecastAccuracySummary[] {
  const groups = new Map<string, T[]>()
  for (const r of records) {
    const k = keyOf(r)
    const arr = groups.get(k)
    if (arr) arr.push(r); else groups.set(k, [r])
  }
  const out: ForecastAccuracySummary[] = []
  for (const [key, rs] of groups) {
    const errors = rs.map(r => computeForecastError(r.forecast_amount, r.actual_amount))
    const mean_absolute_error = round2(errors.reduce((s, e) => s + Math.abs(e.absolute_error), 0) / errors.length)
    const pcts = errors.map(e => e.percent_error).filter((p): p is number => p !== null)
    const mean_percent_error = pcts.length > 0 ? round4(pcts.reduce((s, p) => s + Math.abs(p), 0) / pcts.length) : null
    out.push({ key, count: rs.length, mean_absolute_error, mean_percent_error })
  }
  return out.sort((a, b) => b.count - a.count)
}

// ---- snapshot dedup key (pure -- the actual INSERT is the aggregator's job) ----

/**
 * One snapshot per source (or the whole-deployment total, `sourceId: null`)
 * per calendar day (UTC) -- history is APPENDED across days, never
 * overwritten same-day, matching GAP-10's "naponta vagy fontos valtozaskor
 * snapshot keszul" / "minden snapshot reprodukalhato." Pure string
 * construction; the aggregator uses this as `forecast_snapshots.dedup_key`.
 */
export function forecastSnapshotDedupKey(sourceId: string | null, month: string, snapshotAt: number): string {
  const day = new Date(snapshotAt * 1000).toISOString().slice(0, 10)
  return `${sourceId ?? 'TOTAL'}|${month}|${day}`
}

// ---- schema (DEFINER ONLY -- not mounted; see file header) ---------------------

/**
 * Schema DEFINER only. NOT called from db.ts -- per fork-upstream-policy.md
 * §2a, the ONE seam mount (`initCostOpsSchema(db)` in db.ts calling this
 * among the module's other schema definers) is the seam-refactor's job, done
 * once alongside the rest of the accounting-core schema so db.ts gains a
 * single line, not another scattered inline CREATE TABLE. Safe to call more
 * than once (`IF NOT EXISTS`).
 *
 * `source_id` NULL = a whole-deployment TOTAL snapshot, never a sentinel
 * string. Rows are APPENDED (one per source per day via `dedup_key`), never
 * overwritten -- every historical forecast stays reproducible.
 * `actual_amount`/`forecast_error_*` stay NULL until period close fills them
 * in; a forecast row is never silently rewritten to look like it always knew
 * the actual.
 */
export function initForecastSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forecast_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT REFERENCES cost_sources(id),
      month TEXT NOT NULL,
      snapshot_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      forecast_amount REAL NOT NULL,
      confidence TEXT NOT NULL,
      note TEXT,
      actual_amount REAL,
      forecast_error_absolute REAL,
      forecast_error_percent REAL,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_month ON forecast_snapshots(month)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_source ON forecast_snapshots(source_id, month)`)
}
