// CostOps v0.3 -- Render plan-based infra cost collector.
//
// READ-ONLY. Enumerates Render services (+ postgres) and maps their PLAN to a
// monthly HUF estimate from a local, configurable plan->price map. This is a
// `provider_plan_estimate` (advisory) -- NOT an invoice, NOT provider_api actual.
// It never modifies any Render resource. Raw service/account IDs are NEVER stored
// or returned: only a hashed ref + a sanitized type/plan label. The API key is
// used only as an auth header (in the live fetcher) and is never logged/persisted.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PROJECT_ROOT } from '../../config.js'
import type { ProviderCollector, CollectOpts, NormalizedCostLine } from './types.js'

export const RENDER_PRICING_PATH = join(PROJECT_ROOT, 'store', 'costops-render-pricing.json')
export const RENDER_PRICING_EXAMPLE = join(PROJECT_ROOT, 'src', 'costops', 'collectors', 'render-pricing.example.json')

const RENDER_SERVICES_URL = 'https://api.render.com/v1/services?limit=100'
const RENDER_POSTGRES_URL = 'https://api.render.com/v1/postgres?limit=100'

export interface RenderPricing {
  version: number
  currency: string
  fx_usd_huf: number
  plans: Record<string, Record<string, number>>  // type -> plan -> USD/month
}

function hashRef(salt: string, raw: string): string {
  return createHash('sha256').update(salt).update('|').update(raw).digest('hex').slice(0, 32)
}

/** Load the local (gitignored) Render plan->price map. Missing -> zero-rate, flagged. */
export function loadRenderPricing(): { pricing: RenderPricing; exists: boolean } {
  const empty: RenderPricing = { version: 1, currency: 'HUF', fx_usd_huf: 0, plans: {} }
  if (!existsSync(RENDER_PRICING_PATH)) {
    // write a safe zero-rate example next to the config for guidance (once)
    try {
      if (!existsSync(RENDER_PRICING_EXAMPLE)) {
        writeFileSync(RENDER_PRICING_EXAMPLE, JSON.stringify(EXAMPLE_PRICING, null, 2) + '\n')
      }
    } catch { /* best effort */ }
    return { pricing: empty, exists: false }
  }
  try {
    const raw = JSON.parse(readFileSync(RENDER_PRICING_PATH, 'utf-8')) as Partial<RenderPricing>
    return {
      pricing: {
        version: typeof raw.version === 'number' ? raw.version : 1,
        currency: typeof raw.currency === 'string' ? raw.currency : 'HUF',
        fx_usd_huf: typeof raw.fx_usd_huf === 'number' ? raw.fx_usd_huf : 0,
        plans: (raw.plans && typeof raw.plans === 'object') ? raw.plans as RenderPricing['plans'] : {},
      },
      exists: true,
    }
  } catch {
    return { pricing: empty, exists: true }
  }
}

const EXAMPLE_PRICING = {
  _doc: 'CostOps v0.3 Render plan->USD/month map. Copy to store/costops-render-pricing.json (gitignored) and fill REAL Render list prices + fx_usd_huf. All zero here (safe example). Unknown plan -> unpriced warning, never a fabricated amount. static_site/suspended = 0. Overage/seat/tax NOT modelled (see not_covered).',
  version: 1,
  currency: 'HUF',
  fx_usd_huf: 0,
  plans: {
    web_service: { free: 0, starter: 0, standard: 0, pro: 0, pro_plus: 0, pro_max: 0, pro_ultra: 0 },
    private_service: { starter: 0, standard: 0, pro: 0 },
    background_worker: { starter: 0, standard: 0, pro: 0 },
    cron_job: { starter: 0 },
    static_site: { free: 0 },
    postgres: { free: 0, basic_256mb: 0, basic_1gb: 0, basic_4gb: 0, pro: 0 },
    key_value: { starter: 0, standard: 0, pro: 0 },
  },
}

// ---- normalized shapes seen from the Render API (READ) ----------------------
interface RenderServiceDetails { plan?: string; numInstances?: number; env?: string; region?: string }
interface RenderService { id?: string; name?: string; type?: string; suspended?: string; serviceDetails?: RenderServiceDetails }
interface RenderPostgres { id?: string; name?: string; plan?: string; suspended?: string; status?: string }

export interface RenderBreakdown {
  service_count: number
  by_type_plan: Record<string, { count: number; usd: number }>   // "web_service/starter" -> {...}
  unpriced: Array<{ type: string; plan: string; count: number }>
  undercount_flags: string[]
  suspended_count: number
  total_usd: number
  total_huf: number
  fx_usd_huf: number
}

const RENDER_SOURCE = 'render-plan'

/**
 * PURE mapper: {services, postgres} raw -> ONE aggregated provider_plan_estimate
 * line for the render-plan source + a breakdown. Deterministic, no I/O, no secret.
 * static_site/suspended -> 0. Unknown plan -> unpriced (0 + flag), never fabricated.
 */
export function mapRenderPlanCost(
  raw: unknown,
  opts: { periodStart: number; periodEnd: number; pricing: RenderPricing; idSalt: string; now: number },
): { lines: NormalizedCostLine[]; breakdown: RenderBreakdown } {
  const r = (raw && typeof raw === 'object') ? raw as { services?: unknown; postgres?: unknown } : {}
  const serviceItems = Array.isArray(r.services) ? r.services : []
  const pgItems = Array.isArray(r.postgres) ? r.postgres : []
  const plans = opts.pricing.plans || {}
  const fx = opts.pricing.fx_usd_huf || 0

  const by_type_plan: RenderBreakdown['by_type_plan'] = {}
  const unpricedMap = new Map<string, { type: string; plan: string; count: number }>()
  const flags: string[] = []
  let total_usd = 0
  let count = 0
  let suspended_count = 0
  let staticCount = 0
  let missingInstances = 0

  const addUnit = (type: string, plan: string, suspended: boolean) => {
    count++
    if (suspended) { suspended_count++; return }  // suspended -> not billed
    if (type === 'static_site') { staticCount++; return }  // free flat; bandwidth uncounted
    const table = plans[type]
    const price = table ? table[plan] : undefined
    if (typeof price !== 'number') {
      const key = `${type}/${plan || 'unknown'}`
      const u = unpricedMap.get(key) || { type, plan: plan || 'unknown', count: 0 }
      u.count++; unpricedMap.set(key, u)
      return
    }
    total_usd += price
    const key = `${type}/${plan}`
    const b = by_type_plan[key] || { count: 0, usd: 0 }
    b.count++; b.usd = Math.round((b.usd + price) * 100) / 100
    by_type_plan[key] = b
  }

  for (const it of serviceItems) {
    const svc = (it && typeof it === 'object' && 'service' in (it as object))
      ? (it as { service: RenderService }).service
      : (it as RenderService)
    const type = String(svc?.type || 'unknown')
    const plan = String(svc?.serviceDetails?.plan || (type === 'static_site' ? 'free' : ''))
    const suspended = !!svc?.suspended && svc.suspended !== 'not_suspended'
    let instances = svc?.serviceDetails?.numInstances
    if (typeof instances !== 'number' || instances < 1) { instances = 1; if (type !== 'static_site' && !suspended) missingInstances++ }
    for (let i = 0; i < instances; i++) addUnit(type, plan, suspended)
  }
  for (const it of pgItems) {
    const pg = (it && typeof it === 'object' && 'postgres' in (it as object))
      ? (it as { postgres: RenderPostgres }).postgres
      : (it as RenderPostgres)
    const suspended = !!pg?.suspended && pg.suspended !== 'not_suspended'
    addUnit('postgres', String(pg?.plan || ''), suspended)
  }

  const unpriced = [...unpricedMap.values()]
  if (staticCount > 0) flags.push(`${staticCount} static_site: bandwidth overage not counted (0 Ft)`)
  if (missingInstances > 0) flags.push(`${missingInstances} service(s): instance count missing -> counted as 1`)
  if (unpriced.length > 0) flags.push(`${unpriced.reduce((s, u) => s + u.count, 0)} service(s): unknown/unpriced plan -> excluded from total`)
  if (pgItems.length === 0) flags.push('no postgres resources seen (if you have DBs, add /v1/postgres pricing)')
  if (fx <= 0) flags.push('fx_usd_huf missing/zero -> HUF total is 0; set it in the pricing config')

  const total_huf = Math.round(total_usd * fx * 100) / 100
  const monthKey = new Date(opts.periodStart * 1000).toISOString().slice(0, 7)

  const breakdown: RenderBreakdown = {
    service_count: count, by_type_plan, unpriced, undercount_flags: flags,
    suspended_count, total_usd: Math.round(total_usd * 100) / 100, total_huf, fx_usd_huf: fx,
  }

  // No line if there is literally nothing priced (keeps the ledger clean); the
  // breakdown still carries flags for the report.
  const lines: NormalizedCostLine[] = total_huf > 0 ? [{
    provider: 'render',
    service: RENDER_SOURCE,
    billing_period_start: opts.periodStart,
    billing_period_end: opts.periodEnd,
    amount: total_huf,
    currency: 'HUF',
    confidence: 'provider_plan_estimate',
    usage_type: 'plan_estimate',
    quantity: count,
    unit: 'service',
    data_freshness_at: opts.now,
    raw_ref_hash: hashRef(opts.idSalt, `render-plan|${monthKey}`),
    dedup_key: `provider|render|${RENDER_SOURCE}|${monthKey}|provider_plan_estimate`,
  }] : []

  return { lines, breakdown }
}

// v0.5: read the Render API key WITHOUT logging it. process.env first, then the
// gitignored root .env. Returns null if absent (caller reports a config error).
export function getRenderApiKey(): string | null {
  const fromEnv = process.env.RENDER_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const envFile = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8')
    const line = envFile.split('\n').find(l => l.startsWith('RENDER_API_KEY'))
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  } catch { /* no .env */ }
  return null
}

export interface RenderSyncResult {
  ok: boolean
  provider: 'render'
  status: string
  imported_count: number
  error?: string
  service_count?: number
  total_huf?: number
  period?: string
}

/**
 * v0.5 sync spine: run the Render collector LIVE (read-only GET) and idempotently
 * import the aggregated provider_plan_estimate line for the current month, storing
 * a sanitized breakdown on the import_runs row. NO provider-side write. Injected
 * httpGetJson defaults to a real GET fetcher; tests pass a stub.
 */
export async function syncRenderCollector(
  db: import('better-sqlite3').Database,
  now: number,
  deps: { httpGetJson?: import('./types.js').HttpGetJson; apiKey?: string | null } = {},
): Promise<RenderSyncResult> {
  const { runCollector } = await import('./runner.js')
  const { monthWindow } = await import('../ledger.js')
  const { pricing } = loadRenderPricing()
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : getRenderApiKey()
  if (!apiKey) return { ok: false, provider: 'render', status: 'error', imported_count: 0, error: 'no RENDER_API_KEY configured' }
  const httpGetJson = deps.httpGetJson || (async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { method: 'GET', headers })
    if (!r.ok) throw new Error(`render api ${r.status}`)
    return r.json()
  })
  const w = monthWindow(now)
  const collector = makeRenderCollector(pricing)
  const opts = { periodStart: w.start, periodEnd: w.end, secret: apiKey, fxUsdHuf: pricing.fx_usd_huf, idSalt: 'render-salt', httpGetJson }
  // pre-compute the sanitized breakdown for the run detail (no raw IDs)
  let detail: RenderBreakdown | null = null
  try {
    const { raw } = await collector.collectRaw!(opts)
    detail = mapRenderPlanCost(raw, { periodStart: w.start, periodEnd: w.end, pricing, idSalt: 'render-salt', now }).breakdown
  } catch { /* runCollector will re-run + record the sanitized error */ }
  const res = await runCollector({ db, collector, opts, now, detailJson: detail ? JSON.stringify(detail) : undefined })
  return {
    ok: res.status === 'ok', provider: 'render', status: res.status, imported_count: res.importedCount,
    error: res.errorMessageSanitized || undefined,
    service_count: detail?.service_count, total_huf: detail?.total_huf, period: w.key,
  }
}

/** Build the Render collector bound to a loaded pricing config. READ-ONLY. */
export function makeRenderCollector(pricing: RenderPricing): ProviderCollector {
  return {
    provider: 'render',
    collectorName: 'render-plan-report',
    async collectRaw(opts: CollectOpts): Promise<{ raw: unknown; lines: NormalizedCostLine[] }> {
      // secret used ONLY as the auth header; never logged.
      const headers = { authorization: `Bearer ${opts.secret}`, accept: 'application/json' }
      const services = await opts.httpGetJson(RENDER_SERVICES_URL, headers)
      let postgres: unknown = []
      try { postgres = await opts.httpGetJson(RENDER_POSTGRES_URL, headers) } catch { postgres = [] }
      const raw = { services, postgres }
      const { lines } = mapRenderPlanCost(raw, {
        periodStart: opts.periodStart, periodEnd: opts.periodEnd,
        pricing, idSalt: opts.idSalt, now: opts.periodStart,
      })
      return { raw, lines }
    },
    async collect(opts: CollectOpts): Promise<NormalizedCostLine[]> {
      return (await this.collectRaw!(opts)).lines
    },
  }
}
