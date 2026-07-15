// CostOps -- GitHub billing collector (LIVE, read-only).
//
// Uses the GitHub enhanced billing platform usage report
// (GET /users/{user}/settings/billing/usage) which returns per-line usage with a
// netAmount (USD). A fine-grained PAT with "Plan: read-only" is required. The
// mapper is PURE and offline-tested; collect() calls the INJECTED httpGetJson so
// no network happens unless a real fetcher is passed. The token arrives via
// opts.secret (from the Vault) and is NEVER logged. Pure GET, no provider write.
//
// Unlike usage-billing providers that omit an empty period, GitHub reports an
// EXPLICIT 0-with-freshness line on a successful empty response, so the dashboard
// shows a provider_api-observed 0 (not a manual estimate) for a no-usage month.

import { createHash } from 'node:crypto'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from './types.js'

const GITHUB_API = 'https://api.github.com'
const GITHUB_API_SOURCE = 'github'

function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

interface GitHubUsageItem {
  date?: string
  product?: string
  sku?: string
  quantity?: number
  unitType?: string
  pricePerUnit?: number
  grossAmount?: number
  discountAmount?: number
  netAmount?: number | string
  organizationName?: string
  repositoryName?: string
}
interface GitHubUsageReport { usageItems?: GitHubUsageItem[] }

/**
 * PURE mapper: GitHub billing usage report -> a single aggregated provider_api
 * line for the github source. netAmount (USD) is summed and converted to HUF.
 * A valid-but-empty report yields an explicit 0 line (API-observed zero), so the
 * caller can show GitHub as provider_api with a real freshness even at $0.
 * Returns [] only when the raw is not a recognizable usage report.
 */
export function mapGitHubUsage(
  raw: unknown,
  opts: { periodStart: number; periodEnd: number; fxUsdHuf: number; idSalt: string; now: number },
): NormalizedCostLine[] {
  const report = (raw && typeof raw === 'object') ? raw as GitHubUsageReport : null
  if (!report || !Array.isArray(report.usageItems)) return []
  let usdTotal = 0
  for (const it of report.usageItems) {
    const raw2 = it.netAmount
    const amt = typeof raw2 === 'number' ? raw2 : parseFloat(String(raw2 ?? ''))
    if (isFinite(amt)) usdTotal += amt
  }
  const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7)
  const amountHuf = Math.round(usdTotal * opts.fxUsdHuf * 100) / 100
  return [{
    provider: 'github',
    service: GITHUB_API_SOURCE,
    billing_period_start: opts.periodStart,
    billing_period_end: opts.periodEnd,
    amount: amountHuf,
    currency: 'HUF',
    confidence: 'provider_api',
    usage_type: 'usage_billing',
    quantity: null,
    unit: null,
    data_freshness_at: opts.now,
    raw_ref_hash: hashRef(opts.idSalt, `github-usage|${monthKey}`),
    dedup_key: `provider|github|${GITHUB_API_SOURCE}|${monthKey}|provider_api`,
  }]
}

/** The account whose billing is read. Set via COSTOPS_GITHUB_BILLING_USER env var. */
export const GITHUB_BILLING_USER = process.env.COSTOPS_GITHUB_BILLING_USER || ''

export function makeGitHubCollector(user: string = GITHUB_BILLING_USER): ProviderCollector {
  return {
    provider: 'github',
    collectorName: 'github-billing-usage',
    async collectRaw(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }> {
      const d = new Date(opts.periodStart * 1000)
      const url = `${GITHUB_API}/users/${user}/settings/billing/usage?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`
      // secret used ONLY as the auth header; never logged.
      const headers = {
        'authorization': `Bearer ${opts.secret}`,
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      }
      const raw = await opts.httpGetJson(url, headers)
      const lines = mapGitHubUsage(raw, {
        periodStart: opts.periodStart, periodEnd: opts.periodEnd,
        fxUsdHuf: opts.fxUsdHuf, idSalt: opts.idSalt, now: opts.periodStart,
      })
      return { raw, lines }
    },
    async collect(opts: CollectOpts): Promise<NormalizedCostLine[]> {
      return (await this.collectRaw!(opts)).lines
    },
  }
}

export const githubCollector: ProviderCollector = makeGitHubCollector()

/** Vault secret id for the GitHub fine-grained PAT (Plan: read-only). */
export const GITHUB_VAULT_SECRET_ID = 'github_plan'

/**
 * LIVE read-only sync: pulls the PAT from the Vault (never logged), reads the
 * billing usage report for the current month, and records a provider_api line +
 * import_runs row. No provider-side write.
 */
export async function syncGitHubCollector(
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
      apiKey = getSecret(GITHUB_VAULT_SECRET_ID)
    } catch { apiKey = null }
  }
  if (!apiKey) {
    return { ok: false, provider: 'github', status: 'error', imported_count: 0, error: `no GitHub token in vault (${GITHUB_VAULT_SECRET_ID})` }
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
    if (!r.ok) throw new Error(`github api ${r.status}`)
    return r.json()
  })
  const w = monthWindow(now)
  const opts = { periodStart: w.start, periodEnd: w.end, secret: apiKey, fxUsdHuf: fxUsdHuf || 0, idSalt: 'github-salt', httpGetJson }
  const res = await runCollector({ db, collector: githubCollector, opts, now })
  return {
    ok: res.status === 'ok', provider: 'github', status: res.status,
    imported_count: res.importedCount, error: res.errorMessageSanitized || undefined, period: w.key,
  }
}
