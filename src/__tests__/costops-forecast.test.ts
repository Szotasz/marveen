import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  forecastFixedSubscription,
  forecastTimeProportionalUsage,
  forecastBalanceDelta,
  forecastInvoiceCadence,
  forecastOneTime,
  forecastManual,
  resolveSourceForecast,
  computeForecastError,
  summarizeForecastAccuracy,
  forecastSnapshotDedupKey,
  initForecastSchema,
  type ForecastContext,
} from '../costops/forecast.js'
import type { MonthWindow } from '../costops/ledger.js'
import type { BalanceSnapshot } from '../costops/collectors/deepseek.js'

// Hand-built MonthWindow fixtures -- these functions are pure over the
// interface shape, not tied to monthWindow()'s calendar math.
function win(fractionElapsed: number): MonthWindow {
  const daysInMonth = 30
  const start = 0
  const end = daysInMonth * 86400
  return { key: '2026-07', start, end, daysInMonth, fractionElapsed }
}

describe('forecastFixedSubscription', () => {
  it('returns the full period amount regardless of elapsed fraction', () => {
    const r = forecastFixedSubscription(22000, 'manual')
    expect(r.method).toBe('fixed_subscription')
    expect(r.amount).toBe(22000)
  })

  it('is high confidence for invoice/provider-observed amounts, medium for manual/estimate', () => {
    expect(forecastFixedSubscription(1000, 'actual_invoice').confidence).toBe('high')
    expect(forecastFixedSubscription(1000, 'provider_api').confidence).toBe('high')
    expect(forecastFixedSubscription(1000, 'billing_export').confidence).toBe('high')
    expect(forecastFixedSubscription(1000, 'manual').confidence).toBe('medium')
    expect(forecastFixedSubscription(1000, 'estimate').confidence).toBe('medium')
  })
})

describe('forecastTimeProportionalUsage', () => {
  it('projects month-end as MTD / fractionElapsed', () => {
    const r = forecastTimeProportionalUsage(1000, win(0.5))
    expect(r.amount).toBe(2000)
    expect(r.method).toBe('time_proportional_usage')
  })

  it('confidence is low early in the month, medium mid-month, high late', () => {
    expect(forecastTimeProportionalUsage(100, win(0.1)).confidence).toBe('low')
    expect(forecastTimeProportionalUsage(100, win(0.3)).confidence).toBe('medium')
    expect(forecastTimeProportionalUsage(100, win(0.9)).confidence).toBe('high')
  })
})

describe('forecastBalanceDelta', () => {
  const NOW = 15 * 86400 // mid-month

  it('falls back to MTD-only, low confidence, with fewer than 2 snapshots', () => {
    const snaps: BalanceSnapshot[] = [{ balance: 100, captured_at: 1 * 86400 }]
    const r = forecastBalanceDelta(snaps, win(0.5), NOW)
    expect(r.confidence).toBe('low')
    expect(r.amount).toBe(0)
  })

  it('falls back to MTD-only when the observed span is too short', () => {
    const snaps: BalanceSnapshot[] = [
      { balance: 100, captured_at: 1 * 3600 },
      { balance: 90, captured_at: 2 * 3600 }, // 1 hour apart, well under MIN_FORECAST_SPAN_SECONDS
    ]
    const r = forecastBalanceDelta(snaps, win(0.5), NOW)
    expect(r.confidence).toBe('low')
  })

  it('extrapolates month-end from a daily burn rate over a longer span', () => {
    // 10 days of history, dropping 10/day -> burn rate 10/day, 100 total spend.
    const snaps: BalanceSnapshot[] = []
    for (let d = 0; d <= 10; d++) snaps.push({ balance: 200 - d * 10, captured_at: d * 86400 })
    const r = forecastBalanceDelta(snaps, win(0.5), 10 * 86400)
    // MTD (within month window [0, 30d)) = full 100 spend observed so far.
    // remaining days = (end - now) / 86400 = (30*86400 - 10*86400)/86400 = 20
    // projected = 100 + 10*20 = 300
    expect(r.amount).toBe(300)
    expect(r.confidence).toBe('high')
  })

  it('ignores balance RISES (top-ups) when deriving spend', () => {
    const snaps: BalanceSnapshot[] = [
      { balance: 100, captured_at: 0 },
      { balance: 50, captured_at: 5 * 86400 },   // spend 50
      { balance: 150, captured_at: 6 * 86400 },  // top-up, ignored
      { balance: 100, captured_at: 11 * 86400 }, // spend 50
    ]
    const r = forecastBalanceDelta(snaps, win(0.5), 11 * 86400)
    // total observed spend = 100 (50+50), span = 11 days -> ~9.09/day burn
    expect(r.amount).toBeGreaterThan(100) // mtd + remaining-day extrapolation
  })
})

describe('forecastInvoiceCadence', () => {
  it('uses the full amount when this month IS the invoice month', () => {
    const r = forecastInvoiceCadence(120000, 'annual', { isInvoiceMonth: true })
    expect(r.amount).toBe(120000)
    expect(r.confidence).toBe('high')
  })

  it('accrues evenly across the cadence when not the invoice month', () => {
    const r = forecastInvoiceCadence(120000, 'annual')
    expect(r.amount).toBe(10000) // 120000 / 12
    expect(r.confidence).toBe('medium')
  })

  it('quarterly accrual divides by 3', () => {
    const r = forecastInvoiceCadence(9000, 'quarterly')
    expect(r.amount).toBe(3000)
  })

  it('monthly cadence is high confidence even without isInvoiceMonth (accrual == full amount)', () => {
    const r = forecastInvoiceCadence(5000, 'monthly')
    expect(r.amount).toBe(5000)
    expect(r.confidence).toBe('high')
  })
})

describe('forecastOneTime', () => {
  it('equals the actual when already occurred, high confidence', () => {
    const r = forecastOneTime(4500, null)
    expect(r.amount).toBe(4500)
    expect(r.confidence).toBe('high')
  })

  it('uses the planned amount when not yet occurred but known in advance, medium confidence', () => {
    const r = forecastOneTime(null, 3000)
    expect(r.amount).toBe(3000)
    expect(r.confidence).toBe('medium')
  })

  it('forecasts 0, low confidence, when nothing is known -- never fabricated', () => {
    const r = forecastOneTime(null, null)
    expect(r.amount).toBe(0)
    expect(r.confidence).toBe('low')
  })
})

describe('forecastManual', () => {
  it('passes through the operator figure at low confidence', () => {
    const r = forecastManual(7777)
    expect(r.amount).toBe(7777)
    expect(r.confidence).toBe('low')
    expect(r.method).toBe('manual_forecast')
  })
})

describe('resolveSourceForecast dispatcher precedence', () => {
  const base: ForecastContext = { mtd_amount: 1000, win: win(0.5), now: 15 * 86400 }

  it('manual_override wins over everything else', () => {
    const ctx: ForecastContext = { ...base, manual_override: 999, charge_category: 'usage', balance_snapshots: [{ balance: 1, captured_at: 0 }, { balance: 0, captured_at: 86400 * 5 }] }
    expect(resolveSourceForecast(ctx).method).toBe('manual_forecast')
  })

  it('balance_snapshots beats cadence and charge_category', () => {
    const ctx: ForecastContext = { ...base, balance_snapshots: [{ balance: 1, captured_at: 0 }], cadence: 'annual', last_invoice_amount: 1000, charge_category: 'usage' }
    expect(resolveSourceForecast(ctx).method).toBe('balance_delta')
  })

  it('non-monthly cadence beats charge_category when a last invoice amount is known', () => {
    const ctx: ForecastContext = { ...base, cadence: 'annual', last_invoice_amount: 12000, charge_category: 'purchase' }
    expect(resolveSourceForecast(ctx).method).toBe('invoice_cadence')
  })

  it('monthly cadence does NOT trigger invoice_cadence (falls through)', () => {
    const ctx: ForecastContext = { ...base, cadence: 'monthly', last_invoice_amount: 12000, charge_category: 'subscription' }
    expect(resolveSourceForecast(ctx).method).toBe('fixed_subscription')
  })

  it('purchase charge_category resolves to one_time', () => {
    const ctx: ForecastContext = { ...base, charge_category: 'purchase', occurred_amount: 500 }
    const r = resolveSourceForecast(ctx)
    expect(r.method).toBe('one_time')
    expect(r.amount).toBe(500)
  })

  it('usage charge_category resolves to time_proportional_usage', () => {
    const ctx: ForecastContext = { ...base, charge_category: 'usage' }
    expect(resolveSourceForecast(ctx).method).toBe('time_proportional_usage')
  })

  it('defaults to fixed_subscription for subscription/no category', () => {
    const ctx: ForecastContext = { ...base, charge_category: 'subscription' }
    expect(resolveSourceForecast(ctx).method).toBe('fixed_subscription')
    expect(resolveSourceForecast({ ...base }).method).toBe('fixed_subscription')
  })
})

describe('computeForecastError', () => {
  it('is positive when the forecast under-shot the actual', () => {
    const e = computeForecastError(100, 120)
    expect(e.absolute_error).toBe(20)
    expect(e.percent_error).toBeCloseTo(20 / 120, 4)
  })

  it('is negative when the forecast over-shot the actual', () => {
    const e = computeForecastError(150, 100)
    expect(e.absolute_error).toBe(-50)
    expect(e.percent_error).toBeCloseTo(-50 / 100, 4)
  })

  it('percent_error is null (never fabricated) when actual is 0', () => {
    const e = computeForecastError(100, 0)
    expect(e.absolute_error).toBe(-100)
    expect(e.percent_error).toBeNull()
  })
})

describe('summarizeForecastAccuracy', () => {
  it('groups by an arbitrary key and reports mean absolute/percent error', () => {
    const records = [
      { provider: 'render', forecast_amount: 100, actual_amount: 120 },
      { provider: 'render', forecast_amount: 200, actual_amount: 180 },
      { provider: 'anthropic', forecast_amount: 50, actual_amount: 50 },
    ]
    const summary = summarizeForecastAccuracy(records, r => r.provider)
    const render = summary.find(s => s.key === 'render')!
    expect(render.count).toBe(2)
    // |120-100| + |180-200| = 20 + 20 = 40 -> mean 20
    expect(render.mean_absolute_error).toBe(20)
    const anthropic = summary.find(s => s.key === 'anthropic')!
    expect(anthropic.mean_absolute_error).toBe(0)
    expect(anthropic.mean_percent_error).toBe(0)
  })

  it('mean_percent_error is null only when EVERY record in the group has actual 0', () => {
    const records = [
      { provider: 'x', forecast_amount: 10, actual_amount: 0 },
      { provider: 'x', forecast_amount: 5, actual_amount: 0 },
    ]
    const summary = summarizeForecastAccuracy(records, r => r.provider)
    expect(summary[0].mean_percent_error).toBeNull()
  })
})

describe('forecastSnapshotDedupKey', () => {
  it('is deterministic per source per UTC day', () => {
    const t1 = Math.floor(Date.UTC(2026, 6, 15, 1, 0, 0) / 1000)
    const t2 = Math.floor(Date.UTC(2026, 6, 15, 23, 0, 0) / 1000)
    expect(forecastSnapshotDedupKey('render-hosting', '2026-07', t1)).toBe(forecastSnapshotDedupKey('render-hosting', '2026-07', t2))
  })

  it('differs across days and uses TOTAL for a null source', () => {
    const t1 = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
    const t2 = Math.floor(Date.UTC(2026, 6, 16, 12, 0, 0) / 1000)
    expect(forecastSnapshotDedupKey('render-hosting', '2026-07', t1)).not.toBe(forecastSnapshotDedupKey('render-hosting', '2026-07', t2))
    expect(forecastSnapshotDedupKey(null, '2026-07', t1)).toBe('TOTAL|2026-07|2026-07-15')
  })
})

describe('initForecastSchema', () => {
  it('is idempotent and the table accepts a row keyed by dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initForecastSchema(db)
    initForecastSchema(db) // second call must not throw (IF NOT EXISTS)
    const now = Math.floor(Date.UTC(2026, 6, 15) / 1000)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','hosting','HUF',1,@now,@now)`).run({ now })
    db.prepare(`
      INSERT INTO forecast_snapshots (source_id, month, snapshot_at, method, forecast_amount, confidence, dedup_key, created_at)
      VALUES ('render-hosting', '2026-07', @now, 'fixed_subscription', 12000, 'high', @dk, @now)
    `).run({ now, dk: forecastSnapshotDedupKey('render-hosting', '2026-07', now) })
    const row = db.prepare(`SELECT * FROM forecast_snapshots WHERE source_id = 'render-hosting'`).get() as { forecast_amount: number; actual_amount: number | null }
    expect(row.forecast_amount).toBe(12000)
    expect(row.actual_amount).toBeNull() // never fabricated until period close
  })

  it('rejects a duplicate dedup_key (same source, same day)', () => {
    initDatabase(':memory:')
    const db = getDb()
    initForecastSchema(db)
    const now = Math.floor(Date.UTC(2026, 6, 15) / 1000)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','hosting','HUF',1,@now,@now)`).run({ now })
    const dk = forecastSnapshotDedupKey('render-hosting', '2026-07', now)
    db.prepare(`INSERT INTO forecast_snapshots (source_id, month, snapshot_at, method, forecast_amount, confidence, dedup_key, created_at) VALUES ('render-hosting','2026-07',@now,'fixed_subscription',12000,'high',@dk,@now)`).run({ now, dk })
    expect(() => {
      db.prepare(`INSERT INTO forecast_snapshots (source_id, month, snapshot_at, method, forecast_amount, confidence, dedup_key, created_at) VALUES ('render-hosting','2026-07',@now,'fixed_subscription',13000,'high',@dk,@now)`).run({ now, dk })
    }).toThrow()
  })
})
