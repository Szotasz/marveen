// CostOps v0.8 -- limits/quota normalization (card 6f4d1332 §6.2).
//
// Genuinely additive glue code: reads 4 already-existing raw sources (subscription lifecycle,
// DeepSeek balance snapshots, Workspace alerts, Render build-minutes + SSL/domain expiry) and
// normalizes them into ONE shape so warnings.ts's tiered limit rule (§6) can apply uniformly.
// No new storage. usage_pct is ALWAYS "fraction of the limit consumed" (0 = nothing used, 1 =
// fully consumed) across every limit_type, so a single threshold ladder works for all of them.
// Honest gaps stay honest: no numeric ceiling exists for Claude Max/ChatGPT/Render build-minutes
// (confirmed against costops-subscriptions.json's schema and Render's events API) -- those
// render usage_pct: null, status: 'unknown', never an invented percentage.

import type Database from 'better-sqlite3'
import type { SubscriptionLifecycle } from './subscriptions.js'
import { getActiveWorkspaceAlerts } from './workspace-alerts.js'
import { checkRenderBuildMinutes } from './render-live-checks.js'
import { loadDomainsConfig, checkSslExpiry, checkDomainExpiry, EXPIRY_THRESHOLDS } from './expiry-checks.js'
import type { CostWarning } from './warnings.js'

export type LimitStatusTier = 'ok' | 'warning' | 'critical' | 'blocked' | 'unknown'

export interface LimitStatus {
  provider: string
  limit_type: string
  current_usage: number | null
  limit_value: number | null
  usage_pct: number | null       // 0..1, fraction CONSUMED (never a %-remaining inversion)
  reset_date: string | null
  paid_until: string | null
  expiry_date: string | null
  status: LimitStatusTier
  source: string                 // 'config' | 'ledger' | 'render_api' | 'workspace_alert' | 'tls' | 'rdap'
  // Card 2ed90db1: which costops-subscriptions.json entry this came from, when applicable
  // (null for every non-subscription source). Multiple subscriptions can share the same
  // `provider` (e.g. Claude Max + Claude Pro are both 'anthropic') -- provider alone can't
  // disambiguate which subscription a row belongs to, sub_id can.
  sub_id: string | null
  // Card 7d086cd3 (F4, Muse WS-C design-fidelity): current_usage/limit_value carry NO unit info
  // on their own -- every limit_type here except DeepSeek's balance leaves both null (a day-count,
  // a token-count, or genuinely unknown), so the renderer's HUF-formatter silently stamping "Ft"
  // onto whatever number showed up went unnoticed until a real dollar-denominated value (DeepSeek's
  // native USD prepaid balance) hit it and printed "3,17 HUF" for a ~$3.17 USD balance. null means
  // "not a monetary value, or currency genuinely unknown" -- never assume HUF by omission.
  unit: string | null
}

function tierForPct(pct: number | null): LimitStatusTier {
  if (pct === null) return 'unknown'
  if (pct >= 1.0) return 'blocked'
  if (pct >= 0.9) return 'critical'
  if (pct >= 0.7) return 'warning'
  return 'ok'
}

function tierForDays(days: number | null): LimitStatusTier {
  if (days === null) return 'unknown'
  if (days < 0) return 'blocked'
  if (days <= EXPIRY_THRESHOLDS.critical) return 'critical'
  if (days <= EXPIRY_THRESHOLDS.warn) return 'warning'
  return 'ok'
}

// ---- 1. Subscription lifecycle (renewal/cancellation dates -- date-based, not %-based unless
// an optional weekly_limit_tokens/five_hour_limit_tokens ceiling is present, see SubscriptionEntry) ---
export function fromSubscriptions(subs: SubscriptionLifecycle[]): LimitStatus[] {
  const out: LimitStatus[] = []
  for (const s of subs) {
    const targetDate = s.status === 'canceled' ? s.paid_until : s.next_renewal
    // No early-continue here: a subscription can have a usage_snapshot (below) with no known
    // renewal/cancellation date at all (e.g. Claude Pro after re-activation -- status flipped to
    // active but no next_renewal was supplied, never fabricated) -- that must still emit its
    // weekly-usage entry even though it has no renewal-date entry to emit.
    if (targetDate) {
      out.push({
        provider: s.provider, limit_type: 'subscription_renewal',
        current_usage: null, limit_value: null, usage_pct: null,
        reset_date: s.status === 'active' ? s.next_renewal ?? null : null,
        paid_until: s.status === 'canceled' ? s.paid_until ?? null : null,
        expiry_date: null,
        status: s.past_due ? 'blocked' : tierForDays(s.days_until_next_date),
        source: 'config', sub_id: s.id, unit: null,
      })
    }
    // Optional token ceiling (v0.8): only emitted when the operator has actually supplied one --
    // never a fabricated limit_value. Current usage cross-referencing against token_usage by
    // agent is future work (no agent<->subscription mapping exists yet) -- honestly unknown
    // for now, matching the spec's "recommend, don't build speculatively" instruction.
    if (s.weekly_limit_tokens || s.five_hour_limit_tokens) {
      out.push({
        provider: s.provider, limit_type: s.weekly_limit_tokens ? 'weekly_tokens' : 'five_hour_tokens',
        current_usage: null, limit_value: s.weekly_limit_tokens ?? s.five_hour_limit_tokens ?? null,
        usage_pct: null, reset_date: null, paid_until: null, expiry_date: null,
        status: 'unknown', source: 'config', sub_id: s.id, unit: null,
      })
    }
    // Card 2ed90db1: manual weekly-usage-% snapshot (Claude Max/Pro's actual usage screen has
    // no absolute token ceiling, percent + reset label is the real data). weekly_pct is what
    // drives the 80% alert (warnings.ts rule 11, generic tiered limit) -- session_pct/fable_pct
    // are informational-only (surfaced via the subscription object itself, not alerted on,
    // since only weekly usage was asked to trigger the alert).
    if (s.usage_snapshot) {
      const pct = s.usage_snapshot.weekly_pct / 100
      out.push({
        provider: s.provider, limit_type: 'weekly_usage_pct',
        current_usage: null, limit_value: null, usage_pct: pct,
        reset_date: s.usage_snapshot.weekly_reset_label, paid_until: null, expiry_date: null,
        status: tierForPct(pct), source: 'config', sub_id: s.id, unit: null,
      })
    }
  }
  return out
}

// ---- 2. DeepSeek prepaid balance (same data/logic already in warnings.ts rule 10, normalized) ---
export function fromDeepSeekBalance(db: Database.Database): LimitStatus[] {
  const rows = db.prepare(
    `SELECT balance, currency, captured_at FROM provider_balance_snapshots WHERE provider = 'deepseek' ORDER BY captured_at DESC`,
  ).all() as Array<{ balance: number; currency: string; captured_at: number }>
  if (rows.length === 0) {
    return [{
      provider: 'deepseek', limit_type: 'balance', current_usage: null, limit_value: null,
      usage_pct: null, reset_date: null, paid_until: null, expiry_date: null,
      status: 'unknown', source: 'ledger', sub_id: null, unit: null,
    }]
  }
  const latest = rows[0].balance
  const peak = Math.max(...rows.map(r => r.balance))
  const hadObservedDrop = peak > latest
  // usage_pct here means fraction of the peak (last top-up) already SPENT -- consistent with
  // every other limit_type's "fraction consumed" convention (inverse of warnings.ts's own
  // "% remaining vs peak" framing, which is display-oriented, not a consumed-fraction).
  const usage_pct = hadObservedDrop ? Math.round((1 - latest / peak) * 10000) / 10000 : null
  return [{
    provider: 'deepseek', limit_type: 'balance', current_usage: latest, limit_value: peak,
    usage_pct, reset_date: null, paid_until: null, expiry_date: null,
    // Card 7d086cd3 (F4): this is a raw prepaid balance, native currency -- always USD for
    // DeepSeek today (the snapshot row itself carries it, not assumed), never HUF-converted here.
    status: tierForPct(usage_pct), source: 'ledger', sub_id: null, unit: rows[0].currency,
  }]
}

// ---- 2b. Codex / ChatGPT Plus weekly rate-limit (metadata snapshot -> normalized) ----------
// Latest usedPercent snapshot from provider_ratelimit_snapshots (written by the codex collector
// via the app-server metadata read -- zero quota). No snapshot yet -> 'unknown' (never a guess),
// same honest-gap rule as the no-numeric-ceiling subscription limits.
export function fromCodexRateLimit(db: Database.Database): LimitStatus[] {
  const rows = db.prepare(
    `SELECT used_percent, resets_at, captured_at FROM provider_ratelimit_snapshots WHERE provider = 'codex' ORDER BY captured_at DESC LIMIT 1`,
  ).all() as Array<{ used_percent: number; resets_at: number | null; captured_at: number }>
  if (rows.length === 0) {
    return [{
      provider: 'codex', limit_type: 'weekly_usage_pct', current_usage: null, limit_value: null,
      usage_pct: null, reset_date: null, paid_until: null, expiry_date: null,
      status: 'unknown', source: 'ledger', sub_id: null, unit: null,
    }]
  }
  const latest = rows[0]
  const pct = latest.used_percent / 100
  return [{
    provider: 'codex', limit_type: 'weekly_usage_pct', current_usage: latest.used_percent, limit_value: 100,
    usage_pct: pct,
    reset_date: latest.resets_at !== null ? new Date(latest.resets_at * 1000).toISOString() : null,
    paid_until: null, expiry_date: null,
    status: tierForPct(pct), source: 'ledger', sub_id: null, unit: '%',
  }]
}

// ---- 3. Workspace payment/suspension alerts -----------------------------------------------
function fromWorkspaceAlerts(db: Database.Database, now: number): LimitStatus[] {
  const rows = getActiveWorkspaceAlerts(db, now)
  const seen = new Set<string>()
  const out: LimitStatus[] = []
  for (const r of rows) {
    const key = `${r.account}|${r.issue_type}`
    if (seen.has(key)) continue
    seen.add(key)
    const daysRemaining = r.suspension_date !== null ? Math.floor((r.suspension_date - now) / 86400) : null
    out.push({
      provider: 'google-workspace', limit_type: 'workspace_payment',
      current_usage: null, limit_value: null, usage_pct: null,
      reset_date: null, paid_until: null,
      expiry_date: r.suspension_date !== null ? new Date(r.suspension_date * 1000).toISOString().slice(0, 10) : null,
      status: r.issue_type === 'suspended' ? 'blocked' : tierForDays(daysRemaining) === 'unknown' ? 'warning' : tierForDays(daysRemaining),
      source: 'workspace_alert', sub_id: null, unit: null,
    })
  }
  return out
}

// ---- 4. Render build-minutes + SSL/domain expiry (live network checks -> normalized) --------
//
// Card fa041036: /api/costs/warnings was independently re-running these exact same 3 live checks
// a second time (sequentially, no less) right after calling getLimitStatus() -- which already ran
// them once, concurrently, via this function. That double-fetch (one concurrent + one sequential,
// same request) was the real cost behind the reported 20-35s, not the DB-side ledger reads (those
// are narrow, indexed sqlite queries -- checked, not the bottleneck). Fix: cache the raw 3-way
// result for LIVE_CHECKS_TTL_MS and share it between both routes, so within the TTL window a
// second caller (same request or the next dashboard poll) gets the already-fetched result instead
// of re-hitting Render's API for every service + a TLS handshake per host + an RDAP lookup.
const LIVE_CHECKS_TTL_MS = 5 * 60 * 1000
interface LiveChecksResult { renderWarnings: CostWarning[]; sslWarnings: CostWarning[]; domainWarnings: CostWarning[] }
let liveChecksCache: { key: string; at: number; promise: Promise<LiveChecksResult> } | null = null

export async function getLiveCheckWarnings(now: number, sslHosts: string[], domains: string[]): Promise<LiveChecksResult> {
  const key = JSON.stringify([sslHosts, domains])
  const nowMs = now * 1000
  if (liveChecksCache && liveChecksCache.key === key && (nowMs - liveChecksCache.at) < LIVE_CHECKS_TTL_MS) {
    return liveChecksCache.promise
  }
  const promise = Promise.all([
    checkRenderBuildMinutes(now),
    checkSslExpiry(sslHosts, now),
    checkDomainExpiry(domains, now),
  ]).then(([renderWarnings, sslWarnings, domainWarnings]) => ({ renderWarnings, sslWarnings, domainWarnings }))
  liveChecksCache = { key, at: nowMs, promise }
  // A failed round shouldn't poison the cache for the rest of the TTL window -- clear it so the
  // next call retries live instead of returning a stuck rejection for up to 5 minutes.
  promise.catch(() => { if (liveChecksCache?.promise === promise) liveChecksCache = null })
  return promise
}

async function fromLiveChecks(now: number, sslHosts: string[], domains: string[]): Promise<LimitStatus[]> {
  const out: LimitStatus[] = []
  const { renderWarnings, sslWarnings, domainWarnings } = await getLiveCheckWarnings(now, sslHosts, domains)
  for (const w of renderWarnings) {
    if (w.code !== 'render_build_minutes_exhausted') continue // access-failure warnings aren't a limit signal
    out.push({
      provider: 'render', limit_type: 'build_minutes', current_usage: null, limit_value: null,
      usage_pct: 1.0, reset_date: null, paid_until: null, expiry_date: null,
      status: 'blocked', source: 'render_api', sub_id: null, unit: null,
    })
  }
  for (const w of sslWarnings) {
    out.push({
      provider: String(w.provider || 'ssl'), limit_type: 'ssl_expiry',
      current_usage: w.current_value ?? null, limit_value: w.threshold ?? null, usage_pct: null,
      reset_date: null, paid_until: null, expiry_date: w.expiry_date ?? w.due_date ?? null,
      status: w.severity === 'high' ? 'critical' : w.severity === 'medium' ? 'warning' : 'warning',
      source: 'tls', sub_id: null, unit: null,
    })
  }
  for (const w of domainWarnings) {
    out.push({
      provider: String(w.provider || 'domain'), limit_type: 'domain_expiry',
      current_usage: w.current_value ?? null, limit_value: w.threshold ?? null, usage_pct: null,
      reset_date: null, paid_until: null, expiry_date: w.expiry_date ?? w.due_date ?? null,
      status: w.severity === 'high' ? 'critical' : w.severity === 'medium' ? 'warning' : 'warning',
      source: 'rdap', sub_id: null, unit: null,
    })
  }
  return out
}

/**
 * Normalize every known limit/quota signal into one shape. Never fabricates a percentage --
 * a source with no real ceiling data (Claude Max weekly, ChatGPT, Render build-minutes below
 * 100%) reports usage_pct: null, status: 'unknown' rather than a guess.
 */
export async function getLimitStatus(
  db: Database.Database,
  now: number,
  subscriptions: SubscriptionLifecycle[],
): Promise<LimitStatus[]> {
  const { config: domainsConfig } = loadDomainsConfig()
  const [live] = await Promise.all([
    fromLiveChecks(now, domainsConfig.ssl_hosts, domainsConfig.domains),
  ])
  return [
    ...fromSubscriptions(subscriptions),
    ...fromDeepSeekBalance(db),
    ...fromCodexRateLimit(db),
    ...fromWorkspaceAlerts(db, now),
    ...live,
  ]
}
