// CostOps Phase 1 (GAP-05/GAP-06/GAP-14) -- correction relationship for
// cost_line_items, extending Phase 0's void/archive pattern.
//
// A void alone answers "this row is gone from the active ledger." A
// correction answers the stronger question the gap-analysis calls out:
// "what REPLACED it, and can I trace back from the new number to the old
// one." createCorrection() voids the original row (same auditable mechanism
// as manual-entry.ts's deleteManualCost) AND inserts a new row carrying
// corrects_line_id -> the original's id, so the relationship survives in
// the schema itself, not just by matching source_id/month/timing.
//
// Unlike Phase 0's void (manual entries only), a correction can apply to ANY
// active line -- a provider_api or invoice-derived amount can be wrong too
// (GAP-14 explicitly covers correcting invoice/provider amounts, not just
// manual ones). The guard is narrower instead: a line can only be corrected
// ONCE (correct the newer replacement if it's still wrong, not the original
// a second time) -- keeps the correction chain linear and traceable.

import type Database from 'better-sqlite3'

export interface CreateCorrectionInput {
  originalLineId: number
  newAmount: number
  reason: string
}

export interface CorrectionResult {
  ok: boolean
  error?: string
  status?: number
  newLineId?: number
}

interface OriginalRow {
  id: number
  source_id: string
  charge_period_start: number
  charge_period_end: number
  charge_category: string
  service_name: string | null
  usage_type: string | null
  consumed_quantity: number | null
  consumed_unit: string | null
  currency: string
  confidence: string
  source_ref: string | null
  dedup_key: string | null
  actual_source: string | null
  original_amount: number | null
  original_currency: string | null
  fx_rate: number | null
  fx_date: number | null
  voided_at: number | null
}

export function createCorrection(
  db: Database.Database,
  input: CreateCorrectionInput,
  opts: { now: number },
): CorrectionResult {
  if (!input || !Number.isFinite(input.originalLineId) || input.originalLineId <= 0) {
    return { ok: false, error: 'missing or invalid originalLineId', status: 400 }
  }
  if (!Number.isFinite(input.newAmount) || input.newAmount < 0) {
    return { ok: false, error: 'newAmount must be a non-negative number', status: 400 }
  }
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, error: 'reason is required for a correction (auditability)', status: 400 }
  }

  const original = db.prepare(`SELECT * FROM cost_line_items WHERE id = ?`).get(input.originalLineId) as OriginalRow | undefined
  if (!original) return { ok: false, error: `no cost_line_items row with id ${input.originalLineId}`, status: 404 }
  if (original.voided_at != null) return { ok: false, error: `line ${input.originalLineId} is already voided/corrected`, status: 409 }

  const alreadyCorrected = db.prepare(`SELECT 1 FROM cost_line_items WHERE corrects_line_id = ?`).get(input.originalLineId)
  if (alreadyCorrected) return { ok: false, error: `line ${input.originalLineId} already has a correction -- correct the newer replacement instead, not the original again`, status: 409 }

  const newDedupKey = `correction|${input.originalLineId}|${opts.now}`

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE cost_line_items SET voided_at = @now, void_reason = @reason, dedup_key = @voidedDedupKey
      WHERE id = @id
    `).run({
      now: opts.now, reason: `superseded by correction: ${input.reason}`,
      voidedDedupKey: original.dedup_key ? `${original.dedup_key}|corrected|${opts.now}` : `corrected|${input.originalLineId}|${opts.now}`,
      id: input.originalLineId,
    })
    const info = db.prepare(`
      INSERT INTO cost_line_items
        (source_id, charge_period_start, charge_period_end, charge_category, service_name,
         usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
         confidence, data_freshness, source_ref, dedup_key, created_at, actual_source,
         original_amount, original_currency, fx_rate, fx_date, corrects_line_id)
      VALUES
        (@source_id, @start, @end, @charge_category, @service_name,
         @usage_type, @consumed_quantity, @consumed_unit, @billed_cost, NULL, @currency,
         @confidence, @now, @source_ref, @dedup_key, @now, @actual_source,
         @original_amount, @original_currency, @fx_rate, @fx_date, @corrects_line_id)
    `).run({
      source_id: original.source_id, start: original.charge_period_start, end: original.charge_period_end,
      charge_category: original.charge_category, service_name: original.service_name,
      usage_type: original.usage_type, consumed_quantity: original.consumed_quantity, consumed_unit: original.consumed_unit,
      billed_cost: input.newAmount, currency: original.currency, confidence: original.confidence,
      now: opts.now, source_ref: original.source_ref, dedup_key: newDedupKey, actual_source: original.actual_source,
      original_amount: original.original_amount, original_currency: original.original_currency,
      fx_rate: original.fx_rate, fx_date: original.fx_date, corrects_line_id: input.originalLineId,
    })
    return info.lastInsertRowid as number
  })

  const newLineId = tx()
  return { ok: true, newLineId }
}

export interface CorrectionChainEntry {
  id: number
  billed_cost: number
  voided_at: number | null
  void_reason: string | null
  created_at: number
}

/**
 * Walk the full correction chain for a line, oldest first -- the original
 * (possibly voided-by-correction) plus every correction that followed,
 * however many links deep. Read-only, used for audit/drill-down.
 */
export function getCorrectionChain(db: Database.Database, lineId: number): CorrectionChainEntry[] {
  const chain: CorrectionChainEntry[] = []
  // Walk BACKWARD to find the true root first (a caller might pass a
  // mid-chain id), then forward to collect every link.
  let rootId = lineId
  for (;;) {
    const row = db.prepare(`SELECT corrects_line_id FROM cost_line_items WHERE id = ?`).get(rootId) as { corrects_line_id: number | null } | undefined
    if (!row?.corrects_line_id) break
    rootId = row.corrects_line_id
  }
  let currentId: number | null = rootId
  while (currentId != null) {
    const row = db.prepare(`SELECT id, billed_cost, voided_at, void_reason, created_at FROM cost_line_items WHERE id = ?`).get(currentId) as CorrectionChainEntry | undefined
    if (!row) break
    chain.push(row)
    const next = db.prepare(`SELECT id FROM cost_line_items WHERE corrects_line_id = ?`).get(currentId) as { id: number } | undefined
    currentId = next?.id ?? null
  }
  return chain
}
