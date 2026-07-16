import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { buildReconciliation } from '../costops/reconciliation.js'
import { monthWindow } from '../costops/ledger.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function insertSource(db: import('better-sqlite3').Database, id: string, provider = 'other') {
  db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, 'usage', 'HUF', 1, ?, ?)`)
    .run(id, id, provider, NOW, NOW)
}

function insertLine(db: import('better-sqlite3').Database, sourceId: string, amount: number, confidence: string, actualSource: string | null, chargeCategory = 'subscription') {
  const win = monthWindow(NOW)
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, ?, ?, 'HUF', ?, ?, ?, ?, ?)
  `).run(sourceId, win.start, win.end, chargeCategory, amount, confidence, NOW, NOW, `test|${sourceId}|${Math.random()}`, actualSource)
}

describe('buildReconciliation (CostOps Phase 1, GAP-06)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a source with no lines this month is no_data, everything null', () => {
    const db = getDb()
    insertSource(db, 'idle')
    const [r] = buildReconciliation(db, NOW)
    expect(r.status).toBe('no_data')
    expect(r.expected_amount).toBeNull()
    expect(r.observed_provider_amount).toBeNull()
    expect(r.invoice_amount).toBeNull()
    expect(r.operationally_selected_amount).toBeNull()
  })

  it('provider API amount matching the invoice amount within tolerance is matched', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertLine(db, 'render-hosting', 10000, 'provider_api', 'provider_api')
    insertLine(db, 'render-hosting', 10050, 'actual_invoice', 'email_invoice') // 0.5% apart, within 2% tolerance
    const [r] = buildReconciliation(db, NOW)
    expect(r.observed_provider_amount).toBe(10000)
    expect(r.invoice_amount).toBe(10050)
    expect(r.status).toBe('matched')
    expect(r.variance_reason).toBe('invoice vs provider API')
  })

  it('a material mismatch between invoice and provider API is flagged as variance', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertLine(db, 'render-hosting', 10000, 'provider_api', 'provider_api')
    insertLine(db, 'render-hosting', 12000, 'actual_invoice', 'email_invoice') // 20% apart
    const [r] = buildReconciliation(db, NOW)
    expect(r.status).toBe('variance')
    expect(r.variance).toBe(2000)
  })

  it('provider API present but no invoice yet -> missing_invoice', () => {
    const db = getDb()
    insertSource(db, 'openai-api', 'openai')
    insertLine(db, 'openai-api', 5000, 'provider_api', 'provider_api')
    const [r] = buildReconciliation(db, NOW)
    expect(r.status).toBe('missing_invoice')
    expect(r.observed_provider_amount).toBe(5000)
    expect(r.invoice_amount).toBeNull()
  })

  it('invoice present but no provider API data -> missing_provider_data', () => {
    const db = getDb()
    insertSource(db, 'domain')
    insertLine(db, 'domain', 3000, 'actual_invoice', 'email_invoice')
    const [r] = buildReconciliation(db, NOW)
    expect(r.status).toBe('missing_provider_data')
  })

  it('only manual/estimate data -> estimate_only', () => {
    const db = getDb()
    insertSource(db, 'hosting')
    insertLine(db, 'hosting', 3000, 'manual', 'manual_entry')
    const [r] = buildReconciliation(db, NOW)
    expect(r.status).toBe('estimate_only')
    expect(r.observed_provider_amount).toBeNull()
    expect(r.invoice_amount).toBeNull()
    expect(r.operationally_selected_amount).toBe(3000)
  })

  it('operationally_selected_amount always matches the ledger CONF_PRIORITY resolution', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertLine(db, 'render-hosting', 9000, 'manual', 'manual_entry')
    insertLine(db, 'render-hosting', 10000, 'provider_api', 'provider_api') // higher CONF_PRIORITY wins
    const [r] = buildReconciliation(db, NOW)
    expect(r.operationally_selected_amount).toBe(10000)
  })

  it('expected_amount comes from the latest forecast_snapshots row for that source+month, when one exists', async () => {
    const db = getDb()
    insertSource(db, 'domain')
    insertLine(db, 'domain', 3000, 'manual', 'manual_entry')
    const { captureForecastSnapshots } = await import('../costops/forecast-capture.js')
    captureForecastSnapshots(db, NOW)
    const [r] = buildReconciliation(db, NOW)
    expect(r.expected_amount).toBe(3000) // fixed_subscription forecast == the mtd amount
  })

  it('reports per-month when a specific month is requested', () => {
    const db = getDb()
    insertSource(db, 'domain')
    insertLine(db, 'domain', 3000, 'manual', 'manual_entry')
    const win = monthWindow(NOW)
    const [r] = buildReconciliation(db, NOW, win.key)
    expect(r.month).toBe(win.key)
    const [empty] = buildReconciliation(db, NOW, '2020-01')
    expect(empty.status).toBe('no_data')
  })
})
