// CostOps v0.3 -- provider cost collector framework (types).
//
// Provider-agnostic, deterministic, NO LLM. The HTTP fetcher is INJECTED so
// collectors are unit-tested fully offline with fixtures -- no live provider
// call happens unless a real fetcher is passed in by an explicitly-approved run.
// Secrets are passed in by the runner (from the Vault) and are NEVER logged.

export type CostConfidenceApi = 'provider_api' | 'billing_export'

export interface NormalizedCostLine {
  provider: string
  service: string                 // maps to a cost_sources.id (e.g. 'anthropic-api')
  billing_period_start: number    // epoch sec
  billing_period_end: number      // epoch sec
  amount: number                  // in `currency`
  currency: string
  confidence: CostConfidenceApi
  usage_type?: string | null
  quantity?: number | null
  unit?: string | null
  data_freshness_at: number       // provider "as of" time (epoch sec)
  raw_ref_hash?: string | null    // sha256(salt, raw id) -- NEVER a raw account/invoice id
  dedup_key: string               // idempotent upsert key
}

// Injected HTTP GET returning parsed JSON. Tests pass a stub that returns a
// fixture; a live run would pass a real implementation (only after approval).
export type HttpGetJson = (url: string, headers: Record<string, string>) => Promise<unknown>

export interface CollectOpts {
  periodStart: number
  periodEnd: number
  secret: string                  // from Vault; NEVER logged/persisted
  fxUsdHuf: number
  idSalt: string                  // for raw_ref_hash
  httpGetJson: HttpGetJson        // injected -- offline in tests
}

export interface ProviderCollector {
  provider: string
  collectorName: string
  // PURE network READ + normalize. Never writes to the provider. No LLM.
  collect(opts: CollectOpts): Promise<NormalizedCostLine[]>
  // Optional: same READ, but also returns the raw response so a DRY-RUN can
  // describe its SHAPE (types only, never values). No secret is in `raw`'s
  // shape description. Collectors without this fall back to lines-only dry-run.
  collectRaw?(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }>
}

// 'dry_run' marks a preview run that imported NOTHING (imported_count always 0).
export type ImportStatus = 'ok' | 'partial' | 'rate_limited' | 'error' | 'dry_run'

// A sanitized description of a value's STRUCTURE -- types, object keys, and
// array lengths ONLY. It carries NO scalar values, so no secret, account id,
// invoice ref, or raw provider datum can travel in it.
export type ShapeNode =
  | 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  | { type: 'array'; length: number; of: ShapeNode }
  | { type: 'object'; keys: Record<string, ShapeNode> }

// Result of a DRY-RUN: what a real import WOULD do, without persisting any
// provider_api cost line. Secret-free by construction.
export interface DryRunReport {
  provider: string
  collectorName: string
  status: 'dry_run' | 'error'
  plannedLines: NormalizedCostLine[]  // normalized lines (raw_ref_hash is a hash, no raw id)
  dedupKeys: string[]                 // the idempotent keys a real import would upsert on
  responseShape: ShapeNode | null     // sanitized shape of the provider response (null if unavailable)
  wouldImportCount: number            // how many provider_api lines a real import WOULD write
  errorCode: string | null
  errorMessageSanitized: string | null
}

export interface ImportRunResult {
  provider: string
  collectorName: string
  status: ImportStatus
  importedCount: number
  errorCode: string | null
  errorMessageSanitized: string | null
  dataFreshnessAt: number | null
}
