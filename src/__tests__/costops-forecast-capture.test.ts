import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { captureForecastSnapshots, listForecastSnapshots } from '../costops/forecast-capture.js'
import { monthWindow } from '../costops/ledger.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function insertSource(db: import('better-sqlite3').Database, id: string, provider: string) {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, 'usage', 'HUF', 1, ?, ?)`)
    .run(id, id, provider, NOW, NOW)
}

function insertLine(db: import('better-sqlite3').Database, sourceId: string, amount: number, confidence: string, category = 'subscription') {
  const win = monthWindow(NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key)
    VALUES (?, ?, ?, ?, ?, 'HUF', ?, ?, ?, ?)
  `).run(sourceId, win.start, win.end, category, amount, confidence, NOW, NOW, `test|${sourceId}|${Math.random()}`)
}

describe('captureForecastSnapshots (CostOps Phase 1, GAP-10 orchestration)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('captures one snapshot per active source plus a whole-deployment TOTAL row', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other')
    insertSource(db, 'hosting', 'other')
    insertLine(db, 'domain', 3000, 'manual')
    insertLine(db, 'hosting', 5000, 'manual')

    const results = captureForecastSnapshots(db, NOW)
    expect(results).toHaveLength(3) // domain + hosting + TOTAL
    const total = results.find(r => r.source_id === null)!
    expect(total.result.amount).toBe(8000)

    const stored = listForecastSnapshots(db)
    expect(stored).toHaveLength(3)
  })

  it('a fixed subscription (no usage category) forecasts full amount, not prorated', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other')
    insertLine(db, 'domain', 3000, 'manual', 'subscription')
    const [r] = captureForecastSnapshots(db, NOW)
    expect(r.result.method).toBe('fixed_subscription')
    expect(r.result.amount).toBe(3000)
  })

  it('a usage-category source forecasts by run-rate, greater than the MTD amount mid-month', () => {
    const db = getDb()
    insertSource(db, 'api-usage', 'other')
    insertLine(db, 'api-usage', 1000, 'provider_api', 'usage')
    const results = captureForecastSnapshots(db, NOW)
    const r = results.find(x => x.source_id === 'api-usage')!
    expect(r.result.method).toBe('time_proportional_usage')
    expect(r.result.amount).toBeGreaterThan(1000)
  })

  it('a source with balance snapshots (DeepSeek-shaped) uses balance_delta, not fixed/usage defaults', () => {
    const db = getDb()
    insertSource(db, 'deepseek-api', 'deepseek')
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',100,?)`).run(win.start + 86400)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',80,?)`).run(win.start + 5 * 86400)
    const results = captureForecastSnapshots(db, NOW)
    const r = results.find(x => x.source_id === 'deepseek-api')!
    expect(r.result.method).toBe('balance_delta')
  })

  it('a source with no cost_line_items this month still gets a forecast row (0 mtd, fixed_subscription default)', () => {
    const db = getDb()
    insertSource(db, 'idle-source', 'other')
    const results = captureForecastSnapshots(db, NOW)
    const r = results.find(x => x.source_id === 'idle-source')!
    expect(r.result.amount).toBe(0)
  })

  it('a pending_permission or provider_plan_estimate line is excluded from the resolved mtd amount', () => {
    const db = getDb()
    insertSource(db, 'aws', 'aws')
    insertLine(db, 'aws', 0, 'pending_permission')
    const results = captureForecastSnapshots(db, NOW)
    const r = results.find(x => x.source_id === 'aws')!
    expect(r.result.amount).toBe(0) // never fabricated from the excluded pending line
  })

  it('capturing twice the same day is idempotent -- no duplicate rows (dedup_key includes the day)', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other')
    insertLine(db, 'domain', 3000, 'manual')
    captureForecastSnapshots(db, NOW)
    captureForecastSnapshots(db, NOW + 3600) // same day, 1h later
    const stored = listForecastSnapshots(db)
    expect(stored).toHaveLength(2) // domain + TOTAL, not 4
  })

  it('listForecastSnapshots filters by month when given one', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other')
    insertLine(db, 'domain', 3000, 'manual')
    captureForecastSnapshots(db, NOW)
    const win = monthWindow(NOW)
    expect(listForecastSnapshots(db, { month: win.key })).toHaveLength(2)
    expect(listForecastSnapshots(db, { month: '2020-01' })).toHaveLength(0)
  })
})
