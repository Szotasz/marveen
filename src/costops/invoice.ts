// CostOps Phase 2 -- invoice / credit / refund / correction workflow
// (GAP-14 / core-functional-scope-v1.0.1.md §14).
//
// Same category of module as correction.ts/period-close.ts (deterministic,
// auditable, DB-aware accounting operations -- not the pure-detector shape
// of alerts.ts/optimization.ts, since GAP-14 is fundamentally about WRITE
// events: recording an invoice, applying a credit/refund, voiding a mistake).
// No db.ts/web.ts/schema.ts edits: `initInvoiceSchema` is a schema DEFINER
// only, not mounted anywhere -- the seam aggregator calls it.
//
// `costops_invoices` is a NEW entity, separate from `cost_line_items`: a
// ledger line only ever carries one number (billed_cost); an invoice needs
// the full gross/tax/discount/credit/refund/late-charge breakdown GAP-14
// requires, plus its own status lifecycle (recorded/voided) and duplicate
// detection independent of the ledger line it eventually produces or
// corrects. Every invoice write that changes an EXISTING ledger amount goes
// through Mason's correction.ts `createCorrection` -- REUSED, not
// duplicated, per the dispatch's explicit instruction. That single
// mechanism is what makes every GAP-14 acceptance criterion true by
// construction: the original charge is never deleted (createCorrection
// voids + inserts, never UPDATEs in place), and a late invoice arriving
// after a month closes is FORCED through the same correction path because
// period-close.ts's write-guard blocks any other direct write to a closed
// month -- recordInvoice below explicitly checks that guard and refuses to
// silently write around it.

import type Database from 'better-sqlite3'
import { monthWindow, hashRef } from './ledger.js'
import { checkPeriodWritable } from './period-close.js'
import { createCorrection } from './correction.js'

// ---- status + amounts -------------------------------------------------------------------

export type InvoiceStatus = 'recorded' | 'voided'

export interface InvoiceAmounts {
  gross_amount: number
  tax_amount: number
  discount_amount: number
  credit_amount: number
  refund_amount: number
  late_charge_amount: number
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

/**
 * net = gross - discount - credit - refund + late_charge. `tax_amount` is
 * informational (already included in `gross_amount`, matching how a real
 * invoice states "Total: $120 (incl. $20 tax)") -- NOT added a second time.
 * Sign convention: discount/credit/refund all REDUCE net; late_charge
 * INCREASES it. This is the single source of truth every write function
 * below uses -- never a second, divergent net calculation.
 */
export function computeNetAmount(a: InvoiceAmounts): number {
  return round2(a.gross_amount - a.discount_amount - a.credit_amount - a.refund_amount + a.late_charge_amount)
}

// ---- duplicate detection ------------------------------------------------------------------

/** dedup_key = provider + invoice_ref (hashed, never raw) + billing period -- GAP-14's "dedup by provider+invoice_ref+period." */
export function invoiceDedupKey(provider: string, invoiceRefHashOrFallback: string, periodKey: string): string {
  return `${provider}|${invoiceRefHashOrFallback}|${periodKey}`
}

// ---- expected-invoice-cadence inference (feeds alerts.ts's missing_invoice detector) --------

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Infers when the NEXT invoice is expected from a source's OWN observed
 * invoice history (billing_period_end dates, ascending) -- never a
 * fabricated business-rule guess like "always monthly." Needs at least 2
 * historical invoices to infer a cadence (the gap between them); returns
 * null otherwise (never fabricated from a single data point).
 */
export function inferExpectedInvoiceBy(periodEndsAsc: number[], graceDays = 15): number | null {
  if (periodEndsAsc.length < 2) return null
  const gaps: number[] = []
  for (let i = 1; i < periodEndsAsc.length; i++) gaps.push(periodEndsAsc[i] - periodEndsAsc[i - 1])
  const typicalGap = median(gaps)
  const last = periodEndsAsc[periodEndsAsc.length - 1]
  return last + typicalGap + graceDays * 86400
}

// ---- recording an invoice ------------------------------------------------------------------

export interface RecordInvoiceInput {
  source_id: string
  provider: string
  invoice_ref: string | null // RAW ref -- hashed internally via hashRef, never stored raw (README's no-raw-invoice-ref rule)
  billing_period_start: number
  billing_period_end: number
  service_period_start?: number | null
  service_period_end?: number | null
  currency: string
  gross_amount: number
  tax_amount?: number
  discount_amount?: number
  credit_amount?: number
  refund_amount?: number
  late_charge_amount?: number
}

export interface RecordInvoiceResult {
  ok: boolean
  error?: string
  status?: number
  invoiceId?: number
  ledgerLineId?: number | null
  duplicate?: boolean
}

/**
 * Records a new invoice. Rejects a duplicate (same provider+invoice_ref+
 * period, still active) before touching anything else. Then integrates it
 * into the ledger:
 * - An ACTIVE ledger line already exists for this source+period -> ALWAYS
 *   goes through `createCorrection` (never a bare UPDATE), whether the
 *   period is open or closed -- an invoice-driven change to an existing
 *   committed number is exactly the auditable event GAP-14 requires.
 * - No active line exists and the period is OPEN/provisional/reopened ->
 *   a plain first-time INSERT (nothing to correct yet).
 * - No active line exists and the period is CLOSED -> refused. A closed
 *   month with literally no line to correct against would otherwise be a
 *   silent direct write into a closed period -- the one case
 *   createCorrection cannot rescue (it requires an existing row). The
 *   period must be explicitly reopened first (period-close.ts's audited path).
 */
export function recordInvoice(db: Database.Database, input: RecordInvoiceInput, opts: { now: number; salt: string }): RecordInvoiceResult {
  if (!input.source_id) return { ok: false, error: 'source_id is required', status: 400 }
  if (!input.provider) return { ok: false, error: 'provider is required', status: 400 }
  if (!input.currency) return { ok: false, error: 'currency is required', status: 400 }
  if (!Number.isFinite(input.gross_amount) || input.gross_amount < 0) return { ok: false, error: 'gross_amount must be a non-negative number', status: 400 }
  if (!Number.isFinite(input.billing_period_start) || !Number.isFinite(input.billing_period_end) || input.billing_period_end <= input.billing_period_start) {
    return { ok: false, error: 'billing_period_start/end must be a valid range', status: 400 }
  }

  const amounts: InvoiceAmounts = {
    gross_amount: input.gross_amount,
    tax_amount: input.tax_amount ?? 0,
    discount_amount: input.discount_amount ?? 0,
    credit_amount: input.credit_amount ?? 0,
    refund_amount: input.refund_amount ?? 0,
    late_charge_amount: input.late_charge_amount ?? 0,
  }
  const net = computeNetAmount(amounts)

  const refHash = input.invoice_ref ? hashRef(opts.salt, input.invoice_ref) : null
  const periodKey = monthWindow(input.billing_period_start).key
  const dedupKey = invoiceDedupKey(input.provider, refHash ?? `noref-${input.source_id}`, periodKey)

  const dup = db.prepare(`SELECT id FROM costops_invoices WHERE dedup_key = ? AND status != 'voided'`).get(dedupKey) as { id: number } | undefined
  if (dup) return { ok: false, error: `duplicate invoice: an active invoice already exists for ${dedupKey}`, status: 409, duplicate: true }

  const writable = checkPeriodWritable(db, periodKey)
  const activeLine = db.prepare(`
    SELECT id FROM cost_line_items
    WHERE source_id = ? AND charge_period_start < ? AND charge_period_end > ? AND voided_at IS NULL
    ORDER BY data_freshness DESC LIMIT 1
  `).get(input.source_id, input.billing_period_end, input.billing_period_start) as { id: number } | undefined

  if (!writable.writable && !activeLine) {
    return { ok: false, error: `${writable.reason} -- and no existing ledger line exists to correct`, status: 409 }
  }

  let caughtError: string | null = null
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO costops_invoices
        (source_id, provider, invoice_ref_hash, billing_period_start, billing_period_end, service_period_start, service_period_end,
         currency, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount,
         status, ledger_line_id, dedup_key, recorded_at, created_at)
      VALUES (@source_id, @provider, @ref_hash, @start, @end, @service_start, @service_end,
              @currency, @gross, @tax, @discount, @credit, @refund, @late, @net,
              'recorded', NULL, @dedup_key, @now, @now)
    `).run({
      source_id: input.source_id, provider: input.provider, ref_hash: refHash,
      start: input.billing_period_start, end: input.billing_period_end,
      service_start: input.service_period_start ?? null, service_end: input.service_period_end ?? null,
      currency: input.currency, gross: amounts.gross_amount, tax: amounts.tax_amount,
      discount: amounts.discount_amount, credit: amounts.credit_amount, refund: amounts.refund_amount,
      late: amounts.late_charge_amount, net, dedup_key: dedupKey, now: opts.now,
    })
    const invoiceId = info.lastInsertRowid as number

    let ledgerLineId: number | null = null
    if (activeLine) {
      const reasonPrefix = writable.writable ? 'invoice recorded' : 'late invoice recorded (period closed)'
      const corr = createCorrection(db, { originalLineId: activeLine.id, newAmount: net, reason: `${reasonPrefix}: ${dedupKey}` }, { now: opts.now })
      if (!corr.ok) { caughtError = corr.error ?? 'correction failed'; return null }
      ledgerLineId = corr.newLineId ?? null
    } else {
      const lineDedup = `invoice|${input.source_id}|${periodKey}|${opts.now}`
      const lineInfo = db.prepare(`
        INSERT INTO cost_line_items
          (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at, actual_source)
        VALUES (@source_id, @start, @end, 'usage', @net, @currency, 'actual_invoice', @now, @dedup_key, @now, 'email_invoice')
      `).run({ source_id: input.source_id, start: input.billing_period_start, end: input.billing_period_end, net, currency: input.currency, dedup_key: lineDedup, now: opts.now })
      ledgerLineId = lineInfo.lastInsertRowid as number
    }

    db.prepare(`UPDATE costops_invoices SET ledger_line_id = ? WHERE id = ?`).run(ledgerLineId, invoiceId)
    return { invoiceId, ledgerLineId }
  })

  const result = tx()
  if (caughtError || !result) return { ok: false, error: caughtError ?? 'record invoice failed', status: 500 }
  return { ok: true, invoiceId: result.invoiceId, ledgerLineId: result.ledgerLineId }
}

// ---- credit / refund / late-charge adjustment on an existing invoice ------------------------

export interface ApplyInvoiceAdjustmentInput {
  invoiceId: number
  creditAmount?: number
  refundAmount?: number
  lateChargeAmount?: number
  reason: string
}

interface InvoiceRow extends InvoiceAmounts {
  id: number
  status: InvoiceStatus
  ledger_line_id: number | null
}

/**
 * Applies an ADDITIONAL credit/refund/late-charge to an already-recorded
 * invoice (cumulative -- e.g. two partial refunds add up, never overwrite
 * each other). Recomputes net and, if the invoice has a linked ledger line,
 * cascades the new net through `createCorrection` -- always, regardless of
 * period status (correction is the one write path that's never blocked).
 * The ORIGINAL charge is never touched; only a new corrected line appears,
 * per GAP-14's "eredeti charge megmarad."
 */
export function applyInvoiceAdjustment(db: Database.Database, input: ApplyInvoiceAdjustmentInput, opts: { now: number }): RecordInvoiceResult {
  if (!input.reason || !input.reason.trim()) return { ok: false, error: 'reason is required for an invoice adjustment (auditability)', status: 400 }
  const row = db.prepare(`SELECT id, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, status, ledger_line_id FROM costops_invoices WHERE id = ?`).get(input.invoiceId) as InvoiceRow | undefined
  if (!row) return { ok: false, error: `no invoice with id ${input.invoiceId}`, status: 404 }
  if (row.status === 'voided') return { ok: false, error: `invoice ${input.invoiceId} is voided -- cannot adjust it`, status: 409 }

  const amounts: InvoiceAmounts = {
    gross_amount: row.gross_amount, tax_amount: row.tax_amount, discount_amount: row.discount_amount,
    credit_amount: round2(row.credit_amount + (input.creditAmount ?? 0)),
    refund_amount: round2(row.refund_amount + (input.refundAmount ?? 0)),
    late_charge_amount: round2(row.late_charge_amount + (input.lateChargeAmount ?? 0)),
  }
  const net = computeNetAmount(amounts)

  let caughtError: string | null = null
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE costops_invoices SET credit_amount=@credit, refund_amount=@refund, late_charge_amount=@late, net_amount=@net
      WHERE id=@id
    `).run({ credit: amounts.credit_amount, refund: amounts.refund_amount, late: amounts.late_charge_amount, net, id: input.invoiceId })

    let ledgerLineId = row.ledger_line_id
    if (row.ledger_line_id != null) {
      const corr = createCorrection(db, { originalLineId: row.ledger_line_id, newAmount: net, reason: `invoice adjustment: ${input.reason}` }, { now: opts.now })
      if (!corr.ok) { caughtError = corr.error ?? 'correction failed'; return }
      ledgerLineId = corr.newLineId ?? row.ledger_line_id
      db.prepare(`UPDATE costops_invoices SET ledger_line_id = ? WHERE id = ?`).run(ledgerLineId, input.invoiceId)
    }
  })
  tx()
  if (caughtError) return { ok: false, error: caughtError, status: 500 }
  return { ok: true, invoiceId: input.invoiceId }
}

// ---- void (mistake, not a real credit/refund) -------------------------------------------------

/**
 * Voids an invoice ENTITY (e.g. it was recorded in error) -- status flag
 * only, never a hard delete (matches Phase 0's void/archive-over-delete
 * decision, card 73e8914a). Does NOT touch the linked ledger line; if the
 * invoice's amount was already applied to the ledger, correct that
 * separately via applyInvoiceAdjustment/createCorrection -- voiding the
 * invoice record and correcting the ledger are deliberately independent
 * operations (an invoice can be voided for record-keeping reasons, e.g. a
 * duplicate PDF, without implying the ledger amount was ever wrong).
 */
export function voidInvoice(db: Database.Database, invoiceId: number, reason: string, now: number): RecordInvoiceResult {
  if (!reason || !reason.trim()) return { ok: false, error: 'reason is required to void an invoice (auditability)', status: 400 }
  const row = db.prepare(`SELECT status FROM costops_invoices WHERE id = ?`).get(invoiceId) as { status: InvoiceStatus } | undefined
  if (!row) return { ok: false, error: `no invoice with id ${invoiceId}`, status: 404 }
  if (row.status === 'voided') return { ok: false, error: `invoice ${invoiceId} is already voided`, status: 409 }
  db.prepare(`UPDATE costops_invoices SET status='voided', void_reason=?, voided_at=? WHERE id=?`).run(reason, now, invoiceId)
  return { ok: true, invoiceId }
}

// ---- read paths ------------------------------------------------------------------------------

export interface InvoiceListRow {
  id: number
  source_id: string
  provider: string
  billing_period_start: number
  billing_period_end: number
  service_period_start: number | null
  service_period_end: number | null
  currency: string
  gross_amount: number
  tax_amount: number
  discount_amount: number
  credit_amount: number
  refund_amount: number
  late_charge_amount: number
  net_amount: number
  status: InvoiceStatus
  ledger_line_id: number | null
  recorded_at: number
}

export function listInvoices(db: Database.Database, opts: { source_id?: string; month?: string; now?: number; limit?: number } = {}): InvoiceListRow[] {
  const limit = opts.limit ?? 200
  const clauses: string[] = []
  const params: Record<string, unknown> = { limit }
  if (opts.source_id) { clauses.push('source_id = @source_id'); params.source_id = opts.source_id }
  if (opts.month) {
    const w = monthWindow(opts.now ?? 0, opts.month)
    clauses.push('billing_period_start < @end AND billing_period_end > @start')
    params.start = w.start; params.end = w.end
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(`
    SELECT id, source_id, provider, billing_period_start, billing_period_end, service_period_start, service_period_end,
           currency, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount,
           status, ledger_line_id, recorded_at
    FROM costops_invoices ${where} ORDER BY billing_period_start DESC, recorded_at DESC LIMIT @limit
  `).all(params) as InvoiceListRow[]
}

// ---- invoice-to-provider reconciliation (extends reconciliation.ts) ---------------------------

export interface InvoiceReconciliationDetail {
  gross_amount: number
  tax_amount: number
  discount_amount: number
  credit_amount: number
  refund_amount: number
  late_charge_amount: number
  net_amount: number
  status: InvoiceStatus
}

/**
 * Decorates reconciliation.ts's per-source view (unmodified, imported and
 * reused, not duplicated) with the invoice-specific gross/tax/credit/
 * refund/late-charge breakdown for sources that have an active invoice this
 * period -- reconciliation.ts's own `observed_provider_amount` /
 * `invoice_amount` / `variance` fields already answer "provider API vs
 * invoice"; this adds "what the invoice ITSELF was actually made of."
 * `invoice` is null for a source with no active invoice this period (never
 * fabricated).
 */
export async function buildInvoiceReconciliation(db: Database.Database, now: number, month?: string) {
  const { buildReconciliation } = await import('./reconciliation.js')
  const base = buildReconciliation(db, now, month)
  const win = monthWindow(now, month)
  const invoiceRows = db.prepare(`
    SELECT source_id, gross_amount, tax_amount, discount_amount, credit_amount, refund_amount, late_charge_amount, net_amount, status
    FROM costops_invoices
    WHERE billing_period_start < @end AND billing_period_end > @start AND status != 'voided'
  `).all({ start: win.start, end: win.end }) as Array<{ source_id: string } & InvoiceReconciliationDetail>
  const bySource = new Map(invoiceRows.map(r => [r.source_id, r]))
  return base.map(r => {
    const inv = bySource.get(r.source_id)
    const invoice: InvoiceReconciliationDetail | null = inv ? {
      gross_amount: inv.gross_amount, tax_amount: inv.tax_amount, discount_amount: inv.discount_amount,
      credit_amount: inv.credit_amount, refund_amount: inv.refund_amount, late_charge_amount: inv.late_charge_amount,
      net_amount: inv.net_amount, status: inv.status,
    } : null
    return { ...r, invoice }
  })
}

// ---- schema (DEFINER ONLY -- not mounted; see file header) --------------------------------------

/**
 * Schema DEFINER only. NOT called from db.ts or src/costops/schema.ts.
 * Partial unique index (`WHERE status != 'voided'`) enforces "duplicate
 * invoice not counted twice" at the DB level too, while still allowing the
 * SAME dedup_key to be re-recorded after a voided (mistaken) entry.
 */
export function initInvoiceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS costops_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES cost_sources(id),
      provider TEXT NOT NULL,
      invoice_ref_hash TEXT,
      billing_period_start INTEGER NOT NULL,
      billing_period_end INTEGER NOT NULL,
      service_period_start INTEGER,
      service_period_end INTEGER,
      currency TEXT NOT NULL,
      gross_amount REAL NOT NULL,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      credit_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      late_charge_amount REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'recorded',
      void_reason TEXT,
      voided_at INTEGER,
      ledger_line_id INTEGER REFERENCES cost_line_items(id),
      dedup_key TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_costops_invoices_dedup_active ON costops_invoices(dedup_key) WHERE status != 'voided'`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_costops_invoices_source ON costops_invoices(source_id, billing_period_start)`)
}
