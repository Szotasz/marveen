// CostOps v0.7 -- deterministic warnings.
//
// Pure derivation from an already-computed CostSummary + subscription
// lifecycle + a direct read-only query for pending_permission sources. No
// LLM, no network, no new writes. Every rule is a plain threshold check --
// same warning inputs always produce the same warnings array.

import type Database from 'better-sqlite3'
import type { CostOpsConfig } from './config.js'
import type { CostSummary } from './ledger.js'
import { monthWindow } from './ledger.js'
import type { SubscriptionLifecycle } from './subscriptions.js'
import type { LimitStatus } from './limits.js'

// v0.8 (card 6f4d1332 §6): widened from 'low'|'medium'|'high' to add 'critical'|'blocked' for
// the new generic tiered limit rule (§4 of the requirements is explicit that an 80%+ limit MUST
// alert, and a plain 3-tier scale can't distinguish "at 90%, urgent" from "at 100%, actually
// blocked"). Plain TS union, no DB CHECK constraint -- safe additive change, every existing
// warning (all still 'low'|'medium'|'high') keeps working unmodified.
export type WarningSeverity = 'low' | 'medium' | 'high' | 'critical' | 'blocked'

// v0.7/v2 typed extension (card bea78483). Additive on top of the original
// {code,severity,provider,message,detail} shape -- every existing rule keeps
// working, these fields are populated wherever meaningful and left undefined
// otherwise (never fabricated, e.g. a warning with no natural threshold has
// no `threshold` field rather than a made-up one).
export type WarningType = 'cost' | 'quota' | 'expiry' | 'access'
export type WarningConfidence = 'measured' | 'estimated' | 'manual' | 'no_api_or_no_access'

export interface CostWarning {
  code: string
  severity: WarningSeverity
  provider: string
  message: string
  detail?: unknown
  warning_type: WarningType
  category: string       // 'hosting' | 'ai' | 'productivity' | 'domains' | 'budget' | 'other'
  action?: string         // human next-step suggestion
  threshold?: number
  current_value?: number
  unit?: string           // '%' | 'day' | 'HUF' | ...
  due_date?: string       // ISO date -- expected charge/renewal
  reset_date?: string     // ISO date/datetime -- quota reset
  expiry_date?: string    // ISO date -- cert/domain expiry
  source: string          // 'ledger' | 'config' | 'render_api' | 'workspace_alert' | 'tls' | 'rdap'
  confidence: WarningConfidence
}

// Card bea78483's UI drill-down mapping: Render->hosting, Claude/DeepSeek/Google
// AI->ai, Google Workspace->productivity, Domain/SSL->domains. Shared by every
// rule so old and new warnings categorize consistently.
export function categoryForProvider(provider: string): string {
  const p = provider.toLowerCase()
  if (p === 'render' || p === 'vercel' || p === 'cloudflare') return 'hosting'
  if (p === 'anthropic' || p === 'openai' || p === 'deepseek' || p === 'google-ai') return 'ai'
  if (p === 'google-workspace' || p === 'workspace') return 'productivity'
  if (p === 'domain' || p === 'ssl' || p === 'dns') return 'domains'
  if (p === 'all') return 'budget'
  return 'other'
}

// A provider/source change or manual-fallback share below this fraction of
// operational spend is noise, not a warning -- keeps the list actionable.
const MATERIAL_FRACTION = 0.15

// v0.8 (card 6f4d1332 §6): threshold ladder for the generic tiered limit rule, mapping
// LimitStatus.usage_pct (fraction consumed) to a warning severity. 80%+ is mandatory per
// requirements §4; the medium tier is added for earlier visibility, not requirements-mandated.
const LIMIT_TIERS: Array<[number, WarningSeverity]> = [
  [1.0, 'blocked'], [0.9, 'critical'], [0.8, 'high'], [0.7, 'medium'],
]

export function getWarnings(
  db: Database.Database,
  _config: CostOpsConfig,
  now: number,
  summary: CostSummary,
  subscriptions: SubscriptionLifecycle[],
  // v0.8 (card 6f4d1332 §6): optional so every existing call site keeps compiling/behaving
  // identically without passing it -- omitted, the new tiered-limit rule below is simply skipped
  // (no fabricated data), same "degrade gracefully" convention as configExists/pricingExists.
  limits: LimitStatus[] = [],
): CostWarning[] {
  const warnings: CostWarning[] = []

  // 1. forecast vs budget -- reuse the already-computed budget.status (operational-based).
  if (summary.budget && summary.budget.status !== 'ok') {
    warnings.push({
      code: 'forecast_over_budget',
      severity: summary.budget.status === 'hard' ? 'high' : 'medium',
      provider: 'all',
      message: summary.budget.status === 'hard'
        ? `Havi büdzsé túllépve vagy azon: ${Math.round(summary.budget.operational_used_pct * 100)}% elköltve.`
        : `Előrejelzés a büdzsé ${Math.round(summary.budget.operational_forecast_pct * 100)}%-át éri el hónap végére.`,
      detail: { used_pct: summary.budget.operational_used_pct, forecast_pct: summary.budget.operational_forecast_pct, threshold: summary.budget.warning_threshold },
      warning_type: 'cost', category: 'budget', source: 'ledger', confidence: 'measured',
      threshold: Math.round(summary.budget.warning_threshold * 100), current_value: Math.round(summary.budget.operational_used_pct * 100), unit: '%',
      action: summary.budget.status === 'hard' ? 'Csökkentsd a költést vagy emeld a büdzsét.' : 'Kövesd a hónap hátralévő részét, közel a limithez.',
    })
  }

  // 2. provider sync stale / failed.
  for (const p of summary.provider_sync) {
    if (p.status === 'failed') {
      warnings.push({
        code: 'provider_sync_failed', severity: 'medium', provider: p.provider,
        message: `${p.provider} szinkron sikertelen (${p.error_code ?? 'ismeretlen hiba'}).`,
        detail: { last_success: p.last_success, error_code: p.error_code },
        warning_type: 'access', category: categoryForProvider(p.provider), source: 'ledger', confidence: 'measured',
        action: 'Ellenőrizd a szolgáltató API-kulcsát/jogosultságát.',
      })
    } else if (p.stale) {
      warnings.push({
        code: 'provider_sync_stale', severity: 'low', provider: p.provider,
        message: `${p.provider} adat elavult (${Math.round((p.data_age_secs ?? 0) / 86400)} napja nem szinkronizált).`,
        detail: { data_age_secs: p.data_age_secs, last_sync: p.last_sync },
        warning_type: 'access', category: categoryForProvider(p.provider), source: 'ledger', confidence: 'measured',
        current_value: Math.round((p.data_age_secs ?? 0) / 86400), unit: 'day',
      })
    }
  }

  // 3. expected invoice missing -- a subscription past its next charge date with no update.
  for (const s of subscriptions) {
    if (s.past_due) {
      warnings.push({
        code: 'expected_invoice_missing', severity: 'medium', provider: s.provider,
        message: `${s.name}: várt számla/díjterhelés (${s.next_renewal}) elmúlt, nincs friss adat.`,
        detail: { subscription_id: s.id, next_renewal: s.next_renewal, days_overdue: s.days_until_next_date !== null ? -s.days_until_next_date : null },
        warning_type: 'expiry', category: categoryForProvider(s.provider), source: 'config', confidence: 'manual',
        due_date: s.next_renewal, current_value: s.days_until_next_date !== null ? -s.days_until_next_date : undefined, unit: 'day',
      })
    }
  }

  // 4. high-cost provider still on manual fallback (material share of operational spend).
  const totalOp = summary.operational_spend || 0
  if (totalOp > 0) {
    for (const src of summary.all_sources) {
      // v0.8: spend is null for a pending_permission source (never a fabricated 0) -- excluded
      // here by construction (its confidence is 'pending_permission', not manual/estimate), but
      // the null check makes that explicit for the type checker too.
      const isFallback = src.spend != null && (src.confidence === 'manual' || src.confidence === 'estimate')
      if (isFallback && src.spend! / totalOp >= MATERIAL_FRACTION) {
        warnings.push({
          code: 'high_cost_manual_fallback', severity: 'low', provider: src.provider,
          message: `${src.name}: a költség jelentős hányada (${Math.round((src.spend! / totalOp) * 100)}%) kézi/becsült adaton alapul, nincs valódi számla/API forrás.`,
          detail: { source_id: src.source_id, spend: src.spend, share: Math.round((src.spend! / totalOp) * 100) / 100 },
          warning_type: 'cost', category: categoryForProvider(src.provider), source: 'ledger', confidence: 'estimated',
          current_value: Math.round((src.spend! / totalOp) * 100), threshold: Math.round(MATERIAL_FRACTION * 100), unit: '%',
        })
      }
    }
  }

  // 5. plan estimate materially differs from actual/manual (Render render_plan block).
  if (summary.render_plan) {
    const base = summary.render_plan.manual_estimate || summary.render_plan.plan_estimate_total || 1
    if (Math.abs(summary.render_plan.variance) / base >= MATERIAL_FRACTION) {
      warnings.push({
        code: 'plan_estimate_variance', severity: 'low', provider: 'render',
        message: `Render terv-alapú becslés (${summary.render_plan.plan_estimate_total}) jelentősen eltér a kézi becsléstől (${summary.render_plan.manual_estimate}).`,
        detail: { plan_estimate_total: summary.render_plan.plan_estimate_total, manual_estimate: summary.render_plan.manual_estimate, variance: summary.render_plan.variance },
        warning_type: 'cost', category: 'hosting', source: 'ledger', confidence: 'estimated',
        current_value: summary.render_plan.plan_estimate_total, unit: summary.render_plan.currency,
      })
    }
  }

  // 6. invoice amount materially changed vs previous month, per provider.
  if (summary.previous_month) {
    const prevByProvider = new Map(summary.previous_month.by_provider.map(p => [p.provider, p.spend]))
    for (const cur of summary.operational.provider_breakdown) {
      const prev = prevByProvider.get(cur.provider)
      if (prev !== undefined && prev > 0 && Math.abs(cur.spend - prev) / prev >= MATERIAL_FRACTION) {
        warnings.push({
          code: 'invoice_amount_changed', severity: 'low', provider: cur.provider,
          message: `${cur.provider}: ${prev} -> ${cur.spend} (${Math.round(((cur.spend - prev) / prev) * 100)}% változás az előző hónaphoz képest).`,
          detail: { previous: prev, current: cur.spend },
          warning_type: 'cost', category: categoryForProvider(cur.provider), source: 'ledger', confidence: 'measured',
          current_value: cur.spend, unit: summary.currency,
        })
      }
    }
  }

  // 6b. v0.8 (card 6f4d1332 §6.3): large INCREASE vs previous month, per provider -- distinct
  // from rule 6 above (any material CHANGE, either direction, 15% threshold, low severity,
  // informational). This is one-directional (increase only) with a higher, more urgent
  // threshold. 50% is a recommendation, not business-specified (flagged, same treatment as the
  // Eskuvő bundle-discount placeholder earlier this session) -- tune once real data exists.
  const LARGE_INCREASE_FRACTION = 0.5
  if (summary.previous_month) {
    const prevByProvider = new Map(summary.previous_month.by_provider.map(p => [p.provider, p.spend]))
    for (const cur of summary.operational.provider_breakdown) {
      const prev = prevByProvider.get(cur.provider)
      if (prev !== undefined && prev > 0 && (cur.spend - prev) / prev >= LARGE_INCREASE_FRACTION) {
        warnings.push({
          code: 'large_increase_vs_previous_month', severity: 'medium', provider: cur.provider,
          message: `${cur.provider}: jelentős növekedés az előző hónaphoz képest (${prev} -> ${cur.spend}, +${Math.round(((cur.spend - prev) / prev) * 100)}%).`,
          detail: { previous: prev, current: cur.spend, threshold_fraction: LARGE_INCREASE_FRACTION },
          warning_type: 'cost', category: categoryForProvider(cur.provider), source: 'ledger', confidence: 'measured',
          current_value: cur.spend, threshold: Math.round(LARGE_INCREASE_FRACTION * 100), unit: '%',
          action: 'Nézd meg, mi okozta a növekedést -- új szolgáltatás, plan-váltás, vagy anomália.',
        })
      }
    }
  }

  // 7. billing_access_needed -- a tracked provider whose cost cannot currently be read
  // (v0.7 AWS addendum: confidence='pending_permission', never fabricated as 0/manual).
  const win = monthWindow(now, summary.month)
  const pendingRows = db.prepare(`
    SELECT DISTINCT cs.id as source_id, cs.name, cs.provider
    FROM cost_line_items cli JOIN cost_sources cs ON cs.id = cli.source_id
    WHERE cli.confidence = 'pending_permission'
      AND cli.charge_period_start < @end AND cli.charge_period_end > @start AND cli.voided_at IS NULL
  `).all({ start: win.start, end: win.end }) as Array<{ source_id: string; name: string; provider: string }>
  for (const p of pendingRows) {
    warnings.push({
      code: 'billing_access_needed', severity: 'medium', provider: p.provider,
      message: `${p.name}: a valós költség nem olvasható ki (hiányzó jogosultság a szolgáltató számlázási API-jához). Nincs kitalált összeg.`,
      detail: { source_id: p.source_id },
      warning_type: 'access', category: categoryForProvider(p.provider), source: 'config', confidence: 'no_api_or_no_access',
      action: 'Adj IAM/API jogosultságot a számlázási adathoz, vagy add meg kézzel az összeget.',
    })
  }

  // 8. Render spend-limit -- Render has no public billing API (verified live,
  // see render-no-public-billing-api). Always pending, never fabricated;
  // low-severity so it sits in the drill-down, not the top actionable list.
  warnings.push({
    code: 'render_spend_limit_unknown', severity: 'low', provider: 'render',
    message: 'Render költési limit nem lekérdezhető (nincs publikus billing API).',
    warning_type: 'quota', category: 'hosting', source: 'config', confidence: 'no_api_or_no_access',
    action: 'Kövesd kézzel a Render dashboardon (Settings -> Billing).',
  })

  // 9. Claude Max weekly limit -- no official usage API; only manually visible
  // (agent tmux panes show a rolling %/reset time). Always pending.
  warnings.push({
    code: 'claude_max_weekly_limit_unknown', severity: 'low', provider: 'anthropic',
    message: 'Claude Max heti limit nem lekérdezhető API-n -- az ágens paneleken (X% / HH:mm reset) manuálisan látható.',
    warning_type: 'quota', category: 'ai', source: 'config', confidence: 'no_api_or_no_access',
  })

  // 10. DeepSeek prepaid balance -- the collector's balance endpoint DOES exist
  // (live, read-only). % remaining is derived vs the highest balance snapshot
  // seen (a proxy for the last top-up). Gap-fill (card 65da75e6): unlike a
  // healthy SSL cert (silent is fine, nobody needs a "cert is fine" entry),
  // the balance NUMBER itself is always relevant for a quota gauge -- so this
  // ALWAYS emits one entry when a snapshot exists (never silent), escalating
  // severity only when the %-vs-peak is genuinely low. Never a fabricated
  // absolute limit -- when there's no observed drop yet (peak === latest, e.g.
  // right after a top-up or only one snapshot ever), the % isn't meaningful,
  // so the raw balance is shown instead with confidence:'manual'.
  const dsRows = db.prepare(`SELECT balance, currency, captured_at FROM provider_balance_snapshots WHERE provider = 'deepseek' ORDER BY captured_at DESC`).all() as Array<{ balance: number; currency: string; captured_at: number }>
  if (dsRows.length === 0) {
    warnings.push({
      code: 'deepseek_balance_unknown', severity: 'low', provider: 'deepseek',
      message: 'DeepSeek egyenleg még nincs rögzítve (nincs korábbi snapshot az arány kiszámításához).',
      warning_type: 'quota', category: 'ai', source: 'config', confidence: 'no_api_or_no_access',
    })
  } else {
    const latest = dsRows[0].balance
    const currency = dsRows[0].currency
    const peak = Math.max(...dsRows.map(r => r.balance))
    const hadObservedDrop = peak > latest // a real drop was seen -- % vs peak is meaningful
    const pct = hadObservedDrop ? Math.round((latest / peak) * 10000) / 100 : null
    // v0.8 (card 6f4d1332 §6.1): the ad-hoc, inverted-logic (%-remaining) severity escalation
    // that used to live here (deepseek_balance_low, 3 hardcoded tiers) is now owned by the
    // generic tiered limit rule below, fed by limits.ts's normalized usage_pct (fraction
    // CONSUMED -- the correctly-oriented inverse of this rule's %-remaining framing) for this
    // exact same balance. This entry stays what spec A1 actually needs: a plain, ALWAYS-shown
    // informational gauge (never silent, never severity-escalating on its own).
    warnings.push({
      code: 'deepseek_balance_info', severity: 'low', provider: 'deepseek',
      message: `DeepSeek előre fizetett egyenleg: ${latest} ${currency}${pct !== null ? ` (${pct}% a legutóbbi feltöltéshez képest)` : ''}.`,
      detail: { latest_balance: latest, peak_balance: peak, currency },
      warning_type: 'quota', category: 'ai', source: 'ledger', confidence: hadObservedDrop ? 'estimated' : 'manual',
      current_value: latest, unit: currency,
    })
  }

  // 11. v0.8 §6.1: generic tiered limit alert -- ANY normalized limit (§6.2's limits.ts pass)
  // crossing 70/80/90/100% usage gets ONE consistent escalation, replacing the DeepSeek-only
  // ad-hoc tiering removed above. 'balance' (DeepSeek) is intentionally included -- it no longer
  // has its own escalation. 'build_minutes' (Render) is intentionally excluded: that source can
  // only ever report a binary blocked/not-blocked (no API for intermediate tiers, see
  // render-live-checks.ts), already fully covered by its own dedicated
  // render_build_minutes_exhausted warning -- adding this generic rule on top would just
  // duplicate the exact same fact under a second code.
  for (const l of limits) {
    if (l.usage_pct === null || l.limit_type === 'build_minutes') continue
    const tier = LIMIT_TIERS.find(([t]) => l.usage_pct! >= t)
    if (!tier) continue
    const [threshold, severity] = tier
    warnings.push({
      code: 'limit_usage_high', severity, provider: l.provider,
      message: `${l.provider} (${l.limit_type}): ${Math.round(l.usage_pct! * 100)}% felhasználva.`,
      detail: { limit_type: l.limit_type, current_usage: l.current_usage, limit_value: l.limit_value, source: l.source },
      warning_type: 'quota', category: categoryForProvider(l.provider), source: 'ledger', confidence: 'estimated',
      current_value: Math.round(l.usage_pct! * 100), threshold: Math.round(threshold * 100), unit: '%',
      action: severity === 'blocked' ? 'A limit elérve -- azonnali beavatkozás szükséges.' : 'Kövesd a felhasználást, közelít a limithez.',
    })
  }

  return warnings
}
