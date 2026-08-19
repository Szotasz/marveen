import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapAnthropicCostReport, anthropicCollector } from '../costops/collectors/anthropic.js'
import { runCollector, sanitizeError } from '../costops/collectors/runner.js'
import { validateCollectorsConfig } from '../costops/collectors/config.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'
import type { CollectOpts, HttpGetJson } from '../costops/collectors/types.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const FX = 308.91

function emptyConfig(): CostOpsConfig { return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] } }

// Offline fixture -- matches the mapper; NO live API is ever called in tests.
const FIXTURE = {
  data: [{
    starting_at: '2026-07-01T00:00:00Z',
    ending_at: '2026-07-31T00:00:00Z',
    results: [
      { currency: 'USD', amount: '30', cost_type: 'api_usage', model: 'claude-opus-4-8' },
      { currency: 'USD', amount: '20', cost_type: 'api_usage', model: 'claude-sonnet-4-6' },
    ],
  }],
  has_more: false,
}

function opts(httpGetJson: HttpGetJson): CollectOpts {
  const w = monthWindow(NOW)
  return { periodStart: w.start, periodEnd: w.end, secret: 'sk-SECRET-must-not-leak-1234567890', fxUsdHuf: FX, idSalt: 'salt', httpGetJson }
}

describe('anthropic mapper (pure, offline)', () => {
  it('aggregates USD -> HUF into one provider_api line for anthropic-api', () => {
    const w = monthWindow(NOW)
    const lines = mapAnthropicCostReport(FIXTURE, { periodStart: w.start, periodEnd: w.end, fxUsdHuf: FX, idSalt: 'salt', now: NOW })
    expect(lines).toHaveLength(1)
    expect(lines[0].service).toBe('anthropic-api')
    expect(lines[0].provider).toBe('anthropic')
    expect(lines[0].confidence).toBe('provider_api')
    // (30 + 20) * 308.91 = 15445.5
    expect(lines[0].amount).toBe(15445.5)
    expect(lines[0].currency).toBe('HUF')
    expect(lines[0].dedup_key).toBe('provider|anthropic|anthropic-api|2026-07|provider_api')
    expect(lines[0].raw_ref_hash).not.toContain('anthropic-cost-report') // hashed
  })
  it('returns [] for an empty report', () => {
    const w = monthWindow(NOW)
    expect(mapAnthropicCostReport({ data: [] }, { periodStart: w.start, periodEnd: w.end, fxUsdHuf: FX, idSalt: 's', now: NOW })).toHaveLength(0)
  })
})

describe('sanitizeError (no secret leaks)', () => {
  it('redacts key-like substrings', () => {
    const s = sanitizeError(new Error('auth failed for x-api-key: sk-abcdef1234567890abcdef and token abcdef1234567890abcdef1234567890'))
    expect(s.message).not.toContain('sk-abcdef1234567890')
    expect(s.message).toMatch(/\*\*\*/)
  })
})

describe('collectors config validation', () => {
  it('rejects a raw secret in secret_ref (must be vault:)', () => {
    const r = validateCollectorsConfig({ collectors: [{ provider: 'anthropic', secret_ref: 'sk-raw-key' }] })
    expect(r.config.collectors).toHaveLength(0)
    expect(r.errors[0]).toContain('vault:')
  })
  it('accepts a vault: secret_ref', () => {
    const r = validateCollectorsConfig({ fx_usd_huf: 308.91, collectors: [{ provider: 'anthropic', enabled: true, secret_ref: 'vault:costops.anthropic_admin_key' }] })
    expect(r.config.collectors[0].secret_ref).toBe('vault:costops.anthropic_admin_key')
    expect(r.errors).toEqual([])
  })
})

describe('runCollector (offline stub, no live call)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('imports a provider_api line and records an ok import_run; idempotent', async () => {
    const stub: HttpGetJson = async () => FIXTURE
    const res1 = await runCollector({ db: getDb(), collector: anthropicCollector, opts: opts(stub), now: NOW })
    expect(res1.status).toBe('ok')
    expect(res1.importedCount).toBe(1)
    // re-run -> no duplicate (dedup_key upsert)
    await runCollector({ db: getDb(), collector: anthropicCollector, opts: opts(stub), now: NOW })
    const n = getDb().prepare("SELECT COUNT(*) n FROM cost_line_items WHERE confidence='provider_api'").get() as { n: number }
    expect(n.n).toBe(1)
    const runs = getDb().prepare("SELECT COUNT(*) n FROM import_runs").get() as { n: number }
    expect(runs.n).toBe(2) // two runs recorded, one line
  })

  it('does NOT overwrite the manual estimate; both coexist; headline resolves to actual', async () => {
    const db = getDb()
    const w = monthWindow(NOW)
    // seed a manual estimate for anthropic-api (like the v0.1 config sync)
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('anthropic-api','Anthropic API','anthropic','usage','HUF',1,?,?)").run(NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('anthropic-api',?,?,'usage','Anthropic API',17655,'HUF','estimate',?,'fixed|anthropic-api|2026-07',?)`).run(w.start, w.end, NOW, NOW)
    await runCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW })
    // both lines exist
    const both = db.prepare("SELECT confidence, billed_cost FROM cost_line_items WHERE source_id='anthropic-api' ORDER BY confidence").all() as Array<{ confidence: string; billed_cost: number }>
    expect(both.map(x => x.confidence).sort()).toEqual(['estimate', 'provider_api'])
    // summary: headline resolves to provider_api actual (15445.5), reconcile shows both
    const s = getCostSummary(db, emptyConfig(), NOW)
    expect(s.current_spend).toBe(15445.5)               // actual, not estimate, not summed
    const rec = s.reconcile.find(r => r.source_id === 'anthropic-api')!
    expect(rec.estimate).toBe(17655)
    expect(rec.actual).toBe(15445.5)
    expect(rec.variance).toBe(-2209.5)
    expect(rec.resolved_confidence).toBe('provider_api')
  })

  it('on collector error: records status=error, sanitized, deletes NOTHING', async () => {
    const db = getDb()
    const w = monthWindow(NOW)
    // pre-existing good data
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('x','X','other','usage','HUF',1,?,?)").run(NOW, NOW)
    db.prepare("INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at) VALUES ('x',?,?,'usage','X',100,'HUF','manual',?,'k',?)").run(w.start, w.end, NOW, NOW)
    const throwing: HttpGetJson = async () => { throw new Error('rate limited, key sk-abcdef1234567890abcdef') }
    const res = await runCollector({ db, collector: anthropicCollector, opts: opts(throwing), now: NOW })
    expect(res.status).toBe('error')
    expect(res.errorMessageSanitized).not.toContain('sk-abcdef1234567890')
    // nothing deleted
    const n = db.prepare("SELECT COUNT(*) n FROM cost_line_items").get() as { n: number }
    expect(n.n).toBe(1)
    // secret never appears in import_runs
    const dump = JSON.stringify(db.prepare("SELECT * FROM import_runs").all())
    expect(dump).not.toContain('sk-abcdef1234567890')
    expect(dump).not.toContain('sk-SECRET-must-not-leak')
  })

  it('provider_sync appears in the summary after a run', async () => {
    const db = getDb()
    await runCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW })
    const s = getCostSummary(db, emptyConfig(), NOW)
    const ps = s.provider_sync.find(p => p.provider === 'anthropic')!
    expect(ps.status).toBe('ok')
    expect(ps.imported_count).toBe(1)
    expect(ps.collector_name).toBe('anthropic-cost-report')
  })
})
