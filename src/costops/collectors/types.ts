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
}

export type ImportStatus = 'ok' | 'partial' | 'rate_limited' | 'error'

export interface ImportRunResult {
  provider: string
  collectorName: string
  status: ImportStatus
  importedCount: number
  errorCode: string | null
  errorMessageSanitized: string | null
  dataFreshnessAt: number | null
}
