import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { deriveProvider, validatePricing, getTokenCostEstimate, type PricingConfig } from '../costops/pricing.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function emptyConfig(): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }
}

// input 5000/MTok, output 25000/MTok, cache_read 500/MTok, cache_write 6250/MTok
const PRICING: PricingConfig = {
  version: 1, currency: 'HUF',
  models: {
    'claude-opus-4-8': { input_per_mtok: 5000, output_per_mtok: 25000, cache_read_per_mtok: 500, cache_write_per_mtok: 6250 },
  },
}

let tsCounter = 0
function insertUsage(model: string | null, input: number, output: number, cacheRead = 0, cacheCreate = 0, session = 's1') {
  const w = monthWindow(NOW)
  const ts = w.start + (tsCounter++) // unique per insert -> no dedup-index collision
  getDb().prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, provider, model_source)
    VALUES ('marveen', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    session, ts, input, output, cacheRead, cacheCreate,
    model, model ? deriveProvider(model) : null, model ? 'transcript' : null,
  )
}

describe('costops deriveProvider', () => {
  it('classifies known model families, else unknown', () => {
    expect(deriveProvider('claude-opus-4-8')).toBe('anthropic')
    expect(deriveProvider('deepseek-v4-pro')).toBe('deepseek')
    expect(deriveProvider('gpt-4o')).toBe('openai')
    expect(deriveProvider('gemini-2.0')).toBe('google')
    expect(deriveProvider(null)).toBe('unknown')
    expect(deriveProvider('some-weird-model')).toBe('unknown')
  })
})

describe('costops validatePricing', () => {
  it('accepts valid rates, drops invalid, defaults cache rates to 0', () => {
    const r = validatePricing({ currency: 'HUF', models: {
      'a': { input_per_mtok: 1, output_per_mtok: 2 },
      'bad': { input_per_mtok: -1, output_per_mtok: 2 },
      'nope': { output_per_mtok: 2 },
    } })
    expect(r.pricing.models['a']).toEqual({ input_per_mtok: 1, output_per_mtok: 2, cache_read_per_mtok: 0, cache_write_per_mtok: 0 })
    expect(r.pricing.models['bad']).toBeUndefined()
    expect(r.pricing.models['nope']).toBeUndefined()
    expect(r.errors.length).toBe(2)
  })
})

describe('costops getTokenCostEstimate', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('prices a known model deterministically (golden)', () => {
    // 1,000,000 input; 500,000 output; 2,000,000 cache_read; 100,000 cache_write
    insertUsage('claude-opus-4-8', 1_000_000, 500_000, 2_000_000, 100_000)
    const w = monthWindow(NOW)
    const e = getTokenCostEstimate(getDb(), PRICING, true, w.start, w.end)
    // 5000 + 12500 + 1000 + 625 = 19125
    expect(e.total_estimated_huf).toBe(19125)
    expect(e.pricing_profile_status).toBe('loaded')
    expect(e.priced_by_model[0].model).toBe('claude-opus-4-8')
    expect(e.priced_by_model[0].provider).toBe('anthropic')
    expect(e.unpriced.unknown_model_tokens).toBe(0)
    expect(e.unpriced.no_rate_tokens).toBe(0)
  })

  it('leaves unknown-model rows UNPRICED (never guessed)', () => {
    insertUsage(null, 1_000_000, 1_000_000)
    const w = monthWindow(NOW)
    const e = getTokenCostEstimate(getDb(), PRICING, true, w.start, w.end)
    expect(e.total_estimated_huf).toBe(0)
    expect(e.unpriced.unknown_model_tokens).toBe(2_000_000)
  })

  it('leaves model rows with NO matching rate UNPRICED', () => {
    insertUsage('mystery-model-x', 1_000_000, 0)
    const w = monthWindow(NOW)
    const e = getTokenCostEstimate(getDb(), PRICING, true, w.start, w.end)
    expect(e.total_estimated_huf).toBe(0)
    expect(e.unpriced.no_rate_tokens).toBe(1_000_000)
  })

  it('reports no_pricing_config when there is no pricing', () => {
    insertUsage('claude-opus-4-8', 1_000_000, 0)
    const w = monthWindow(NOW)
    const e = getTokenCostEstimate(getDb(), { version: 1, currency: 'HUF', models: {} }, false, w.start, w.end)
    expect(e.total_estimated_huf).toBe(0)
    expect(e.pricing_profile_status).toBe('no_pricing_config')
  })

  it('reports partial when some priced and some not', () => {
    insertUsage('claude-opus-4-8', 1_000_000, 0, 0, 0, 'a')
    insertUsage(null, 500_000, 0, 0, 0, 'b')
    const w = monthWindow(NOW)
    const e = getTokenCostEstimate(getDb(), PRICING, true, w.start, w.end)
    expect(e.pricing_profile_status).toBe('partial')
    expect(e.total_estimated_huf).toBe(5000)
    expect(e.unpriced.unknown_model_tokens).toBe(500_000)
  })
})

describe('costops summary includes token_cost_estimate (separate from spend)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('adds token_cost_estimate + estimated_total_with_token_cost without touching current_spend', () => {
    insertUsage('claude-opus-4-8', 1_000_000, 0) // priced 5000
    const s = getCostSummary(getDb(), emptyConfig(), NOW, { pricing: PRICING, pricingExists: true })
    expect(s.current_spend).toBe(0)                       // token cost NOT folded in
    expect(s.token_cost_estimate.total_estimated_huf).toBe(5000)
    expect(s.token_cost_estimate.confidence).toBe('estimate')
    expect(s.estimated_total_with_token_cost).toBe(5000)  // 0 fixed + 5000 token
  })
})
