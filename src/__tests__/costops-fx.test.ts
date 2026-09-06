import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  resolveFxRate,
  roundHuf,
  resolveRateDate,
  convertToHufWithProvenance,
  canRecomputeFx,
  convertCorrectionToHuf,
  lookupHistoricalRate,
  fxRateDedupKey,
  initFxSchema,
  type FxRateTable,
  type FxRateRecord,
} from '../costops/fx.js'

const RATES: FxRateTable = { USD: 350, EUR: 380 }

describe('resolveFxRate', () => {
  it('HUF is always rate 1, regardless of the table', () => {
    expect(resolveFxRate('HUF', {})).toBe(1)
    expect(resolveFxRate('huf', { HUF: 999 })).toBe(1)
  })

  it('resolves USD/EUR from the table, case-insensitively', () => {
    expect(resolveFxRate('USD', RATES)).toBe(350)
    expect(resolveFxRate('eur', RATES)).toBe(380)
  })

  it('returns null (never fabricated) for an unsupported currency', () => {
    expect(resolveFxRate('GBP', RATES)).toBeNull()
  })

  it('returns null for a zero or negative rate in the table (never a bogus conversion)', () => {
    expect(resolveFxRate('USD', { USD: 0 })).toBeNull()
    expect(resolveFxRate('USD', { USD: -5 })).toBeNull()
  })
})

describe('roundHuf', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundHuf(100.005)).toBeCloseTo(100.01, 2)
    expect(roundHuf(99.994)).toBe(99.99)
    expect(roundHuf(1234.5)).toBe(1234.5)
  })
})

describe('resolveRateDate', () => {
  it('prefers the invoice date when known', () => {
    const r = resolveRateDate(1000, 2000)
    expect(r.date).toBe(1000)
    expect(r.basis).toBe('invoice_date')
  })

  it('falls back to the service date when there is no invoice', () => {
    const r = resolveRateDate(null, 2000)
    expect(r.date).toBe(2000)
    expect(r.basis).toBe('service_date')
  })
})

describe('convertToHufWithProvenance', () => {
  it('carries full provenance for a USD conversion at the invoice date', () => {
    const c = convertToHufWithProvenance(10, 'USD', RATES, { fxSource: 'render_pricing_config', invoiceDate: 500, serviceDate: 100, now: 999 })
    expect(c).not.toBeNull()
    expect(c!.original_amount).toBe(10)
    expect(c!.original_currency).toBe('USD')
    expect(c!.fx_rate).toBe(350)
    expect(c!.fx_source).toBe('render_pricing_config')
    expect(c!.fx_date).toBe(500) // invoice date wins
    expect(c!.conversion_method).toBe('invoice_date_rate')
    expect(c!.huf_amount).toBe(3500)
    expect(c!.converted_at).toBe(999)
  })

  it('uses service_date_rate when no invoice date is given', () => {
    const c = convertToHufWithProvenance(10, 'EUR', RATES, { fxSource: 'manual', invoiceDate: null, serviceDate: 100, now: 999 })
    expect(c!.conversion_method).toBe('service_date_rate')
    expect(c!.fx_date).toBe(100)
    expect(c!.huf_amount).toBe(3800)
  })

  it('HUF passes through at rate 1 with huf_amount == original amount', () => {
    const c = convertToHufWithProvenance(5000, 'HUF', RATES, { fxSource: 'manual', invoiceDate: null, serviceDate: 1, now: 1 })
    expect(c!.fx_rate).toBe(1)
    expect(c!.huf_amount).toBe(5000)
  })

  it('returns null (never a fabricated conversion) for an unsupported currency', () => {
    const c = convertToHufWithProvenance(10, 'GBP', RATES, { fxSource: 'manual', invoiceDate: null, serviceDate: 1, now: 1 })
    expect(c).toBeNull()
  })
})

describe('canRecomputeFx', () => {
  it('forbids recomputation only for closed periods', () => {
    expect(canRecomputeFx('closed')).toBe(false)
    expect(canRecomputeFx('open')).toBe(true)
    expect(canRecomputeFx('provisional')).toBe(true)
    expect(canRecomputeFx('reopened')).toBe(true)
  })
})

describe('convertCorrectionToHuf', () => {
  it('produces an independent conversion rated as of the CORRECTION date, not the original', () => {
    const correction = convertCorrectionToHuf({
      originalCurrency: 'usd',
      correctionAmountOriginalCurrency: -10, // a refund/credit
      correctionDate: 5000,
      correctionRate: 360, // a DIFFERENT rate than the original conversion used
      correctionSource: 'provider_invoice',
      now: 5001,
    })
    expect(correction.original_currency).toBe('USD')
    expect(correction.fx_rate).toBe(360)
    expect(correction.fx_date).toBe(5000)
    expect(correction.conversion_method).toBe('correction_date_rate')
    expect(correction.huf_amount).toBe(-3600)
  })
})

describe('lookupHistoricalRate', () => {
  const records: FxRateRecord[] = [
    { currency: 'USD', rate: 340, fx_source: 'render_pricing_config', effective_date: 1000 },
    { currency: 'USD', rate: 350, fx_source: 'render_pricing_config', effective_date: 2000 },
    { currency: 'USD', rate: 360, fx_source: 'render_pricing_config', effective_date: 3000 },
    { currency: 'EUR', rate: 380, fx_source: 'render_pricing_config', effective_date: 2500 },
  ]

  it('returns the most recent record at or before the requested date', () => {
    expect(lookupHistoricalRate(records, 'USD', 2500)?.rate).toBe(350)
    expect(lookupHistoricalRate(records, 'USD', 3000)?.rate).toBe(360)
  })

  it('never applies a future rate to a past date', () => {
    expect(lookupHistoricalRate(records, 'USD', 500)).toBeNull()
  })

  it('filters by currency', () => {
    expect(lookupHistoricalRate(records, 'EUR', 2500)?.rate).toBe(380)
  })

  it('is reproducible: same snapshot + same date always resolves the same rate', () => {
    const a = lookupHistoricalRate(records, 'USD', 2500)
    const b = lookupHistoricalRate(records, 'USD', 2500)
    expect(a).toEqual(b)
  })
})

describe('fxRateDedupKey', () => {
  it('is stable within the same UTC day and differs across days', () => {
    const t1 = Math.floor(Date.UTC(2026, 6, 15, 1, 0, 0) / 1000)
    const t2 = Math.floor(Date.UTC(2026, 6, 15, 23, 0, 0) / 1000)
    const t3 = Math.floor(Date.UTC(2026, 6, 16, 1, 0, 0) / 1000)
    expect(fxRateDedupKey('USD', 'render_pricing_config', t1)).toBe(fxRateDedupKey('USD', 'render_pricing_config', t2))
    expect(fxRateDedupKey('USD', 'render_pricing_config', t1)).not.toBe(fxRateDedupKey('USD', 'render_pricing_config', t3))
  })

  it('differs by currency and source', () => {
    const t = Math.floor(Date.UTC(2026, 6, 15) / 1000)
    expect(fxRateDedupKey('USD', 'render_pricing_config', t)).not.toBe(fxRateDedupKey('EUR', 'render_pricing_config', t))
    expect(fxRateDedupKey('USD', 'render_pricing_config', t)).not.toBe(fxRateDedupKey('USD', 'manual', t))
  })
})

describe('initFxSchema', () => {
  it('is idempotent and adds fx_source/conversion_method columns onto cost_line_items', () => {
    initDatabase(':memory:')
    const db = getDb()
    initFxSchema(db)
    initFxSchema(db) // second call must not throw
    const now = Math.floor(Date.UTC(2026, 6, 15) / 1000)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('anthropic-api','Anthropic API','anthropic','usage','HUF',1,@now,@now)`).run({ now })
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, fx_source, conversion_method, original_amount, original_currency, fx_rate, fx_date)
      VALUES ('anthropic-api', @now, @now, 'usage', 3500, 'HUF', 'provider_api', @now, @now, 'render_pricing_config', 'invoice_date_rate', 10, 'USD', 350, @now)
    `).run({ now })
    const row = db.prepare(`SELECT fx_source, conversion_method FROM cost_line_items WHERE source_id = 'anthropic-api'`).get() as { fx_source: string; conversion_method: string }
    expect(row.fx_source).toBe('render_pricing_config')
    expect(row.conversion_method).toBe('invoice_date_rate')
  })

  it('creates the fx_rates table and enforces one row per dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initFxSchema(db)
    const now = Math.floor(Date.UTC(2026, 6, 15) / 1000)
    const dk = fxRateDedupKey('USD', 'render_pricing_config', now)
    db.prepare(`INSERT INTO fx_rates (currency, rate, fx_source, effective_date, captured_at, dedup_key) VALUES ('USD', 350, 'render_pricing_config', @now, @now, @dk)`).run({ now, dk })
    expect(() => {
      db.prepare(`INSERT INTO fx_rates (currency, rate, fx_source, effective_date, captured_at, dedup_key) VALUES ('USD', 360, 'render_pricing_config', @now, @now, @dk)`).run({ now, dk })
    }).toThrow()
    const row = db.prepare(`SELECT rate FROM fx_rates WHERE dedup_key = ?`).get(dk) as { rate: number }
    expect(row.rate).toBe(350)
  })
})
