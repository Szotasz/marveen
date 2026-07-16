// CostOps -- Phase 1 FX provenance (GAP-09 / core-functional-scope-v1.0.1.md §9).
//
// Pure, deterministic, I/O-free computation layer -- every converted amount
// carries its full provenance (original_amount/original_currency/fx_rate/
// fx_source/fx_date/conversion_method/huf_amount), a documented rounding
// policy, invoice-date-vs-service-date rate selection, a close-time freeze
// guard, and late-correction handling as an independent new event (never a
// rewrite of the original conversion). NO db.ts/web.ts/schema.ts edits:
// `initFxSchema` is a schema DEFINER only, not mounted anywhere -- the
// seam-refactor's `initCostOpsSchema(db)` aggregator (Mason, accounting-core
// seam, src/costops/schema.ts) calls it, per docs/fork-upstream-policy.md §2a.

import type Database from 'better-sqlite3'

// ---- shared types --------------------------------------------------------------

// Where a rate came from -- an audit fact, not a trust ranking (unlike
// CostConfidence in config.ts, which ranks the LINE ITEM's authoritativeness).
export type FxSource = 'render_pricing_config' | 'manual' | 'ecb' | 'provider_invoice' | 'other'

export type ConversionMethod =
  | 'invoice_date_rate'    // rate as of the invoice's own date (preferred whenever an invoice exists)
  | 'service_date_rate'    // rate as of the service/usage period (fallback when there's no invoice)
  | 'correction_date_rate' // a late correction/credit/refund, rated as of the CORRECTION event, not the original

export interface FxConversion {
  original_amount: number
  original_currency: string
  fx_rate: number
  fx_source: FxSource
  fx_date: number       // epoch seconds -- the date the RATE is for (see resolveRateDate)
  conversion_method: ConversionMethod
  huf_amount: number
  converted_at: number  // epoch seconds -- when this conversion was actually computed (audit, may differ from fx_date)
}

// ---- rate resolution + rounding policy ------------------------------------------

export interface FxRateTable {
  [currency: string]: number  // HUF per 1 unit of currency
}

/**
 * Resolves a currency to a HUF rate. HUF is ALWAYS rate 1 (identity)
 * regardless of what the table contains -- HUF never needs an external rate.
 * Returns null (never a fabricated 1 or 0) for a currency the table doesn't
 * cover, so the caller can surface "unpriced" the same way the rest of
 * CostOps never fabricates a missing amount.
 */
export function resolveFxRate(currency: string, rates: FxRateTable): number | null {
  const cur = currency.toUpperCase()
  if (cur === 'HUF') return 1
  const r = rates[cur]
  return typeof r === 'number' && isFinite(r) && r > 0 ? r : null
}

/**
 * HUF rounding policy: 2 decimal places -- matches the existing ledger
 * convention (src/costops/ledger.ts's private round2, duplicated here per
 * this module's own file-local-helper convention, same as every other
 * costops/*.ts file). HUF has no minor unit in circulation today, but
 * keeping 2dp precision here avoids compounding rounding error across a
 * chain of conversions/corrections; a DISPLAY layer rounds to whole forint
 * for presentation, this layer never does.
 */
export function roundHuf(n: number): number {
  return Math.round(n * 100) / 100
}

// ---- invoice-date vs service-date rate selection --------------------------------

export type RateDateBasis = 'invoice_date' | 'service_date'

/**
 * Which date's rate to use for a conversion. An invoice fixes the actual
 * transaction, so its own date's rate is preferred whenever an invoice date
 * is known. `service_date` (the line's charge/usage period) is the fallback
 * for lines with no invoice reference at all (e.g. a manual/estimate cost).
 */
export function resolveRateDate(invoiceDate: number | null, serviceDate: number): { date: number; basis: RateDateBasis } {
  if (invoiceDate != null) return { date: invoiceDate, basis: 'invoice_date' }
  return { date: serviceDate, basis: 'service_date' }
}

function methodForBasis(basis: RateDateBasis): ConversionMethod {
  return basis === 'invoice_date' ? 'invoice_date_rate' : 'service_date_rate'
}

// ---- the conversion itself --------------------------------------------------------

/**
 * Converts an original-currency amount to HUF with FULL provenance --
 * GAP-09's core acceptance criterion: every converted line carries
 * original_amount/original_currency/fx_rate/fx_source/fx_date/
 * conversion_method/huf_amount TOGETHER, never a bare converted number.
 * Returns null (never a fabricated conversion) when the currency has no
 * resolvable rate in `rates`.
 */
export function convertToHufWithProvenance(
  amount: number,
  currency: string,
  rates: FxRateTable,
  opts: { fxSource: FxSource; invoiceDate: number | null; serviceDate: number; now: number },
): FxConversion | null {
  const cur = currency.toUpperCase()
  const rate = resolveFxRate(cur, rates)
  if (rate == null) return null
  const { date, basis } = resolveRateDate(opts.invoiceDate, opts.serviceDate)
  return {
    original_amount: amount,
    original_currency: cur,
    fx_rate: rate,
    fx_source: opts.fxSource,
    fx_date: date,
    conversion_method: methodForBasis(basis),
    huf_amount: roundHuf(amount * rate),
    converted_at: opts.now,
  }
}

// ---- close-time FX freeze --------------------------------------------------------

export type PeriodStatus = 'open' | 'provisional' | 'closed' | 'reopened'

/**
 * GAP-09 acceptance: "closed honap nem valtozik kesobbi FX-frissites miatt."
 * A CLOSED period's already-stored FX conversion must never be silently
 * recomputed with a newer rate. `reopened` legitimately allows
 * recomputation -- that's an explicit, audited action (period-close
 * module's concern), not a silent background refresh.
 */
export function canRecomputeFx(status: PeriodStatus): boolean {
  return status !== 'closed'
}

// ---- late correction handling ------------------------------------------------------

export interface FxCorrectionInput {
  originalCurrency: string
  correctionAmountOriginalCurrency: number  // signed: negative = credit/refund reducing the original charge
  correctionDate: number
  correctionRate: number
  correctionSource: FxSource
  now: number
}

/**
 * A correction/credit/refund arriving after the original conversion is a
 * SEPARATE ledger event with its OWN fx rate/date -- rated as of the
 * correction event, never a rewrite of the original conversion (GAP-09:
 * "kesoi correction FX-kezelese"; mirrors GAP-14's void/supersede-not-
 * overwrite principle applied to the FX dimension specifically). The
 * original FxConversion this correction relates to is untouched by this
 * function -- it only ever produces a new, independent one.
 */
export function convertCorrectionToHuf(input: FxCorrectionInput): FxConversion {
  return {
    original_amount: input.correctionAmountOriginalCurrency,
    original_currency: input.originalCurrency.toUpperCase(),
    fx_rate: input.correctionRate,
    fx_source: input.correctionSource,
    fx_date: input.correctionDate,
    conversion_method: 'correction_date_rate',
    huf_amount: roundHuf(input.correctionAmountOriginalCurrency * input.correctionRate),
    converted_at: input.now,
  }
}

// ---- historical rate lookup (reproducibility) --------------------------------------

export interface FxRateRecord {
  currency: string
  rate: number
  fx_source: FxSource
  effective_date: number
}

/**
 * Finds the rate in effect for `currency` at `atDate` from a set of
 * historical rate records -- the MOST RECENT record with
 * effective_date <= atDate wins; a future rate is never applied to a past
 * date. Returns null (never fabricated) if no record exists at or before
 * atDate for that currency. Pure: caller supplies already-queried rows (the
 * aggregator reads them from the `fx_rates` table `initFxSchema` defines).
 * This is what makes GAP-09's "ugyanaz a ledger-sor reprodukalhato
 * HUF-erteket ad" acceptance criterion possible: re-running a conversion
 * against the SAME historical snapshot always resolves the same rate, even
 * after the live/current rate has since moved on.
 */
export function lookupHistoricalRate(records: FxRateRecord[], currency: string, atDate: number): FxRateRecord | null {
  const cur = currency.toUpperCase()
  const candidates = records.filter(r => r.currency.toUpperCase() === cur && r.effective_date <= atDate)
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (b.effective_date > a.effective_date ? b : a))
}

/**
 * One recorded rate per (currency, source, UTC day) -- multiple captures the
 * same day update in place rather than accumulating noise, while still
 * keeping day-level history for `lookupHistoricalRate`. Pure string
 * construction; the aggregator uses this as `fx_rates.dedup_key`.
 */
export function fxRateDedupKey(currency: string, source: FxSource, effectiveDate: number): string {
  const day = new Date(effectiveDate * 1000).toISOString().slice(0, 10)
  return `${currency.toUpperCase()}|${source}|${day}`
}

// ---- schema (DEFINER ONLY -- not mounted; see file header) -----------------------------

/**
 * Schema DEFINER only. NOT called from db.ts or src/costops/schema.ts -- per
 * fork-upstream-policy.md §2a, the ONE seam mount (`initCostOpsSchema(db)` in
 * schema.ts calling this among the module's other schema definers) is the
 * seam-refactor's job. Safe to call more than once (`IF NOT EXISTS` /
 * `ADD COLUMN` wrapped in try/catch, matching schema.ts's own convention).
 *
 * Adds two things:
 * 1. `fx_source` / `conversion_method` columns on `cost_line_items` --
 *    additive to the `original_amount`/`original_currency`/`fx_rate`/
 *    `fx_date` columns schema.ts already has (v0.7); nullable, no default,
 *    every write site sets them explicitly.
 * 2. `fx_rates`: an APPENDED history of every rate actually used, keyed by
 *    (currency, source, day) via `dedup_key` -- the source of truth
 *    `lookupHistoricalRate` reads from. Without this table, "reproducible
 *    HUF value" would depend on the live/mutable render-pricing config
 *    still holding today's rate tomorrow, which it will not.
 */
export function initFxSchema(db: Database.Database): void {
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_source TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN conversion_method TEXT`) } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      rate REAL NOT NULL,
      fx_source TEXT NOT NULL,
      effective_date INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      dedup_key TEXT UNIQUE
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fx_rates_currency_date ON fx_rates(currency, effective_date)`)
}
