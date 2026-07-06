// CostOps -- email-sourced cost ingest.
//
// Invoices/receipts that land in the operator's mailbox are the most authoritative
// cost signal (an actual charged amount). An agent-side sweep reads Gmail (which
// is not reachable from this backend), extracts a structured entry per receipt,
// and POSTs them here. This module is the PURE, deterministic ingest: it upserts
// one cost_line_item per (email, month) with an idempotent dedup key, so a sweep
// can safely re-run and re-ingest the same month without duplicating. NO raw email
// body, subject, sender address or PII is ever stored -- only the extracted amount,
// provider/source labels, the billing month, and a HASH of the message ref.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface EmailCostEntry {
  source_id: string          // stable id, e.g. 'anthropic-max' or 'aws'
  name: string               // human label, e.g. 'Claude Max'
  provider: string           // e.g. 'anthropic'
  amount: number             // in `currency`
  currency: string           // 'HUF' | 'USD' | ...
  month: string              // 'YYYY-MM' billing month
  message_ref: string        // opaque per-email ref (Gmail message id); hashed here
  confidence?: string        // default 'actual_invoice'
  source_type?: string       // default 'subscription'
}

export interface IngestResult {
  ingested: number
  skipped: number
  errors: Array<{ source_id: string; reason: string }>
}

function monthWindow(month: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const y = parseInt(month.slice(0, 4)), m = parseInt(month.slice(5, 7)) - 1
  return { start: Math.floor(Date.UTC(y, m, 1) / 1000), end: Math.floor(Date.UTC(y, m + 1, 1) / 1000) }
}

/** Convert an amount to HUF. HUF passes through; USD uses fx; unknown -> flagged. */
export function toHuf(amount: number, currency: string, fxUsdHuf: number): number | null {
  const cur = (currency || 'HUF').toUpperCase()
  if (cur === 'HUF') return Math.round(amount * 100) / 100
  if (cur === 'USD') return Math.round(amount * fxUsdHuf * 100) / 100
  // EUR/other not converted here (needs its own fx) -- caller should pre-convert.
  return null
}

/**
 * Idempotently upsert email-sourced cost lines. Deterministic, no I/O beyond the
 * passed db. Dedup key = `email|<sha256(message_ref)[:32]>|<month>`, so the same
 * receipt for the same month is updated in place, never duplicated.
 */
export function ingestEmailCosts(
  db: Database.Database,
  entries: EmailCostEntry[],
  opts: { fxUsdHuf: number; now: number; idSalt?: string },
): IngestResult {
  const salt = opts.idSalt ?? 'costops-email'
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, 'HUF', 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider,
      source_type=excluded.source_type, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES
      (@source_id, @start, @end, 'invoice', @name,
       NULL, NULL, NULL, @amount, NULL, 'HUF',
       @confidence, @now, @ref_hash, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, confidence=excluded.confidence,
      data_freshness=excluded.data_freshness, source_ref=excluded.source_ref
  `)
  const out: IngestResult = { ingested: 0, skipped: 0, errors: [] }
  const tx = db.transaction((list: EmailCostEntry[]) => {
    for (const e of list) {
      if (!e || typeof e.source_id !== 'string' || !e.source_id) { out.errors.push({ source_id: String(e?.source_id), reason: 'missing source_id' }); continue }
      const win = monthWindow(e.month)
      if (!win) { out.errors.push({ source_id: e.source_id, reason: `bad month '${e.month}'` }); continue }
      const amountHuf = toHuf(Number(e.amount), e.currency, opts.fxUsdHuf)
      if (amountHuf === null || !isFinite(amountHuf)) { out.errors.push({ source_id: e.source_id, reason: `uncconvertible currency '${e.currency}'` }); continue }
      const refHash = createHash('sha256').update(salt).update('|').update(String(e.message_ref)).digest('hex').slice(0, 32)
      const dedup = `email|${refHash}|${e.month}`
      upsertSource.run({ id: e.source_id, name: e.name || e.source_id, provider: e.provider || 'other', source_type: e.source_type || 'subscription', now: opts.now })
      upsertLine.run({
        source_id: e.source_id, start: win.start, end: win.end, name: e.name || e.source_id,
        amount: amountHuf, confidence: e.confidence || 'actual_invoice', now: opts.now,
        ref_hash: refHash, dedup_key: dedup,
      })
      out.ingested++
    }
  })
  tx(entries)
  return out
}
