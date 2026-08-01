// Contract tests for the per-project cost view (kanban #114, A slice).
//
// Three things had to hold before a per-project figure could be shown at all:
//
//   1. A cost belongs to a project, and anything serving several stays in one
//      shared bucket -- the owner labelled them that way, and inventing a split
//      key would turn a guess into a table cell.
//   2. Amounts stay in the currency they are billed in. Conversion happens at
//      display time, and a currency with no configured rate is reported as a
//      gap rather than added at face value.
//   3. The token list-price equivalent is a SEPARATE column from money. The
//      subscription that pays for those tokens is already counted as a fixed
//      cost, so summing the two would double-count.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncFixedCostsToLedger, getCostSummary, getTokenCostReport, UNTAGGED_PROJECT } from '../costops/ledger.js'
import { normalizeProject, monthlyAmount, SHARED_PROJECT, validateConfig, availableDisplayCurrencies } from '../costops/config.js'
import type { CostOpsConfig, FixedCostEntry } from '../costops/config.js'

// 2026-07-15T12:00:00Z -- same deterministic "now" as the other costops tests.
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const OPUS = 'claude-opus-5'

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return { version: 1, currency: 'HUF', fx_rates: {}, fixed_costs: [], budgets: [], ...over }
}

function cost(over: Partial<FixedCostEntry> & { source_id: string; amount: number }): FixedCostEntry {
  return {
    name: over.source_id, provider: 'other', source_type: 'subscription',
    period: 'monthly', charge_category: 'subscription', confidence: 'manual',
    currency: 'HUF', ...over,
  }
}

function insertUsage(
  db: ReturnType<typeof getDb>,
  row: { agent?: string; project?: string | null; ts: number; i?: number; o?: number },
) {
  db.prepare(`INSERT INTO token_usage
    (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model,project)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    row.agent ?? 'prisma', 's1', row.ts, row.i ?? 0, row.o ?? 0, 0, 0, OPUS, row.project ?? null,
  )
}

beforeEach(() => { initDatabase(':memory:') })

describe('project labelling', () => {
  it('folds every spelling of the shared bucket into one key', () => {
    // The owner writes this config by hand, in Hungarian. "KOZOS", "közös" and
    // an empty field all mean the same thing and must not become three rows.
    for (const raw of ['KOZOS', 'kozos', 'közös', 'shared', '', '   ', undefined, null]) {
      expect(normalizeProject(raw)).toBe(SHARED_PROJECT)
    }
  })

  it('leaves a real project name alone', () => {
    expect(normalizeProject('persistent-cart')).toBe('persistent-cart')
    expect(normalizeProject(' peci.io ')).toBe('peci.io')
  })

  it('carries the project through config validation', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'vercel', amount: 20, project: 'persistent-cart' }], budgets: [] })
    expect(r.config.fixed_costs[0].project).toBe('persistent-cart')
  })
})

describe('yearly costs', () => {
  it('spreads a yearly amount across the months instead of spiking one', () => {
    // A 999/yr tool must not make its renewal month look like a 999 month.
    expect(monthlyAmount(cost({ source_id: 'ib', amount: 999, period: 'yearly' }))).toBeCloseTo(83.25, 4)
    expect(monthlyAmount(cost({ source_id: 'v', amount: 20, period: 'monthly' }))).toBe(20)
  })

  it('writes the monthly share to the ledger, tagged as amortized', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({
      fixed_costs: [cost({ source_id: 'domain', amount: 600, period: 'yearly' })],
    }), NOW)

    const row = db.prepare('SELECT billed_cost, usage_type FROM cost_line_items').get() as { billed_cost: number; usage_type: string | null }
    expect(row.billed_cost).toBe(50)
    // Without the tag, an amortized twelfth is indistinguishable from a real
    // monthly bill the moment anyone reads the ledger directly.
    expect(row.usage_type).toBe('amortized_yearly')
  })
})

describe('per-project money', () => {
  it('groups spend by project and keeps shared costs in their own bucket', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({
      fixed_costs: [
        cost({ source_id: 'vercel', amount: 7000, project: 'persistent-cart' }),
        cost({ source_id: 'neon', amount: 7000, project: 'persistent-cart' }),
        cost({ source_id: 'zoho', amount: 400, project: 'peci.io' }),
        cost({ source_id: 'claude', amount: 70000, project: 'KOZOS' }),
      ],
    }), NOW)

    const s = getCostSummary(db, cfg(), NOW)
    const byName = new Map(s.by_project.map(p => [p.project, p]))
    expect(byName.get('persistent-cart')!.spend_display).toBe(14000)
    expect(byName.get('peci.io')!.spend_display).toBe(400)
    expect(byName.get(SHARED_PROJECT)!.spend_display).toBe(70000)
    // The shared bucket is NOT distributed across the other two.
    expect(byName.get('persistent-cart')!.spend_display).not.toBe(14000 + 70000 / 2)
  })

  it('lists the sources behind a project so a figure can be traced', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({
      fixed_costs: [
        cost({ source_id: 'vercel', amount: 1, project: 'persistent-cart' }),
        cost({ source_id: 'neon', amount: 1, project: 'persistent-cart' }),
      ],
    }), NOW)

    const p = getCostSummary(db, cfg(), NOW).by_project.find(x => x.project === 'persistent-cart')!
    expect(p.sources).toEqual(['neon', 'vercel'])
  })

  it('treats a cost with no project as shared rather than dropping it', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({ fixed_costs: [cost({ source_id: 'mystery', amount: 500 })] }), NOW)

    const s = getCostSummary(db, cfg(), NOW)
    expect(s.by_project.find(p => p.project === SHARED_PROJECT)!.spend_display).toBe(500)
    expect(s.current_spend).toBe(500)
  })
})

describe('currencies', () => {
  const mixed = {
    fixed_costs: [
      cost({ source_id: 'vercel', amount: 20, currency: 'USD', project: 'persistent-cart' }),
      cost({ source_id: 'zoho', amount: 10, currency: 'EUR', project: 'peci.io' }),
      cost({ source_id: 'partner', amount: 1000, currency: 'HUF', project: 'persistent-cart' }),
    ],
  }

  it('keeps every amount in the currency it was billed in', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)

    const s = getCostSummary(db, cfg(), NOW)
    // The unconverted truth is always available, whatever the rates say.
    expect(s.spend_by_currency).toEqual({ USD: 20, EUR: 10, HUF: 1000 })
  })

  it('reports a missing rate as a gap instead of adding foreign amounts at face value', () => {
    // 20 USD added to a HUF total is not a rounding error, it is a wrong number.
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)

    const s = getCostSummary(db, cfg(), NOW)
    expect(s.fx.missing_rates).toEqual(['EUR', 'USD'])
    expect(s.current_spend).toBe(1000)  // only the HUF line, not 1030
    expect(s.by_project.find(p => p.project === 'peci.io')!.spend_display).toBeNull()
  })

  it('converts once rates are configured, without touching what is stored', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    const withRates = cfg({ fx_rates: { USD: 350, EUR: 400 }, fx_asof: '2026-08-01' })

    const s = getCostSummary(db, withRates, NOW)
    expect(s.fx.missing_rates).toEqual([])
    expect(s.current_spend).toBe(20 * 350 + 10 * 400 + 1000)
    expect(s.by_project.find(p => p.project === 'persistent-cart')!.spend_display).toBe(20 * 350 + 1000)
    expect(s.fx.asof).toBe('2026-08-01')
    // Stored rows are still in their own currency -- a rate change must be able
    // to correct the display without rewriting history.
    const stored = db.prepare("SELECT billed_cost, currency FROM cost_line_items WHERE source_id='vercel'").get() as { billed_cost: number; currency: string }
    expect(stored).toEqual({ billed_cost: 20, currency: 'USD' })
  })

  it('refuses a zero or negative rate', () => {
    // A zero rate silently zeroes a whole currency; no rate at least shows up.
    const r = validateConfig({ fx_rates: { USD: 0, EUR: -1, GBP: 450 }, fixed_costs: [], budgets: [] })
    expect(r.config.fx_rates).toEqual({ GBP: 450 })
    expect(r.errors).toHaveLength(2)
  })
})

describe('AI list-price equivalent stays its own column', () => {
  it('reports token cost per project, including the untagged share', () => {
    const db = getDb()
    insertUsage(db, { ts: NOW, project: 'persistent-cart', i: 1_000_000 })  // $5
    insertUsage(db, { ts: NOW, project: null, i: 2_000_000 })               // $10, unlabelled

    const report = getTokenCostReport(db, { start: NOW - 86400, end: NOW + 86400 })
    const byName = new Map(report.by_project.map(p => [p.project, p.cost]))
    expect(byName.get('persistent-cart')).toBeCloseTo(5, 4)
    // Untagged usage is surfaced, not folded into the labelled projects: it was
    // 55% of the spend when this was written, and hiding it would make every
    // per-project figure look more complete than it is.
    expect(byName.get(UNTAGGED_PROJECT)).toBeCloseTo(10, 4)
  })

  it("never adds token cost into a project's money", () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({ fixed_costs: [cost({ source_id: 'vercel', amount: 7000, project: 'persistent-cart' })] }), NOW)
    insertUsage(db, { ts: NOW, project: 'persistent-cart', i: 1_000_000 })

    const p = getCostSummary(db, cfg(), NOW).by_project.find(x => x.project === 'persistent-cart')!
    expect(p.spend_display).toBe(7000)          // money only
    expect(p.ai_list_price_usd).toBeCloseTo(5, 4)  // side by side, not summed
  })

  it('shows a project that has tokens but no money at all', () => {
    // Most projects burn AI time long before they have a subscription.
    const db = getDb()
    insertUsage(db, { ts: NOW, project: 'idea-candidate', i: 1_000_000 })

    const p = getCostSummary(db, cfg(), NOW).by_project.find(x => x.project === 'idea-candidate')!
    expect(p.spend_display).toBe(0)
    expect(p.ai_list_price_usd).toBeCloseTo(5, 4)
  })
})

// Viktor asked to read the same figures in USD or EUR, not only HUF (#187).
// The rate table is quoted in one base currency, so every pair has to come out
// of those same two numbers -- and the honesty rules must survive the change of
// unit, since a wrong number is no better in dollars.
describe('choosing the display currency', () => {
  const mixed = {
    fixed_costs: [
      cost({ source_id: 'vercel', amount: 20, currency: 'USD', project: 'persistent-cart' }),
      cost({ source_id: 'claude', amount: 100, currency: 'EUR', project: 'KOZOS' }),
      cost({ source_id: 'partner', amount: 35000, currency: 'HUF', project: 'persistent-cart' }),
    ],
  }
  // Roughly the real rates the updater fetched on 2026-08-01.
  const rated = (over: Partial<CostOpsConfig> = {}) => cfg({ fx_rates: { USD: 350, EUR: 400 }, fx_asof: '2026-07-31', ...over })

  it('defaults to the currency the rate table is quoted in', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    const s = getCostSummary(db, rated(), NOW)
    expect(s.currency).toBe('HUF')
    expect(s.current_spend).toBe(20 * 350 + 100 * 400 + 35000)
  })

  it('converts the whole summary into a requested currency', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    const s = getCostSummary(db, rated(), NOW, { displayCurrency: 'USD' })
    expect(s.currency).toBe('USD')
    // Everything through the base: (20*350 + 100*400 + 35000) HUF / 350.
    expect(s.current_spend).toBeCloseTo((20 * 350 + 100 * 400 + 35000) / 350, 2)
    expect(s.fx.display_currency).toBe('USD')
  })

  it('crosses two foreign currencies through the base, not a third rate', () => {
    // EUR shown in USD: 100 EUR -> 40 000 HUF -> 114.29 USD.
    const db = getDb()
    syncFixedCostsToLedger(db, cfg({ fixed_costs: [cost({ source_id: 'claude', amount: 100, currency: 'EUR', project: 'KOZOS' })] }), NOW)
    const s = getCostSummary(db, rated(), NOW, { displayCurrency: 'USD' })
    expect(s.current_spend).toBeCloseTo(100 * 400 / 350, 2)
  })

  it('keeps spend_by_currency as the unconverted truth whatever the display', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    const s = getCostSummary(db, rated(), NOW, { displayCurrency: 'EUR' })
    expect(s.spend_by_currency).toEqual({ USD: 20, EUR: 100, HUF: 35000 })
  })

  it('still refuses to guess when a source currency has no rate', () => {
    // Changing the unit must not turn a "cannot say" into a number.
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    const s = getCostSummary(db, cfg({ fx_rates: { USD: 350 } }), NOW, { displayCurrency: 'USD' })
    expect(s.fx.missing_rates).toEqual(['EUR'])
    expect(s.by_project.find(p => p.project === SHARED_PROJECT)!.spend_display).toBeNull()
  })

  it('offers only currencies it can actually produce', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    // A selector must never list a currency that would yield nulls.
    expect(getCostSummary(db, rated(), NOW).fx.available_currencies).toEqual(['EUR', 'HUF', 'USD'])
    expect(getCostSummary(db, cfg(), NOW).fx.available_currencies).toEqual(['HUF'])
  })

  it('never offers a currency whose rate is unusable', () => {
    // validateConfig drops non-positive rates, but this helper is also called
    // with configs assembled in code -- and a 0 rate would divide the whole
    // summary into Infinity rather than merely being wrong.
    expect(availableDisplayCurrencies({ currency: 'HUF', fx_rates: { USD: 350, EUR: 0, GBP: -1 } })).toEqual(['HUF', 'USD'])
  })

  it('carries the as-of date into every display currency', () => {
    // A converted figure without its date invites reading a month-old rate as
    // today's -- and conversion is exactly when that matters.
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(mixed), NOW)
    expect(getCostSummary(db, rated(), NOW, { displayCurrency: 'USD' }).fx.asof).toBe('2026-07-31')
  })
})
