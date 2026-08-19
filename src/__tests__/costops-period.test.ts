import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncFixedCostsToLedger, monthWindow } from '../costops/ledger.js'
import { getPeriodTrend } from '../costops/period.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15

function cfg(): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [],
  }
}

describe('costops period trend', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('reports no_data (never a fabricated 0) for months with zero rows', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW) // only writes for the current (July) month
    const trend = getPeriodTrend(db, cfg(), NOW, 3)
    expect(trend.months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07'])
    expect(trend.months[0].no_data).toBe(true)  // May: no rows at all
    expect(trend.months[1].no_data).toBe(true)  // June: no rows at all
    expect(trend.months[2].no_data).toBe(false) // July: has rows
    expect(trend.months[2].operational_spend).toBe(22000)
  })

  it('does not fabricate a fixed cost into a month before it existed (a new subscription)', () => {
    const db = getDb()
    // Only sync June (the subscription's actual first month) -- May must stay no_data.
    syncFixedCostsToLedger(db, cfg(), NOW, '2026-06')
    const trend = getPeriodTrend(db, cfg(), NOW, 3)
    const may = trend.months.find(m => m.month === '2026-05')!
    const june = trend.months.find(m => m.month === '2026-06')!
    expect(may.no_data).toBe(true)
    expect(june.no_data).toBe(false)
    expect(june.operational_spend).toBe(22000)
  })

  it('month_over_month_delta is null when either side is no_data (never computed from a fabricated 0)', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW) // current month only
    const trend = getPeriodTrend(db, cfg(), NOW, 2)
    expect(trend.previous.no_data).toBe(true)
    expect(trend.month_over_month_delta).toBeNull()
  })

  it('computes a real delta when both months have data', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW, '2026-06')
    syncFixedCostsToLedger(db, cfg(), NOW, '2026-07')
    const trend = getPeriodTrend(db, cfg(), NOW, 2)
    expect(trend.current.operational_spend).toBe(22000)
    expect(trend.previous.operational_spend).toBe(22000)
    expect(trend.month_over_month_delta).toBe(0)
  })

  it('excludes pending_permission lines from a month\'s operational spend (never shown as spend)', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('aws','AWS','aws','usage','HUF',1,@now,@now)`).run({ now: NOW })
    db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at)
      VALUES ('aws', @start, @end, 'usage', 0, 'HUF', 'pending_permission', @now, @now)
    `).run({ start: win.start, end: win.end, now: NOW })
    const trend = getPeriodTrend(db, cfg(), NOW, 1)
    // A month with ONLY a pending_permission row still has a row, so it's not no_data,
    // but that row must contribute 0 to operational_spend and not appear in provider_breakdown.
    expect(trend.current.no_data).toBe(false)
    expect(trend.current.operational_spend).toBe(0)
    expect(trend.current.provider_breakdown.find(p => p.provider === 'aws')).toBeUndefined()
  })
})
