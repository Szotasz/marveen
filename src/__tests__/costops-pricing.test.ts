import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  PRICE_MAP,
  PRICE_MAP_VERSION,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  isPriced,
  priceTokens,
  dayKey,
} from '../costops/pricing.js'
import { getTokenCostReport, getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

// 2026-07-15T12:00:00Z, matching the v0.1 ledger tests.
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

const OPUS = 'claude-opus-5' // $5 in / $25 out per 1M

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [], ...over }
}

function insertUsage(
  db: ReturnType<typeof getDb>,
  row: { agent?: string; session?: string; ts: number; model: string | null; i?: number; o?: number; cr?: number; cw?: number },
) {
  db.prepare(`INSERT INTO token_usage
    (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    row.agent ?? 'marveen', row.session ?? 's1', row.ts,
    row.i ?? 0, row.o ?? 0, row.cr ?? 0, row.cw ?? 0, row.model,
  )
}

describe('token pricing arithmetic', () => {
  it('prices every component, with cache weighted at its own multiplier', () => {
    const c = priceTokens(OPUS, {
      input_tokens: 1_000, output_tokens: 2_000,
      cache_read_tokens: 1_000_000, cache_creation_tokens: 100_000,
    })!
    expect(c.input).toBeCloseTo(0.005, 10)       // 1e3 * 5 / 1e6
    expect(c.output).toBeCloseTo(0.05, 10)       // 2e3 * 25 / 1e6
    expect(c.cache_read).toBeCloseTo(0.5, 10)    // 1e6 * 5 * 0.10 / 1e6
    expect(c.cache_write).toBeCloseTo(0.625, 10) // 1e5 * 5 * 1.25 / 1e6
    expect(c.total).toBeCloseTo(1.18, 10)
  })

  it('would understate by ~21x on this row if only input+output were counted', () => {
    // The discriminating assertion for the whole module. Fleet-wide, cache_read
    // is 82.9% of spend and output 7.6%; the obvious input+output formula sees
    // a small fraction of the real figure. If someone drops the cache terms,
    // the arithmetic test above still fails -- but this one says why it matters.
    const counts = {
      input_tokens: 1_000, output_tokens: 2_000,
      cache_read_tokens: 1_000_000, cache_creation_tokens: 100_000,
    }
    const c = priceTokens(OPUS, counts)!
    const inputOutputOnly = c.input + c.output
    expect(c.total / inputOutputOnly).toBeGreaterThan(20)
  })

  it('components sum to the reported total', () => {
    const c = priceTokens('claude-fable-5', {
      input_tokens: 137, output_tokens: 9_311,
      cache_read_tokens: 4_200_000, cache_creation_tokens: 55_555,
    })!
    expect(c.input + c.output + c.cache_read + c.cache_write).toBeCloseTo(c.total, 12)
  })

  it('scales linearly with each model rate', () => {
    const counts = { input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0 }
    expect(priceTokens('claude-opus-5', counts)!.total).toBeCloseTo(25, 10)
    expect(priceTokens('claude-fable-5', counts)!.total).toBeCloseTo(50, 10)
    expect(priceTokens('claude-haiku-4-5', counts)!.total).toBeCloseTo(5, 10)
  })

  it('pins the cache multipliers, which are the load-bearing constants', () => {
    expect(CACHE_READ_MULTIPLIER).toBe(0.1)
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25)
  })

  it('carries a version so a stored figure is traceable to its rates', () => {
    expect(PRICE_MAP_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('prices every model the fleet has actually run', () => {
    // Observed in token_usage across the whole table on 2026-07-31. A model in
    // production with no rate is an invisible gap in every total.
    for (const m of ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6']) {
      expect(isPriced(m), `${m} has no published rate`).toBe(true)
      expect(PRICE_MAP[m].output).toBeGreaterThan(PRICE_MAP[m].input)
    }
  })
})

describe('unknown models are a gap, not a zero', () => {
  it('returns null rather than a $0 cost', () => {
    // A silent $0 is the failure mode this subsystem exists to prevent: the
    // total still looks like a total while quietly missing the traffic.
    expect(priceTokens('<synthetic>', { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull()
    expect(priceTokens(null, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull()
    expect(isPriced('gpt-5')).toBe(false)
  })

  it('is not fooled by inherited Object properties', () => {
    expect(isPriced('constructor')).toBe(false)
    expect(isPriced('toString')).toBe(false)
  })
})

describe('day bucketing', () => {
  // 2026-07-15T23:30:00Z is already 2026-07-16 in Budapest (CEST, UTC+2).
  const lateEvening = Math.floor(Date.UTC(2026, 6, 15, 23, 30, 0) / 1000)

  it('buckets by install-local wall clock, not UTC', () => {
    expect(dayKey(lateEvening, 'Europe/Budapest')).toBe('2026-07-16')
  })

  it('the timezone argument actually applies (control)', () => {
    // Without this, the assertion above would pass even if the parameter were
    // ignored and the machine happened to sit in a UTC+2 zone.
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-07-15')
  })

  it('handles the winter offset too', () => {
    const winter = Math.floor(Date.UTC(2026, 0, 15, 23, 30, 0) / 1000) // CET, UTC+1
    expect(dayKey(winter, 'Europe/Budapest')).toBe('2026-01-16')
  })

  it('produces lexicographically sortable keys', () => {
    const days = [
      dayKey(Math.floor(Date.UTC(2026, 9, 3, 10) / 1000), 'UTC'),
      dayKey(Math.floor(Date.UTC(2026, 0, 20, 10) / 1000), 'UTC'),
    ]
    expect([...days].sort()).toEqual(['2026-01-20', '2026-10-03'])
  })
})

describe('token cost report', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('aggregates by model, agent and day, and respects the window', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    insertUsage(db, { ts: w.start + 100, model: OPUS, agent: 'marveen', o: 1_000_000 })          // $25
    insertUsage(db, { ts: w.start + 200, model: 'claude-haiku-4-5', agent: 'prisma', o: 1_000_000 }) // $5
    insertUsage(db, { ts: w.end + 100, model: OPUS, agent: 'marveen', o: 1_000_000 })            // outside window
    const r = getTokenCostReport(db, { start: w.start, end: w.end, timeZone: 'UTC' })

    expect(r.total).toBeCloseTo(30, 6)
    expect(r.by_model[0]).toMatchObject({ model: OPUS, calls: 1 })
    expect(r.by_model.map(m => m.model)).toEqual([OPUS, 'claude-haiku-4-5']) // sorted by cost desc
    expect(r.by_agent.map(a => a.agent)).toEqual(['marveen', 'prisma'])
    expect(r.by_day).toHaveLength(1)
    expect(r.by_day[0].cost).toBeCloseTo(30, 6)
  })

  it('labels its basis and currency on every report', () => {
    // marveen's standing instruction: the figure is a list-price equivalent and
    // must be labelled as one wherever it surfaces, because no invoice matches it.
    const r = getTokenCostReport(getDb(), { start: 0, end: NOW })
    expect(r.basis).toBe('list_price_equivalent')
    expect(r.currency).toBe('USD')
    expect(r.price_map_version).toBe(PRICE_MAP_VERSION)
  })

  it('counts unpriced rows separately instead of folding them in as zero', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    insertUsage(db, { ts: w.start + 10, model: OPUS, o: 1_000_000 })
    insertUsage(db, { ts: w.start + 20, model: '<synthetic>', o: 1_000_000 })
    insertUsage(db, { ts: w.start + 30, model: null, o: 1_000_000 })
    const r = getTokenCostReport(db, { start: w.start, end: w.end })

    expect(r.total).toBeCloseTo(25, 6)               // only the priced row
    expect(r.unpriced.calls).toBe(2)
    expect(r.unpriced.models).toEqual(['(null)', '<synthetic>'])
    expect(r.by_model).toHaveLength(1)               // unpriced never enters the breakdown
  })

  it('reports zeroes, not a crash, on an empty window', () => {
    const r = getTokenCostReport(getDb(), { start: NOW, end: NOW + 86400 })
    expect(r.total).toBe(0)
    expect(r.by_model).toEqual([])
    expect(r.unpriced.calls).toBe(0)
  })

  it('splits a session across days at the local boundary', () => {
    const db = getDb()
    const beforeMidnight = Math.floor(Date.UTC(2026, 6, 15, 21, 0, 0) / 1000) // 23:00 Budapest
    const afterMidnight = Math.floor(Date.UTC(2026, 6, 15, 23, 0, 0) / 1000)  // 01:00 Budapest, next day
    insertUsage(db, { ts: beforeMidnight, model: OPUS, o: 1_000_000 })
    insertUsage(db, { ts: afterMidnight, model: OPUS, o: 1_000_000 })
    const r = getTokenCostReport(db, { start: beforeMidnight - 10, end: afterMidnight + 10, timeZone: 'Europe/Budapest' })
    expect(r.by_day.map(d => d.day)).toEqual(['2026-07-15', '2026-07-16'])
  })
})

describe('the money ledger and the list-price equivalent stay separate', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('never adds token cost into current_spend', () => {
    // The double-counting guard. The operator pays a subscription, which is
    // already a fixed cost in current_spend; adding what the same traffic would
    // have cost at API rates on top would bill it twice.
    const db = getDb()
    const w = monthWindow(NOW)
    insertUsage(db, { ts: w.start + 100, model: OPUS, o: 1_000_000, cr: 100_000_000 })
    const c = cfg({
      fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
    })
    const s = getCostSummary(db, c, NOW)

    expect(s.token_usage.list_price_equivalent.total).toBeGreaterThan(50)
    expect(s.current_spend).toBe(0)          // nothing synced to the ledger yet
    expect(s.breakdown.estimate).toBe(0)     // and it did not leak into a bucket
    expect(s.forecast_month_end).toBe(0)
  })

  it('reports the equivalent in USD even though the ledger is in HUF', () => {
    // Two different currencies on purpose. No FX rate is invented here; mixing
    // them into one number would need a rate we do not have.
    const db = getDb()
    const w = monthWindow(NOW)
    insertUsage(db, { ts: w.start + 100, model: OPUS, o: 1_000_000 })
    const s = getCostSummary(db, cfg({ currency: 'HUF' }), NOW)
    expect(s.currency).toBe('HUF')
    expect(s.token_usage.list_price_equivalent.currency).toBe('USD')
    expect(s.token_usage.list_price_equivalent.total).toBeCloseTo(25, 6)
  })

  it('says in the note that it is not money owed', () => {
    const s = getCostSummary(getDb(), cfg(), NOW)
    expect(s.token_usage.note).toContain('LIST-PRICE EQUIVALENT')
    expect(s.token_usage.note).toContain('never added to current_spend')
  })
})
