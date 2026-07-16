import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCorrection, getCorrectionChain } from '../costops/correction.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

function insertLine(db: import('better-sqlite3').Database, sourceId: string, amount: number, confidence = 'manual', actualSource = 'manual_entry'): number {
  const win = monthWindow(NOW)
  db.prepare(`INSERT OR IGNORE INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, 'other', 'usage', 'HUF', 1, ?, ?)`)
    .run(sourceId, sourceId, NOW, NOW)
  const info = db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, 'usage', ?, 'HUF', ?, ?, ?, ?, ?)
  `).run(sourceId, win.start, win.end, amount, confidence, NOW, NOW, `test|${sourceId}|${Math.random()}`, actualSource)
  return info.lastInsertRowid as number
}

describe('createCorrection (CostOps Phase 1, GAP-05/06/14 -- correction relationship)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('voids the original and inserts a linked correction row with the new amount', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'invoice was overstated' }, { now: NOW + 100 })
    expect(r.ok).toBe(true)
    expect(r.newLineId).toBeDefined()

    const original = db.prepare(`SELECT voided_at, void_reason, billed_cost, corrects_line_id FROM cost_line_items WHERE id = ?`).get(originalId) as any
    expect(original.voided_at).toBe(NOW + 100)
    expect(original.void_reason).toContain('invoice was overstated')
    expect(original.billed_cost).toBe(10000) // amount preserved, never erased
    expect(original.corrects_line_id).toBeNull() // the ORIGINAL doesn't point anywhere

    const corrected = db.prepare(`SELECT billed_cost, corrects_line_id, voided_at FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.billed_cost).toBe(8500)
    expect(corrected.corrects_line_id).toBe(originalId)
    expect(corrected.voided_at).toBeNull() // the correction itself is active
  })

  it('the corrected amount, not the original, is what the ledger reports going forward', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'fix' }, { now: NOW + 100 })
    const s = getCostSummary(db, cfg, NOW)
    const row = s.all_sources.find(x => x.source_id === 'render-hosting')!
    expect(row.spend).toBe(8500)
  })

  it('preserves source_id/period/currency/confidence/actual_source from the original', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000, 'provider_api', 'provider_api')
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 9000, reason: 'provider corrected their number' }, { now: NOW + 100 })
    const corrected = db.prepare(`SELECT source_id, currency, confidence, actual_source FROM cost_line_items WHERE id = ?`).get(r.newLineId) as any
    expect(corrected.source_id).toBe('render-hosting')
    expect(corrected.currency).toBe('HUF')
    expect(corrected.confidence).toBe('provider_api')
    expect(corrected.actual_source).toBe('provider_api')
  })

  it('404s on a nonexistent line id', () => {
    const db = getDb()
    const r = createCorrection(db, { originalLineId: 99999, newAmount: 100, reason: 'x' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('409s when correcting an already-voided line', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'first fix' }, { now: NOW + 100 })
    const r2 = createCorrection(db, { originalLineId: originalId, newAmount: 7000, reason: 'second attempt on the same original' }, { now: NOW + 200 })
    expect(r2.ok).toBe(false)
    expect(r2.status).toBe(409)
  })

  it('409s when the original already has a correction pointing at it (correct the newer link instead)', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const first = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: 'first fix' }, { now: NOW + 100 })
    // Attempting to correct the ORIGINAL again (not the new line) must fail --
    // it's already voided, so this hits the voided guard, same 409 class.
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 7000, reason: 'oops' }, { now: NOW + 200 })
    expect(r.ok).toBe(false)
    // But correcting the NEW line (the actual current link) works fine.
    const r2 = createCorrection(db, { originalLineId: first.newLineId!, newAmount: 7500, reason: 'second, correct fix' }, { now: NOW + 300 })
    expect(r2.ok).toBe(true)
  })

  it('rejects a missing reason -- correction must always be explainable', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: 8500, reason: '' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('rejects a negative newAmount', () => {
    const db = getDb()
    const originalId = insertLine(db, 'render-hosting', 10000)
    const r = createCorrection(db, { originalLineId: originalId, newAmount: -5, reason: 'x' }, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })
})

describe('getCorrectionChain', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns just the one row when there is no correction yet', () => {
    const db = getDb()
    const id = insertLine(db, 'render-hosting', 10000)
    const chain = getCorrectionChain(db, id)
    expect(chain).toHaveLength(1)
    expect(chain[0].id).toBe(id)
  })

  it('walks a multi-link chain oldest-first, regardless of which link id is passed in', () => {
    const db = getDb()
    const original = insertLine(db, 'render-hosting', 10000)
    const c1 = createCorrection(db, { originalLineId: original, newAmount: 8500, reason: 'fix 1' }, { now: NOW + 100 })
    const c2 = createCorrection(db, { originalLineId: c1.newLineId!, newAmount: 9200, reason: 'fix 2' }, { now: NOW + 200 })

    for (const queryId of [original, c1.newLineId!, c2.newLineId!]) {
      const chain = getCorrectionChain(db, queryId)
      expect(chain.map(c => c.id)).toEqual([original, c1.newLineId, c2.newLineId])
      expect(chain.map(c => c.billed_cost)).toEqual([10000, 8500, 9200])
      expect(chain[chain.length - 1].voided_at).toBeNull() // only the latest link is active
    }
  })
})
