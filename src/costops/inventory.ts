// CostOps Phase 0 -- full source inventory (gap-analysis GAP-03/GAP-04).
//
// Gathers the raw signals (cost_sources, import_runs, cost_line_items,
// config overrides) and feeds them through lifecycle.ts's pure derivation,
// so every known source gets an unambiguous lifecycle + provenance + the
// "what does a human need to do next" fields the gap-analysis calls for.
// Read-only, additive: does not touch getCostSummary's contract or any
// existing route's output shape.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import { deriveSourceLifecycle, deriveProvenance, type SourceLifecycle, type SourceProvenance } from './lifecycle.js'
import { getSecret } from '../web/vault.js'

export type Freshness = 'fresh' | 'aging' | 'stale' | 'unknown'
// Honest today: no collector in this codebase is wired to an automatic boot-time
// interval (verified 2026-07-15 -- only syncFixedCostsToLedger is; every provider
// collector is POST /api/costs/sync-triggered only). 'automatic_interval' is kept
// in the enum for the day that changes, not fabricated as the current state.
export type SyncCadence = 'manual' | 'automatic_interval' | 'config_driven'
export type OperationalInclusionRule = 'operational' | 'advisory_plan_estimate' | 'pending_permission_excluded' | 'no_data_yet'

export interface SourceInventoryEntry {
  source_id: string
  name: string
  provider: string
  source_type: string
  lifecycle: SourceLifecycle
  provenance: SourceProvenance
  collection_method: 'provider_api_collector' | 'email_invoice_ingest' | 'manual_config' | 'unknown'
  freshness: Freshness
  last_data_freshness: number | null
  sync_cadence: SyncCadence
  owner: string
  operational_inclusion_rule: OperationalInclusionRule
  manual_fallback: boolean
  blocker: string | null
  last_successful_sync: number | null
  last_attempted_sync: number | null
}

// Providers whose cost_sources rows are created by a live API collector (see
// runner.ts's upsertProviderLines / each collector's own upsert), keyed by
// provider (not source_id -- source_id is derived at runtime, e.g. from
// NormalizedCostLine.service, but provider is the stable, known key). Only
// these need a credential presence check; every manual/invoice-driven source
// (subscriptions, hosting, domain, ...) needs none -- credentialRequired=false
// for them by construction.
const CREDENTIAL_REGISTRY: Record<string, { checkKind: 'vault' | 'env'; id: string }> = {
  openai: { checkKind: 'vault', id: 'open_api_adminkey_readonly' },
  github: { checkKind: 'vault', id: 'github_plan' },
  deepseek: { checkKind: 'vault', id: 'DEEPSEEK_API_KEY' },
  render: { checkKind: 'env', id: 'RENDER_API_KEY' },
}

const DEFAULT_OWNER = process.env.COSTOPS_DEFAULT_OWNER || 'operator'

// Freshness thresholds -- not business-specified (same flagged-placeholder
// convention as warnings.ts's LARGE_INCREASE_FRACTION), tune once real 7-day
// observation data exists.
const FRESH_MAX_AGE_SECS = 3 * 24 * 3600
const AGING_MAX_AGE_SECS = 10 * 24 * 3600

function classifyFreshness(lastFreshness: number | null, now: number): Freshness {
  if (lastFreshness == null) return 'unknown'
  const age = now - lastFreshness
  if (age <= FRESH_MAX_AGE_SECS) return 'fresh'
  if (age <= AGING_MAX_AGE_SECS) return 'aging'
  return 'stale'
}

interface SourceRow {
  id: string
  name: string
  provider: string
  source_type: string
}

interface RunRow {
  provider: string
  status: string
  started_at: number
  error_code: string | null
}

interface LineAggRow {
  source_id: string
  confidence: string | null
  actual_source: string | null
  max_freshness: number | null
  ever_had_real_activity: number  // 0/1 from SQL, whether any non-voided row with billed_cost > 0 exists
  is_pending: number
  is_plan_estimate: number
}

export interface CredentialChecker {
  (kind: 'vault' | 'env', id: string): boolean
}

/** Real credential checker: Vault lookup / env var presence. Never logs the value. */
export function realCredentialChecker(): CredentialChecker {
  return (kind, id) => {
    if (kind === 'env') return !!process.env[id]
    try {
      return !!getSecret(id)
    } catch {
      return false
    }
  }
}

/**
 * Build the full source inventory. Pure aside from the injected `now` and DB
 * read + the injected credential checker (defaults to the real Vault/env
 * check) -- fully testable with a fake checker and no real secrets.
 */
export function buildSourceInventory(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  deps: { credentialChecker?: CredentialChecker } = {},
): SourceInventoryEntry[] {
  const checkCredential = deps.credentialChecker ?? realCredentialChecker()

  const sources = db.prepare(`SELECT id, name, provider, source_type FROM cost_sources WHERE active = 1 ORDER BY name`).all() as SourceRow[]

  // Latest run + last successful run + last failed run, per provider.
  const latestRows = db.prepare(`
    SELECT provider, status, started_at, error_code
    FROM import_runs r
    WHERE started_at = (SELECT MAX(started_at) FROM import_runs WHERE provider = r.provider)
    GROUP BY provider
  `).all() as RunRow[]
  const latestByProvider = new Map(latestRows.map(r => [r.provider, r]))
  const lastOkStmt = db.prepare(`SELECT MAX(started_at) t FROM import_runs WHERE provider = ? AND status = 'ok'`)

  // Per-source activity/provenance aggregate, across ALL time (not just the
  // current month -- lifecycle is "has this source EVER worked", not "did it
  // bill this month"), excluding voided rows.
  const lineAgg = db.prepare(`
    SELECT
      source_id,
      MAX(data_freshness) as max_freshness,
      MAX(CASE WHEN confidence = 'pending_permission' THEN 1 ELSE 0 END) as is_pending,
      MAX(CASE WHEN confidence = 'provider_plan_estimate' THEN 1 ELSE 0 END) as is_plan_estimate,
      MAX(CASE WHEN billed_cost > 0 THEN 1 ELSE 0 END) as ever_had_real_activity
    FROM cost_line_items
    WHERE voided_at IS NULL
    GROUP BY source_id
  `).all() as Array<Omit<LineAggRow, 'confidence' | 'actual_source'>>
  const aggBySource = new Map(lineAgg.map(r => [r.source_id, r]))

  // Most recent (confidence, actual_source) pair per source, for provenance --
  // the single latest non-voided row, mirroring getCostSummary's "resolve to
  // one representative line" approach but simplified (inventory doesn't need
  // the full confidence-priority resolution, just "what does this source's
  // data currently look like").
  const latestLineStmt = db.prepare(`
    SELECT confidence, actual_source FROM cost_line_items
    WHERE source_id = ? AND voided_at IS NULL
    ORDER BY data_freshness DESC, id DESC LIMIT 1
  `)

  const overrideBySourceId = new Map(config.fixed_costs.map(f => [f.source_id, f]))

  return sources.map((s): SourceInventoryEntry => {
    const override = overrideBySourceId.get(s.id)
    const registry = CREDENTIAL_REGISTRY[s.provider]
    const credentialRequired = registry != null
    const credentialPresent = credentialRequired ? checkCredential(registry.checkKind, registry.id) : false

    const latestRun = latestByProvider.get(s.provider) ?? null
    const lastOk = latestRun ? ((lastOkStmt.get(s.provider) as { t: number | null }).t ?? null) : null
    const lastRunStatus = latestRun ? (latestRun.status === 'ok' ? 'ok' as const : (latestRun.status as any)) : null

    const agg = aggBySource.get(s.id)
    const hasEverHadActivity = (agg?.ever_had_real_activity ?? 0) === 1

    const lifecycle = deriveSourceLifecycle({
      explicitlyUnsupported: override?.lifecycle_override === 'unsupported',
      explicitlyDeprecated: override?.lifecycle_override === 'deprecated',
      credentialRequired,
      credentialPresent,
      lastRunStatus,
      hasEverHadActivity,
    })

    const latestLine = latestLineStmt.get(s.id) as { confidence: string | null; actual_source: string | null } | undefined
    const provenance = deriveProvenance(latestLine?.confidence ?? null, latestLine?.actual_source ?? null)

    const collection_method: SourceInventoryEntry['collection_method'] =
      credentialRequired ? 'provider_api_collector'
      : latestLine?.actual_source === 'email_invoice' ? 'email_invoice_ingest'
      : latestLine != null || overrideBySourceId.has(s.id) ? 'manual_config'
      : 'unknown'

    const operational_inclusion_rule: OperationalInclusionRule =
      agg?.is_pending === 1 ? 'pending_permission_excluded'
      : agg?.is_plan_estimate === 1 ? 'advisory_plan_estimate'
      : hasEverHadActivity ? 'operational'
      : 'no_data_yet'

    const blocker = lifecycle === 'blocked'
      ? (latestRun?.error_code ?? 'collector run failed, see import_runs for detail')
      : lifecycle === 'not_configured'
      ? `missing credential (${registry?.checkKind === 'env' ? 'env var' : 'Vault secret'} '${registry?.id}')`
      : null

    return {
      source_id: s.id,
      name: s.name,
      provider: s.provider,
      source_type: s.source_type,
      lifecycle,
      provenance,
      collection_method,
      freshness: classifyFreshness(agg?.max_freshness ?? null, now),
      last_data_freshness: agg?.max_freshness ?? null,
      sync_cadence: credentialRequired ? 'manual' : 'config_driven',
      owner: override?.owner ?? DEFAULT_OWNER,
      operational_inclusion_rule,
      manual_fallback: !credentialRequired,
      blocker,
      last_successful_sync: lastOk,
      last_attempted_sync: latestRun?.started_at ?? null,
    }
  })
}
