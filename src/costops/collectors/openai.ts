// CostOps -- OpenAI cost collector (LIVE, read-only).
//
// Uses the OpenAI Costs API (GET /v1/organizations/costs) which returns daily
// USD cost buckets and REQUIRES an admin key. The mapper is a PURE function
// tested offline against a fixture; collect() calls the INJECTED httpGetJson so
// no network happens unless a real fetcher is passed. The admin key arrives via
// opts.secret (from the Vault) and is NEVER logged or persisted. No provider-
// side write ever happens (pure GET).

import { createHash } from 'node:crypto'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from './types.js'

const OPENAI_COSTS_URL = 'https://api.openai.com/v1/organizations/costs'
// All OpenAI API usage reconciles against this source id (matches the manual
// 'openai-api' / 'openai-chatgpt' line family so estimate and actual share it).
const OPENAI_API_SOURCE = 'openai-api'

function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

interface OpenAiAmount { value?: number | string; currency?: string }
interface OpenAiCostResult { amount?: OpenAiAmount; line_item?: string | null; project_id?: string | null }
interface OpenAiCostBucket { start_time?: number; end_time?: number; results?: OpenAiCostResult[] }
interface OpenAiCostsPage { object?: string; data?: OpenAiCostBucket[]; has_more?: boolean; next_page?: string | null }

/**
 * PURE mapper: OpenAI /organizations/costs page -> a single aggregated
 * provider_api line for the openai-api source for the requested period. Daily
 * USD amounts are summed and converted to HUF via fxUsdHuf. Deterministic; no
 * I/O. Returns [] if the page carries no cost results (so an all-zero month can
 * still be reported by the caller as an explicit 0-with-freshness line).
 */
export function mapOpenAiCosts(
  raw: unknown,
  opts: { periodStart: number; periodEnd: number; fxUsdHuf: number; idSalt: string; now: number },
): NormalizedCostLine[] {
  const page = (raw && typeof raw === 'object') ? raw as OpenAiCostsPage : {}
  const buckets = Array.isArray(page.data) ? page.data : []
  let usdTotal = 0
  let latestEnd = 0
  let any = false
  for (const b of buckets) {
    if (typeof b.end_time === 'number' && b.end_time > latestEnd) latestEnd = b.end_time
    for (const r of (Array.isArray(b.results) ? b.results : [])) {
      const rawAmt = r.amount?.value
      const amt = typeof rawAmt === 'number' ? rawAmt : parseFloat(String(rawAmt ?? ''))
      if (!isFinite(amt)) continue
      // OpenAI costs are USD. Non-USD is not expected; if seen, still sum the
      // numeric value and let the live-verify step flag the currency mismatch.
      usdTotal += amt
      any = true
    }
  }
  if (!any) return []
  const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7)
  const amountHuf = Math.round(usdTotal * opts.fxUsdHuf * 100) / 100
  return [{
    provider: 'openai',
    service: OPENAI_API_SOURCE,
    billing_period_start: opts.periodStart,
    billing_period_end: opts.periodEnd,
    amount: amountHuf,
    currency: 'HUF',
    confidence: 'provider_api',
    usage_type: 'api_usage',
    quantity: null,
    unit: null,
    data_freshness_at: latestEnd || opts.now,
    raw_ref_hash: hashRef(opts.idSalt, `openai-costs|${monthKey}`),
    dedup_key: `provider|openai|${OPENAI_API_SOURCE}|${monthKey}|provider_api`,
  }]
}

export const openaiCollector: ProviderCollector = {
  provider: 'openai',
  collectorName: 'openai-costs',
  async collectRaw(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }> {
    // OpenAI Costs API takes unix start_time; daily buckets; limit covers a month.
    const url = `${OPENAI_COSTS_URL}?start_time=${opts.periodStart}&end_time=${opts.periodEnd}&bucket_width=1d&limit=31`
    // secret used ONLY as the auth header; never logged.
    const headers = {
      'authorization': `Bearer ${opts.secret}`,
      'content-type': 'application/json',
    }
    const raw = await opts.httpGetJson(url, headers)
    const lines = mapOpenAiCosts(raw, {
      periodStart: opts.periodStart, periodEnd: opts.periodEnd,
      fxUsdHuf: opts.fxUsdHuf, idSalt: opts.idSalt, now: opts.periodStart,
    })
    return { raw, lines }
  },
  async collect(opts: CollectOpts): Promise<NormalizedCostLine[]> {
    return (await this.collectRaw!(opts)).lines
  },
}

/** Vault secret id for the OpenAI admin (read-only) key. */
export const OPENAI_VAULT_SECRET_ID = 'open_api_adminkey_readonly'

/**
 * LIVE read-only sync: pulls the admin key from the Vault (never logged), calls
 * the Costs API for the current month, and records a provider_api line + an
 * import_runs row. No provider-side write. Injected deps let tests stub both the
 * key and the fetcher.
 */
export async function syncOpenAiCollector(
  db: import('better-sqlite3').Database,
  now: number,
  deps: { httpGetJson?: import('./types.js').HttpGetJson; apiKey?: string | null; fxUsdHuf?: number } = {},
): Promise<{ ok: boolean; provider: string; status: string; imported_count: number; error?: string; period?: string }> {
  const { runCollector } = await import('./runner.js')
  const { monthWindow } = await import('../ledger.js')
  let apiKey = deps.apiKey
  if (apiKey === undefined) {
    try {
      const { getSecret } = await import('../../web/vault.js')
      apiKey = getSecret(OPENAI_VAULT_SECRET_ID)
    } catch { apiKey = null }
  }
  if (!apiKey) {
    return { ok: false, provider: 'openai', status: 'error', imported_count: 0, error: `no OpenAI key in vault (${OPENAI_VAULT_SECRET_ID})` }
  }
  let fxUsdHuf = deps.fxUsdHuf
  if (fxUsdHuf === undefined) {
    try {
      const { loadRenderPricing } = await import('./render.js')
      fxUsdHuf = loadRenderPricing().pricing.fx_usd_huf || 0
    } catch { fxUsdHuf = 0 }
  }
  const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'GET', headers })
    if (!r.ok) throw new Error(`openai api ${r.status}`)
    return r.json()
  })
  const w = monthWindow(now)
  const opts = { periodStart: w.start, periodEnd: w.end, secret: apiKey, fxUsdHuf: fxUsdHuf || 0, idSalt: 'openai-salt', httpGetJson }
  const res = await runCollector({ db, collector: openaiCollector, opts, now })
  return {
    ok: res.status === 'ok', provider: 'openai', status: res.status,
    imported_count: res.importedCount, error: res.errorMessageSanitized || undefined, period: w.key,
  }
}
