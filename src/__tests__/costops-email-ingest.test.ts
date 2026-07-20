import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ingestEmailCosts, toHuf } from '../costops/email-ingest.js'

const NOW = Math.floor(Date.UTC(2026, 6, 6) / 1000)

describe('toHuf', () => {
  it('passes HUF through, converts USD, flags others', () => {
    expect(toHuf(8990, 'HUF', 360)).toBe(8990)
    expect(toHuf(2, 'USD', 360)).toBe(720)
    expect(toHuf(5, 'EUR', 360)).toBeNull() // not converted here
  })
})

describe('ingestEmailCosts', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('ingests receipts as actual_invoice lines, idempotent per (email, month)', () => {
    const db = getDb()
    const entries = [
      { source_id: 'anthropic-pro', name: 'Claude Pro', provider: 'anthropic', amount: 8990, currency: 'HUF', month: '2026-06', message_ref: 'gmail-abc' },
      { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-def' },
    ]
    const r1 = ingestEmailCosts(db, entries, { fxUsdHuf: 360, now: NOW })
    expect(r1.ingested).toBe(2)
    expect(r1.errors).toHaveLength(0)

    const pro = db.prepare("SELECT billed_cost, confidence, charge_category FROM cost_line_items WHERE source_id='anthropic-pro'").get() as any
    expect(pro.billed_cost).toBe(8990)
    expect(pro.confidence).toBe('actual_invoice')
    expect(pro.charge_category).toBe('invoice')
    const oa = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='openai-api'").get() as any
    expect(oa.billed_cost).toBe(3.5 * 360)

    // re-ingest the SAME receipts -> idempotent, no duplicates
    ingestEmailCosts(db, entries, { fxUsdHuf: 360, now: NOW + 100 })
    expect((db.prepare('SELECT COUNT(*) c FROM cost_line_items').get() as any).c).toBe(2)
  })

  it('same provider, different months coexist (not deduped across months)', () => {
    const db = getDb()
    ingestEmailCosts(db, [{ source_id: 'render-hosting', name: 'Render', provider: 'render', amount: 40000, currency: 'HUF', month: '2026-06', message_ref: 'r-jun' }], { fxUsdHuf: 360, now: NOW })
    ingestEmailCosts(db, [{ source_id: 'render-hosting', name: 'Render', provider: 'render', amount: 41000, currency: 'HUF', month: '2026-07', message_ref: 'r-jul' }], { fxUsdHuf: 360, now: NOW })
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='render-hosting'").get() as any).c).toBe(2)
  })

  it('collects errors for bad month / unconvertible currency / missing id, ingests the rest', () => {
    const db = getDb()
    const r = ingestEmailCosts(db, [
      { source_id: 'ok', name: 'Ok', provider: 'x', amount: 100, currency: 'HUF', month: '2026-06', message_ref: 'm1' },
      { source_id: 'bad-month', name: 'B', provider: 'x', amount: 100, currency: 'HUF', month: 'June', message_ref: 'm2' },
      { source_id: 'bad-cur', name: 'C', provider: 'x', amount: 5, currency: 'EUR', month: '2026-06', message_ref: 'm3' },
      { source_id: '', name: 'D', provider: 'x', amount: 5, currency: 'HUF', month: '2026-06', message_ref: 'm4' },
    ] as any, { fxUsdHuf: 360, now: NOW })
    expect(r.ingested).toBe(1)
    expect(r.errors.length).toBe(3)
  })

  it('Phase 1 (GAP-09): a converted (non-HUF) invoice line carries fx_source/conversion_method; an already-HUF one does not', () => {
    const db = getDb()
    ingestEmailCosts(db, [
      { source_id: 'openai-api', name: 'OpenAI API', provider: 'openai', amount: 3.5, currency: 'USD', month: '2026-06', message_ref: 'gmail-usd' },
      { source_id: 'anthropic-pro', name: 'Claude Pro', provider: 'anthropic', amount: 8990, currency: 'HUF', month: '2026-06', message_ref: 'gmail-huf' },
    ], { fxUsdHuf: 360, now: NOW })
    const usd = db.prepare("SELECT fx_source, conversion_method FROM cost_line_items WHERE source_id='openai-api'").get() as any
    expect(usd.fx_source).toBe('render_pricing_config')
    expect(usd.conversion_method).toBe('invoice_date_rate')
    const huf = db.prepare("SELECT fx_source, conversion_method FROM cost_line_items WHERE source_id='anthropic-pro'").get() as any
    expect(huf.fx_source).toBeNull()
    expect(huf.conversion_method).toBeNull()
  })

  it('stores no raw message ref -- only a hash in source_ref/dedup_key', () => {
    const db = getDb()
    ingestEmailCosts(db, [{ source_id: 's', name: 'S', provider: 'x', amount: 1, currency: 'HUF', month: '2026-06', message_ref: 'SENSITIVE-gmail-id-12345' }], { fxUsdHuf: 360, now: NOW })
    const dump = JSON.stringify(db.prepare('SELECT * FROM cost_line_items').all())
    expect(dump).not.toContain('SENSITIVE-gmail-id-12345')
  })
})
