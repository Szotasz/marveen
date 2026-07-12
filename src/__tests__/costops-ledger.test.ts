import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  monthWindow,
  hashRef,
  confidenceBucket,
  syncFixedCostsToLedger,
  getCostSummary,
} from '../costops/ledger.js'
import { validateConfig } from '../costops/config.js'
import type { CostOpsConfig } from '../costops/config.js'

// 2026-07-15T12:00:00Z -> mid-July, deterministic "now" for all summary tests.
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
      { source_id: 'openai', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 8000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, warning_threshold: 0.8, hard_threshold: 1.0, currency: 'HUF' },
    ],
    ...over,
  }
}

describe('costops month math', () => {
  it('computes UTC month window + days', () => {
    const w = monthWindow(NOW)
    expect(w.key).toBe('2026-07')
    expect(w.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000))
    expect(w.end).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000))
    expect(w.daysInMonth).toBe(31)
    // 14.5 days elapsed of 31
    expect(w.fractionElapsed).toBeCloseTo(14.5 / 31, 4)
  })
  it('honours an explicit month key', () => {
    expect(monthWindow(NOW, '2026-02').daysInMonth).toBe(28)
    expect(monthWindow(NOW, '2026-02').key).toBe('2026-02')
  })
})

describe('costops hashRef', () => {
  it('is deterministic and salt-sensitive and non-reversible', () => {
    expect(hashRef('salt', 'acct-123')).toBe(hashRef('salt', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toBe(hashRef('salt2', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toContain('acct-123')
    expect(hashRef('salt', 'acct-123')).toHaveLength(32)
  })
})

describe('costops confidenceBucket', () => {
  it('maps confidence tiers to buckets', () => {
    expect(confidenceBucket('manual')).toBe('fixed_manual')
    expect(confidenceBucket('actual_invoice')).toBe('provider')
    expect(confidenceBucket('provider_api')).toBe('provider')
    expect(confidenceBucket('estimate')).toBe('estimate')
    expect(confidenceBucket('local_usage')).toBe('estimate')
  })
})

describe('costops config validation', () => {
  it('accepts a valid config and applies defaults', () => {
    const r = validateConfig({ currency: 'HUF', fixed_costs: [{ source_id: 'x', amount: 100 }], budgets: [{ id: 'b', amount: 500 }] })
    expect(r.errors).toEqual([])
    expect(r.config.fixed_costs[0].confidence).toBe('manual')
    expect(r.config.fixed_costs[0].provider).toBe('other')
    expect(r.config.budgets[0].warning_threshold).toBe(0.8)
  })
  it('drops invalid entries with error notes, keeps valid ones', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'ok', amount: 100 }, { amount: 5 }, { source_id: 'neg', amount: -1 }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0].source_id).toBe('ok')
    expect(r.errors.length).toBe(2)
  })
  it('rejects non-monthly periods in v0.1', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'y', amount: 1, period: 'yearly' }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain('monthly')
  })
})

describe('costops ledger + summary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('syncs fixed costs idempotently (no duplicates on re-run)', () => {
    const db = getDb()
    const c = cfg()
    expect(syncFixedCostsToLedger(db, c, NOW)).toBe(2)
    syncFixedCostsToLedger(db, c, NOW)
    syncFixedCostsToLedger(db, c, NOW)
    const rows = db.prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }
    expect(rows.n).toBe(2) // still 2, not 6
    const sources = db.prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }
    expect(sources.n).toBe(2)
  })

  it('reflects updated config amounts on re-sync (upsert, not insert)', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const c2 = cfg({ fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 30000, period: 'monthly', confidence: 'manual', currency: 'HUF' }] })
    syncFixedCostsToLedger(db, c2, NOW)
    const row = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number }
    expect(row.billed_cost).toBe(30000)
  })

  it('computes a deterministic monthly summary (golden values)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.month).toBe('2026-07')
    expect(s.current_spend).toBe(30000)            // 22000 + 8000
    expect(s.forecast_month_end).toBe(30000)       // fixed = whole-month, no proration
    expect(s.breakdown.fixed_manual).toBe(30000)
    expect(s.breakdown.provider).toBe(0)
    expect(s.confidence_breakdown.manual).toBe(30000)
    expect(s.top_sources[0]).toEqual({ source_id: 'anthropic-max', name: 'Claude Max', spend: 22000 })
    expect(s.top_sources[1].source_id).toBe('openai')
    expect(s.budget?.amount).toBe(60000)
    expect(s.budget?.used_pct).toBe(0.5)
    expect(s.budget?.status).toBe('ok')
  })

  it('all_sources lists every configured source (not capped like top_sources)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.all_sources).toHaveLength(2) // both, even at 0 or any spend
    const ids = s.all_sources.map(x => x.source_id).sort()
    expect(ids).toEqual(['anthropic-max', 'openai'])
    const anthropic = s.all_sources.find(x => x.source_id === 'anthropic-max')!
    expect(anthropic.provider).toBe('anthropic')
    expect(anthropic.source_type).toBe('subscription')
    expect(anthropic.confidence).toBe('manual')
    expect(anthropic.spend).toBe(22000)
    expect(anthropic).toHaveProperty('name')
  })

  it('classifies budget status at thresholds (display-only, no action)', () => {
    const db = getDb()
    // amount tuned so current_spend hits exactly 80% then 100% of a 10000 budget
    const warnCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 8000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db, warnCfg, NOW)
    expect(getCostSummary(db, warnCfg, NOW).budget?.status).toBe('warning') // 0.8 -> warning

    initDatabase(':memory:')
    const db2 = getDb()
    const hardCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 10000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db2, hardCfg, NOW)
    expect(getCostSummary(db2, hardCfg, NOW).budget?.status).toBe('hard') // 1.0 -> hard

    initDatabase(':memory:')
    const db3 = getDb()
    const okCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 7999, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db3, okCfg, NOW)
    expect(getCostSummary(db3, okCfg, NOW).budget?.status).toBe('ok') // 0.7999 -> ok
  })

  it('prorates usage-type line items to month-end for forecast', () => {
    const db = getDb()
    // insert a usage line directly (source + line) representing partial-month usage
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('u','U','other','usage','HUF',1,?,?)").run(NOW, NOW)
    const w = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('u',?,?,'usage','U',1450,'HUF','estimate',?,'u|2026-07',?)`).run(w.start, w.end, NOW, NOW)
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.current_spend).toBe(1450)
    // forecast = 1450 / fractionElapsed (14.5/31) ~= 3100
    expect(s.forecast_month_end).toBeGreaterThan(3000)
    expect(s.breakdown.estimate).toBe(1450)
  })

  it('reports token_usage as VOLUME only, never priced', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    const ins = db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,?,?,?)")
    ins.run('marveen', 's1', w.start + 100, 1000, 5000, 200, 50)
    ins.run('qa', 's2', w.start + 200, 500, 2000, 0, 0)
    ins.run('marveen', 's3', w.end + 100, 999, 999, 0, 0) // next month, excluded
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.token_usage.calls).toBe(2)
    expect(s.token_usage.agents).toBe(2)
    expect(s.token_usage.input_tokens).toBe(1500)
    expect(s.token_usage.output_tokens).toBe(7000)
    expect(s.token_usage.note).toContain('not priced')
    // token usage must NOT contribute to money
    expect(s.current_spend).toBe(0)
  })
})
