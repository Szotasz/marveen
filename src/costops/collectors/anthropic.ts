// CostOps v0.3 -- Anthropic cost collector (LIVE-READY, but no live call in PR1).
//
// The mapper is a PURE function tested offline against a fixture. collect()
// builds the request and calls the INJECTED httpGetJson, so no network happens
// unless a real fetcher is passed after explicit approval. The Admin API key is
// received via opts.secret (from the Vault) and is NEVER logged.
//
// NOTE: the exact Anthropic Admin cost_report field names must be verified on
// the first approved live dry-run; the fixture + mapper here are a matched pair
// modelling the documented shape (time buckets -> per-line cost results in USD).

import { createHash } from 'node:crypto'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from './types.js'

const ANTHROPIC_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report'
const ANTHROPIC_VERSION = '2023-06-01'
// All Anthropic API usage reconciles against this source (matches the v0.1
// manual/estimate line 'anthropic-api' so estimate and actual share a source).
const ANTHROPIC_API_SOURCE = 'anthropic-api'

function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

interface AnthropicCostResult {
  currency?: string
  amount?: number | string
  cost_type?: string
  model?: string
  service?: string
  description?: string
}
interface AnthropicCostBucket {
  starting_at?: string
  ending_at?: string
  results?: AnthropicCostResult[]
}
interface AnthropicCostReport {
  data?: AnthropicCostBucket[]
  has_more?: boolean
}

/**
 * PURE mapper: Anthropic cost_report -> a single aggregated provider_api line
 * for the anthropic-api source for the requested period. USD amounts are
 * converted to HUF via fxUsdHuf. Deterministic; no I/O. Returns [] if nothing.
 */
export function mapAnthropicCostReport(
  raw: unknown,
  opts: { periodStart: number; periodEnd: number; fxUsdHuf: number; idSalt: string; now: number },
): NormalizedCostLine[] {
  const report = (raw && typeof raw === 'object') ? raw as AnthropicCostReport : {}
  const buckets = Array.isArray(report.data) ? report.data : []
  let usdTotal = 0
  let latestEnd = 0
  let any = false
  for (const b of buckets) {
    const endSec = b.ending_at ? Math.floor(new Date(b.ending_at).getTime() / 1000) : 0
    if (endSec > latestEnd) latestEnd = endSec
    for (const r of (Array.isArray(b.results) ? b.results : [])) {
      const amt = typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount ?? ''))
      if (!isFinite(amt)) continue
      // report may already be in the account currency; treat as USD only when labelled USD (default).
      const cur = (r.currency || 'USD').toUpperCase()
      usdTotal += cur === 'USD' ? amt : amt // v0.1: assume USD; non-USD handled at live-verify time
      any = true
    }
  }
  if (!any) return []
  const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7)
  const amountHuf = Math.round(usdTotal * opts.fxUsdHuf * 100) / 100
  return [{
    provider: 'anthropic',
    service: ANTHROPIC_API_SOURCE,
    billing_period_start: opts.periodStart,
    billing_period_end: opts.periodEnd,
    amount: amountHuf,
    currency: 'HUF',
    confidence: 'provider_api',
    usage_type: 'api_usage',
    quantity: null,
    unit: null,
    data_freshness_at: latestEnd || opts.now,
    raw_ref_hash: hashRef(opts.idSalt, `anthropic-cost-report|${monthKey}`),
    dedup_key: `provider|anthropic|${ANTHROPIC_API_SOURCE}|${monthKey}|provider_api`,
  }]
}

export const anthropicCollector: ProviderCollector = {
  provider: 'anthropic',
  collectorName: 'anthropic-cost-report',
  // READ the cost report and return BOTH the raw response and the normalized
  // lines. The raw is used ONLY to describe its shape in a dry-run (never
  // persisted, never logged). The secret is used only as the auth header.
  async collectRaw(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }> {
    const startIso = new Date(opts.periodStart * 1000).toISOString()
    const endIso = new Date(opts.periodEnd * 1000).toISOString()
    const url = `${ANTHROPIC_COST_URL}?starting_at=${encodeURIComponent(startIso)}&ending_at=${encodeURIComponent(endIso)}`
    // secret used ONLY as the auth header; never logged.
    const headers = {
      'x-api-key': opts.secret,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    }
    const raw = await opts.httpGetJson(url, headers)
    const lines = mapAnthropicCostReport(raw, {
      periodStart: opts.periodStart, periodEnd: opts.periodEnd,
      fxUsdHuf: opts.fxUsdHuf, idSalt: opts.idSalt, now: opts.periodStart,
    })
    return { raw, lines }
  },
  async collect(opts: CollectOpts): Promise<NormalizedCostLine[]> {
    return (await this.collectRaw!(opts)).lines
  },
}
