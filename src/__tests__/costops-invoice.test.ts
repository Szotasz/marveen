import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { monthWindow } from '../costops/ledger.js'
import { initPeriodCloseSchema } from '../costops/period-close.js'
import {
  computeNetAmount,
  invoiceDedupKey,
  inferExpectedInvoiceBy,
  recordInvoice,
  applyInvoiceAdjustment,
  voidInvoice,
  listInvoices,
  buildInvoiceReconciliation,
  initInvoiceSchema,
  type InvoiceAmounts,
} from '../costops/invoice.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000) // 2026-07-15
const SALT = 'test-salt'

function amounts(over: Partial<InvoiceAmounts> = {}): InvoiceAmounts {
  return { gross_amount: 100, tax_amount: 0, discount_amount: 0, credit_amount: 0, refund_amount: 0, late_charge_amount: 0, ...over }
}

function insertSource(db: ReturnType<typeof getDb>, id: string, provider: string): void {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, 'hosting', 'HUF', 1, ?, ?)`).run(id, id, provider, NOW, NOW)
}

function setup(): ReturnType<typeof getDb> {
  initDatabase(':memory:')
  const db = getDb()
  initInvoiceSchema(db)
  initPeriodCloseSchema(db)
  return db
}

describe('computeNetAmount', () => {
  it('subtracts discount/credit/refund and adds late_charge, never double-counting tax', () => {
    expect(computeNetAmount(amounts({ gross_amount: 100 }))).toBe(100)
    expect(computeNetAmount(amounts({ gross_amount: 100, discount_amount: 10 }))).toBe(90)
    expect(computeNetAmount(amounts({ gross_amount: 100, credit_amount: 20, refund_amount: 5 }))).toBe(75)
    expect(computeNetAmount(amounts({ gross_amount: 100, late_charge_amount: 15 }))).toBe(115)
    expect(computeNetAmount(amounts({ gross_amount: 100, tax_amount: 20 }))).toBe(100) // tax is informational, not added again
  })
})

describe('invoiceDedupKey', () => {
  it('composes provider + ref + period', () => {
    expect(invoiceDedupKey('render', 'abc123', '2026-07')).toBe('render|abc123|2026-07')
  })
})

describe('inferExpectedInvoiceBy', () => {
  it('is null with fewer than 2 historical invoices', () => {
    expect(inferExpectedInvoiceBy([])).toBeNull()
    expect(inferExpectedInvoiceBy([1000])).toBeNull()
  })
  it('projects the next expected date from the median gap + grace days', () => {
    const d1 = Math.floor(Date.UTC(2026, 4, 31) / 1000) // May 31
    const d2 = Math.floor(Date.UTC(2026, 5, 30) / 1000) // Jun 30 (30-day gap)
    const expected = inferExpectedInvoiceBy([d1, d2], 15)
    expect(expected).toBe(d2 + 30 * 86400 + 15 * 86400)
  })
})

describe('recordInvoice -- validation', () => {
  beforeEach(() => setup())

  it('rejects missing required fields', () => {
    const db = getDb()
    expect(recordInvoice(db, { source_id: '', provider: 'render', invoice_ref: null, billing_period_start: 0, billing_period_end: 1, currency: 'HUF', gross_amount: 100 }, { now: NOW, salt: SALT }).status).toBe(400)
  })
  it('rejects a negative gross_amount', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    const r = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: null, billing_period_start: 0, billing_period_end: 100, currency: 'HUF', gross_amount: -5 }, { now: NOW, salt: SALT })
    expect(r.status).toBe(400)
  })
  it('rejects an invalid period range', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    const r = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: null, billing_period_start: 100, billing_period_end: 50, currency: 'HUF', gross_amount: 10 }, { now: NOW, salt: SALT })
    expect(r.status).toBe(400)
  })
})

describe('recordInvoice -- first-time recording (no existing ledger line)', () => {
  beforeEach(() => setup())

  it('inserts a new cost_line_items row as actual_invoice/email_invoice', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const r = recordInvoice(db, {
      source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-001',
      billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 12000,
    }, { now: NOW, salt: SALT })
    expect(r.ok).toBe(true)
    const line = db.prepare(`SELECT billed_cost, confidence, actual_source FROM cost_line_items WHERE id = ?`).get(r.ledgerLineId) as { billed_cost: number; confidence: string; actual_source: string }
    expect(line.billed_cost).toBe(12000)
    expect(line.confidence).toBe('actual_invoice')
    expect(line.actual_source).toBe('email_invoice')
  })

  it('rejects a duplicate invoice (same provider+ref+period)', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const input = { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-001', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 12000 }
    const first = recordInvoice(db, input, { now: NOW, salt: SALT })
    expect(first.ok).toBe(true)
    const second = recordInvoice(db, input, { now: NOW + 10, salt: SALT })
    expect(second.ok).toBe(false)
    expect(second.duplicate).toBe(true)
    const count = db.prepare(`SELECT COUNT(*) as n FROM costops_invoices`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('allows re-recording the same dedup_key after the original was voided', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const input = { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-001', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 12000 }
    const first = recordInvoice(db, input, { now: NOW, salt: SALT })
    voidInvoice(db, first.invoiceId!, 'duplicate PDF, recorded in error', NOW + 5)
    const second = recordInvoice(db, input, { now: NOW + 10, salt: SALT })
    expect(second.ok).toBe(true)
  })
})

describe('recordInvoice -- an active ledger line already exists', () => {
  beforeEach(() => setup())

  it('goes through createCorrection: the original line is voided (not deleted), a new corrected line appears', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    // pre-existing manual estimate line
    const estInfo = db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at)
      VALUES ('render-hosting', @start, @end, 'usage', 10000, 'HUF', 'manual', @now, 'estimate-1', @now)
    `).run({ start: win.start, end: win.end, now: NOW })
    const originalLineId = estInfo.lastInsertRowid as number

    const r = recordInvoice(db, {
      source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-002',
      billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 11500,
    }, { now: NOW, salt: SALT })
    expect(r.ok).toBe(true)
    expect(r.ledgerLineId).not.toBe(originalLineId)

    const original = db.prepare(`SELECT billed_cost, voided_at FROM cost_line_items WHERE id = ?`).get(originalLineId) as { billed_cost: number; voided_at: number | null }
    expect(original.billed_cost).toBe(10000) // NEVER rewritten
    expect(original.voided_at).not.toBeNull() // voided, not deleted

    const corrected = db.prepare(`SELECT billed_cost, corrects_line_id FROM cost_line_items WHERE id = ?`).get(r.ledgerLineId) as { billed_cost: number; corrects_line_id: number }
    expect(corrected.billed_cost).toBe(11500)
    expect(corrected.corrects_line_id).toBe(originalLineId)
  })
})

describe('recordInvoice -- closed period', () => {
  beforeEach(() => setup())

  it('is refused when the period is closed and there is no existing line to correct', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    db.prepare(`INSERT INTO period_status (month, status, updated_at) VALUES (?, 'closed', ?)`).run(win.key, NOW)

    const r = recordInvoice(db, {
      source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-003',
      billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 5000,
    }, { now: NOW, salt: SALT })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
  })

  it('is allowed (as an audited correction) when the period is closed but an existing line can be corrected', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const estInfo = db.prepare(`
      INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at)
      VALUES ('render-hosting', @start, @end, 'usage', 10000, 'HUF', 'manual', @now, 'estimate-1', @now)
    `).run({ start: win.start, end: win.end, now: NOW })
    const originalLineId = estInfo.lastInsertRowid as number
    db.prepare(`INSERT INTO period_status (month, status, updated_at) VALUES (?, 'closed', ?)`).run(win.key, NOW)

    const r = recordInvoice(db, {
      source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-004',
      billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10500,
    }, { now: NOW, salt: SALT })
    expect(r.ok).toBe(true)
    const corrected = db.prepare(`SELECT billed_cost, corrects_line_id FROM cost_line_items WHERE id = ?`).get(r.ledgerLineId) as { billed_cost: number; corrects_line_id: number }
    expect(corrected.billed_cost).toBe(10500)
    expect(corrected.corrects_line_id).toBe(originalLineId)
  })
})

describe('applyInvoiceAdjustment', () => {
  beforeEach(() => setup())

  it('applies a credit and cascades the reduced net through a correction, keeping the original charge intact', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, {
      source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-005',
      billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 12000,
    }, { now: NOW, salt: SALT })
    const originalLineId = rec.ledgerLineId!

    const adj = applyInvoiceAdjustment(db, { invoiceId: rec.invoiceId!, creditAmount: 2000, reason: 'provider goodwill credit' }, { now: NOW + 100 })
    expect(adj.ok).toBe(true)

    const original = db.prepare(`SELECT billed_cost, voided_at FROM cost_line_items WHERE id = ?`).get(originalLineId) as { billed_cost: number; voided_at: number | null }
    expect(original.billed_cost).toBe(12000)
    expect(original.voided_at).not.toBeNull()

    const invoiceRow = db.prepare(`SELECT net_amount, credit_amount, ledger_line_id FROM costops_invoices WHERE id = ?`).get(rec.invoiceId) as { net_amount: number; credit_amount: number; ledger_line_id: number }
    expect(invoiceRow.net_amount).toBe(10000)
    expect(invoiceRow.credit_amount).toBe(2000)
    const correctedLine = db.prepare(`SELECT billed_cost FROM cost_line_items WHERE id = ?`).get(invoiceRow.ledger_line_id) as { billed_cost: number }
    expect(correctedLine.billed_cost).toBe(10000)
  })

  it('accumulates multiple partial adjustments rather than overwriting them', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-006', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10000 }, { now: NOW, salt: SALT })
    applyInvoiceAdjustment(db, { invoiceId: rec.invoiceId!, refundAmount: 500, reason: 'partial refund 1' }, { now: NOW + 10 })
    applyInvoiceAdjustment(db, { invoiceId: rec.invoiceId!, refundAmount: 300, reason: 'partial refund 2' }, { now: NOW + 20 })
    const invoiceRow = db.prepare(`SELECT net_amount, refund_amount FROM costops_invoices WHERE id = ?`).get(rec.invoiceId) as { net_amount: number; refund_amount: number }
    expect(invoiceRow.refund_amount).toBe(800)
    expect(invoiceRow.net_amount).toBe(9200)
  })

  it('rejects adjusting a voided invoice', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-007', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10000 }, { now: NOW, salt: SALT })
    voidInvoice(db, rec.invoiceId!, 'recorded in error', NOW + 5)
    const adj = applyInvoiceAdjustment(db, { invoiceId: rec.invoiceId!, creditAmount: 100, reason: 'x' }, { now: NOW + 10 })
    expect(adj.ok).toBe(false)
    expect(adj.status).toBe(409)
  })

  it('requires a reason', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-008', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10000 }, { now: NOW, salt: SALT })
    const adj = applyInvoiceAdjustment(db, { invoiceId: rec.invoiceId!, creditAmount: 100, reason: '' }, { now: NOW + 10 })
    expect(adj.status).toBe(400)
  })
})

describe('voidInvoice', () => {
  beforeEach(() => setup())

  it('rejects voiding an already-voided invoice', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-009', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10000 }, { now: NOW, salt: SALT })
    voidInvoice(db, rec.invoiceId!, 'first void', NOW + 5)
    const second = voidInvoice(db, rec.invoiceId!, 'second void', NOW + 10)
    expect(second.status).toBe(409)
  })

  it('requires a reason', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    const rec = recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-010', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 10000 }, { now: NOW, salt: SALT })
    expect(voidInvoice(db, rec.invoiceId!, '', NOW).status).toBe(400)
  })
})

describe('listInvoices', () => {
  beforeEach(() => setup())

  it('filters by source_id and month', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    const winPrev = monthWindow(NOW - 32 * 86400)
    insertSource(db, 'render-hosting', 'render')
    insertSource(db, 'openai-api', 'openai')
    recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'A', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 100 }, { now: NOW, salt: SALT })
    recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'B', billing_period_start: winPrev.start, billing_period_end: winPrev.end, currency: 'HUF', gross_amount: 90 }, { now: NOW, salt: SALT })
    recordInvoice(db, { source_id: 'openai-api', provider: 'openai', invoice_ref: 'C', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 50 }, { now: NOW, salt: SALT })

    expect(listInvoices(db, { source_id: 'render-hosting' })).toHaveLength(2)
    expect(listInvoices(db, { month: win.key, now: NOW })).toHaveLength(2)
    expect(listInvoices(db, { source_id: 'render-hosting', month: win.key, now: NOW })).toHaveLength(1)
  })
})

describe('buildInvoiceReconciliation', () => {
  beforeEach(() => setup())

  it('decorates reconciliation.ts rows with invoice detail for a source with an active invoice', async () => {
    const db = getDb()
    const win = monthWindow(NOW)
    insertSource(db, 'render-hosting', 'render')
    recordInvoice(db, { source_id: 'render-hosting', provider: 'render', invoice_ref: 'INV-011', billing_period_start: win.start, billing_period_end: win.end, currency: 'HUF', gross_amount: 12000, tax_amount: 1000, discount_amount: 500 }, { now: NOW, salt: SALT })
    const rows = await buildInvoiceReconciliation(db, NOW, win.key)
    const r = rows.find(x => x.source_id === 'render-hosting')!
    expect(r.invoice).not.toBeNull()
    expect(r.invoice!.gross_amount).toBe(12000)
    expect(r.invoice!.net_amount).toBe(11500)
  })

  it('leaves invoice null for a source with no active invoice this period', async () => {
    const db = getDb()
    insertSource(db, 'no-invoice-source', 'other')
    const rows = await buildInvoiceReconciliation(db, NOW)
    const r = rows.find(x => x.source_id === 'no-invoice-source')
    expect(r?.invoice ?? null).toBeNull()
  })
})

describe('initInvoiceSchema', () => {
  it('is idempotent and enforces the active-dedup_key uniqueness at the DB level', () => {
    initDatabase(':memory:')
    const db = getDb()
    initInvoiceSchema(db)
    initInvoiceSchema(db) // must not throw
    insertSource(db, 'render-hosting', 'render')
    const now = NOW
    db.prepare(`
      INSERT INTO costops_invoices (source_id, provider, billing_period_start, billing_period_end, currency, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount, status, dedup_key, recorded_at, created_at)
      VALUES ('render-hosting','render',0,1,'HUF',100,0,0,0,0,0,100,'recorded','dk1',@now,@now)
    `).run({ now })
    expect(() => {
      db.prepare(`
        INSERT INTO costops_invoices (source_id, provider, billing_period_start, billing_period_end, currency, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount, status, dedup_key, recorded_at, created_at)
        VALUES ('render-hosting','render',0,1,'HUF',100,0,0,0,0,0,100,'recorded','dk1',@now,@now)
      `).run({ now })
    }).toThrow()
  })
})
