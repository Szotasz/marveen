// CostOps -- manual cost/entitlement entry (card a1552362, item 3).
//
// Every other cost_line_items/entitlements write path in this file is an automated
// collector or an agent-side Gmail sweep. There was no way to hand-enter a cost or
// entitlement the operator already knows (e.g. a provider with no API/no invoice yet) --
// this is that one manual door. Same conventions as email-ingest.ts: idempotent
// upsert by dedup_key, HUF-normalized amount with original-currency retention,
// confidence/actual_source explicitly 'manual'/'manual_entry' (never guessed).
//
// POST creates a NEW entry (409 if one already exists for that key -- forces an
// explicit PATCH to change a number someone already hand-entered, rather than a
// second POST silently overwriting it). PATCH updates an existing entry (404 if
// missing). DELETE voids it (card 73e8914a, Phase 0 decision) rather than hard-
// deleting -- see deleteManualCost below.

import type Database from 'better-sqlite3'
import { toHuf, fxRateFor } from './email-ingest.js'
import { checkPeriodWritable } from './period-close.js'

export interface ManualCostInput {
  source_id: string
  name: string
  provider: string
  amount: number
  currency: string      // 'HUF' | 'USD' | 'EUR' | ...
  month: string          // 'YYYY-MM'
  source_type?: string   // default 'subscription'
}

export interface ManualCostPatch {
  source_id: string
  month: string
  amount: number
  currency: string
}

export interface ManualCostDeleteInput {
  source_id: string
  month: string
  /** Free-text reason for the void, surfaced in the audit trail. Never
   * required (a UI "remove" click may have no reason to give), but recorded
   * verbatim when present. */
  reason?: string
}

function monthWindow(month: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const y = parseInt(month.slice(0, 4)), m = parseInt(month.slice(5, 7)) - 1
  return { start: Math.floor(Date.UTC(y, m, 1) / 1000), end: Math.floor(Date.UTC(y, m + 1, 1) / 1000) }
}

function manualCostDedupKey(sourceId: string, month: string): string {
  return `manual|${sourceId}|${month}`
}

export function createManualCost(
  db: Database.Database,
  input: ManualCostInput,
  opts: { fxUsdHuf: number; fxEurHuf?: number; now: number },
): { ok: boolean; error?: string; status?: number } {
  if (!input || typeof input.source_id !== 'string' || !input.source_id) return { ok: false, error: 'missing source_id', status: 400 }
  if (!input.name) return { ok: false, error: 'missing name', status: 400 }
  if (!input.provider) return { ok: false, error: 'missing provider', status: 400 }
  const win = monthWindow(input.month)
  if (!win) return { ok: false, error: `bad month '${input.month}'`, status: 400 }
  // Phase 2 (GAP-13): a closed month accepts no direct write -- use a correction instead.
  const writable = checkPeriodWritable(db, input.month)
  if (!writable.writable) return { ok: false, error: writable.reason, status: 409 }
  const cur = (input.currency || 'HUF').toUpperCase()
  const amountHuf = toHuf(Number(input.amount), cur, opts.fxUsdHuf, opts.fxEurHuf ?? 0)
  if (amountHuf === null || !isFinite(amountHuf)) return { ok: false, error: `unconvertible currency '${input.currency}'`, status: 400 }
  const dedup = manualCostDedupKey(input.source_id, input.month)
  const existing = db.prepare(`SELECT 1 FROM cost_line_items WHERE dedup_key = ?`).get(dedup)
  if (existing) return { ok: false, error: `a manual entry for '${input.source_id}' / '${input.month}' already exists -- use PATCH to update it`, status: 409 }

  const wasConverted = cur !== 'HUF'
  const appliedFxRate = fxRateFor(cur, opts.fxUsdHuf, opts.fxEurHuf ?? 0)
  db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at)
    VALUES (@id, @name, @provider, @source_type, 'HUF', 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, provider=excluded.provider, source_type=excluded.source_type, updated_at=excluded.updated_at
  `).run({ id: input.source_id, name: input.name, provider: input.provider, source_type: input.source_type || 'subscription', now: opts.now })
  db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at, actual_source,
       original_amount, original_currency, fx_rate, fx_date, fx_source, conversion_method)
    VALUES
      (@source_id, @start, @end, 'invoice', @name,
       NULL, NULL, NULL, @amount, NULL, 'HUF',
       'manual', @now, NULL, @dedup_key, @now, 'manual_entry',
       @original_amount, @original_currency, @fx_rate, @fx_date, @fx_source, @conversion_method)
  `).run({
    source_id: input.source_id, start: win.start, end: win.end, name: input.name,
    amount: amountHuf, now: opts.now, dedup_key: dedup,
    original_amount: wasConverted ? Number(input.amount) : null,
    original_currency: wasConverted ? cur : null,
    fx_rate: wasConverted ? appliedFxRate : null,
    fx_date: wasConverted ? opts.now : null,
    // Phase 1 (GAP-09): a manual entry has no invoice date to prefer --
    // 'service_date_rate' (the entry's own month), same rate source as
    // every other conversion in this codebase (Render pricing config).
    fx_source: wasConverted ? 'render_pricing_config' : null,
    conversion_method: wasConverted ? 'service_date_rate' : null,
  })
  return { ok: true }
}

export function updateManualCost(
  db: Database.Database,
  patch: ManualCostPatch,
  opts: { fxUsdHuf: number; fxEurHuf?: number; now: number },
): { ok: boolean; error?: string; status?: number } {
  if (!patch || typeof patch.source_id !== 'string' || !patch.source_id) return { ok: false, error: 'missing source_id', status: 400 }
  const win = monthWindow(patch.month)
  if (!win) return { ok: false, error: `bad month '${patch.month}'`, status: 400 }
  const dedup = manualCostDedupKey(patch.source_id, patch.month)
  const existing = db.prepare(`SELECT confidence FROM cost_line_items WHERE dedup_key = ?`).get(dedup) as { confidence: string } | undefined
  if (!existing) return { ok: false, error: `no manual entry for '${patch.source_id}' / '${patch.month}' -- use POST to create one`, status: 404 }
  if (existing.confidence !== 'manual') return { ok: false, error: `'${patch.source_id}' / '${patch.month}' is not a manual entry (confidence='${existing.confidence}')`, status: 409 }
  // Phase 2 (GAP-13): a closed month accepts no direct write -- use a correction instead.
  const writable = checkPeriodWritable(db, patch.month)
  if (!writable.writable) return { ok: false, error: writable.reason, status: 409 }
  const cur = (patch.currency || 'HUF').toUpperCase()
  const amountHuf = toHuf(Number(patch.amount), cur, opts.fxUsdHuf, opts.fxEurHuf ?? 0)
  if (amountHuf === null || !isFinite(amountHuf)) return { ok: false, error: `unconvertible currency '${patch.currency}'`, status: 400 }
  const wasConverted = cur !== 'HUF'
  const appliedFxRate = fxRateFor(cur, opts.fxUsdHuf, opts.fxEurHuf ?? 0)
  db.prepare(`
    UPDATE cost_line_items SET
      billed_cost = @amount, data_freshness = @now,
      original_amount = @original_amount, original_currency = @original_currency,
      fx_rate = @fx_rate, fx_date = @fx_date, fx_source = @fx_source, conversion_method = @conversion_method
    WHERE dedup_key = @dedup_key
  `).run({
    amount: amountHuf, now: opts.now, dedup_key: dedup,
    original_amount: wasConverted ? Number(patch.amount) : null,
    original_currency: wasConverted ? cur : null,
    fx_rate: wasConverted ? appliedFxRate : null,
    fx_date: wasConverted ? opts.now : null,
    fx_source: wasConverted ? 'render_pricing_config' : null,
    conversion_method: wasConverted ? 'service_date_rate' : null,
  })
  return { ok: true }
}

// Card 73e8914a (Phase 0 decision, docs/costops/phase0-73e8914a-void-vs-delete.md): create+patch
// had no way to remove a mistyped row -- only direct SQL on cost_line_items could. Same guard as
// updateManualCost (404 if missing, 409 if the row isn't actually a manual entry) so this door can
// never touch a live provider-fed row.
//
// VOID, not hard DELETE: a financial ledger row must stay auditable (accounting-integrity
// principle, gap-analysis GAP-15) -- reversing the file header's original "no soft-delete layer"
// stance, which predates the formal accounting-integrity requirements. Sets voided_at/void_reason
// and RENAMES dedup_key (appends |voided|<now>) so (a) every aggregation read path can exclude it
// via `voided_at IS NULL` and (b) the original dedup_key slot is free for a fresh, correct POST --
// a re-entry after a mistaken void is a NEW audited entry, not a silent overwrite of the old one.
export function deleteManualCost(
  db: Database.Database,
  input: ManualCostDeleteInput,
  opts: { now: number },
): { ok: boolean; error?: string; status?: number } {
  if (!input || typeof input.source_id !== 'string' || !input.source_id) return { ok: false, error: 'missing source_id', status: 400 }
  const win = monthWindow(input.month)
  if (!win) return { ok: false, error: `bad month '${input.month}'`, status: 400 }
  const dedup = manualCostDedupKey(input.source_id, input.month)
  const existing = db.prepare(`SELECT confidence, voided_at FROM cost_line_items WHERE dedup_key = ?`).get(dedup) as { confidence: string; voided_at: number | null } | undefined
  if (!existing) return { ok: false, error: `no manual entry for '${input.source_id}' / '${input.month}'`, status: 404 }
  if (existing.confidence !== 'manual') return { ok: false, error: `'${input.source_id}' / '${input.month}' is not a manual entry (confidence='${existing.confidence}')`, status: 409 }
  if (existing.voided_at != null) return { ok: false, error: `'${input.source_id}' / '${input.month}' is already voided`, status: 409 }
  // Phase 2 (GAP-13): a closed month accepts no direct write, including a void -- use a correction instead.
  const writable = checkPeriodWritable(db, input.month)
  if (!writable.writable) return { ok: false, error: writable.reason, status: 409 }
  db.prepare(`
    UPDATE cost_line_items SET voided_at = @now, void_reason = @reason, dedup_key = @voidedDedupKey
    WHERE dedup_key = @dedup
  `).run({ now: opts.now, reason: input.reason ?? null, voidedDedupKey: `${dedup}|voided|${opts.now}`, dedup })
  return { ok: true }
}

export interface ManualEntitlementInput {
  provider: string
  product: string
  plan_name?: string | null
  billing_period: string   // e.g. 'monthly' | 'weekly' | 'ongoing'
  entitlement_type: string
  included_limit?: number | null
  included_unit?: string | null
  remaining?: number | null
  reset_at?: number | null   // epoch seconds
  status: string             // 'ok' | 'warning' | 'critical' | 'unknown'
}

export interface ManualEntitlementPatch extends ManualEntitlementInput {}

function entitlementDedupKey(e: { provider: string; product: string; entitlement_type: string; billing_period: string }): string {
  return `manual|${e.provider}|${e.product}|${e.entitlement_type}|${e.billing_period}`
}

export function createManualEntitlement(
  db: Database.Database,
  input: ManualEntitlementInput,
  now: number,
): { ok: boolean; error?: string; status?: number } {
  if (!input?.provider) return { ok: false, error: 'missing provider', status: 400 }
  if (!input?.product) return { ok: false, error: 'missing product', status: 400 }
  if (!input?.entitlement_type) return { ok: false, error: 'missing entitlement_type', status: 400 }
  if (!input?.billing_period) return { ok: false, error: 'missing billing_period', status: 400 }
  if (!input?.status) return { ok: false, error: 'missing status', status: 400 }
  const dedup = entitlementDedupKey(input)
  const existing = db.prepare(`SELECT 1 FROM entitlements WHERE dedup_key = ?`).get(dedup)
  if (existing) return { ok: false, error: `a manual entitlement for '${dedup}' already exists -- use PATCH to update it`, status: 409 }
  db.prepare(`
    INSERT INTO entitlements
      (provider, product, plan_name, billing_period, entitlement_type,
       included_limit, included_unit, usage_to_date, remaining, usage_pct, reset_at,
       usage_source, usage_confidence, forecast_exhaustion_at, status, dedup_key, last_updated, created_at)
    VALUES
      (@provider, @product, @plan_name, @billing_period, @entitlement_type,
       @included_limit, @included_unit, NULL, @remaining, NULL, @reset_at,
       'manual', 'manual', NULL, @status, @dedup_key, @now, @now)
  `).run({
    provider: input.provider, product: input.product, plan_name: input.plan_name ?? null,
    billing_period: input.billing_period, entitlement_type: input.entitlement_type,
    included_limit: input.included_limit ?? null, included_unit: input.included_unit ?? null,
    remaining: input.remaining ?? null, reset_at: input.reset_at ?? null, status: input.status,
    dedup_key: dedup, now,
  })
  return { ok: true }
}

export function updateManualEntitlement(
  db: Database.Database,
  patch: ManualEntitlementPatch,
  now: number,
): { ok: boolean; error?: string; status?: number } {
  if (!patch?.provider || !patch?.product || !patch?.entitlement_type || !patch?.billing_period) {
    return { ok: false, error: 'missing provider/product/entitlement_type/billing_period', status: 400 }
  }
  const dedup = entitlementDedupKey(patch)
  const existing = db.prepare(`SELECT usage_source FROM entitlements WHERE dedup_key = ?`).get(dedup) as { usage_source: string } | undefined
  if (!existing) return { ok: false, error: `no manual entitlement for '${dedup}' -- use POST to create one`, status: 404 }
  if (existing.usage_source !== 'manual') return { ok: false, error: `'${dedup}' is not a manual entitlement (usage_source='${existing.usage_source}')`, status: 409 }
  db.prepare(`
    UPDATE entitlements SET
      plan_name = @plan_name, included_limit = @included_limit, included_unit = @included_unit,
      remaining = @remaining, reset_at = @reset_at, status = @status, last_updated = @now
    WHERE dedup_key = @dedup_key
  `).run({
    plan_name: patch.plan_name ?? null, included_limit: patch.included_limit ?? null,
    included_unit: patch.included_unit ?? null, remaining: patch.remaining ?? null,
    reset_at: patch.reset_at ?? null, status: patch.status, now, dedup_key: dedup,
  })
  return { ok: true }
}

export interface ManualEntitlementDeleteInput {
  provider: string
  product: string
  entitlement_type: string
  billing_period: string
}

// Card 73e8914a: same missing lifecycle corner as deleteManualCost above -- same guard
// (404 missing, 409 not-manual), hard delete.
export function deleteManualEntitlement(
  db: Database.Database,
  input: ManualEntitlementDeleteInput,
): { ok: boolean; error?: string; status?: number } {
  if (!input?.provider || !input?.product || !input?.entitlement_type || !input?.billing_period) {
    return { ok: false, error: 'missing provider/product/entitlement_type/billing_period', status: 400 }
  }
  const dedup = entitlementDedupKey(input)
  const existing = db.prepare(`SELECT usage_source FROM entitlements WHERE dedup_key = ?`).get(dedup) as { usage_source: string } | undefined
  if (!existing) return { ok: false, error: `no manual entitlement for '${dedup}'`, status: 404 }
  if (existing.usage_source !== 'manual') return { ok: false, error: `'${dedup}' is not a manual entitlement (usage_source='${existing.usage_source}')`, status: 409 }
  db.prepare(`DELETE FROM entitlements WHERE dedup_key = ?`).run(dedup)
  return { ok: true }
}
