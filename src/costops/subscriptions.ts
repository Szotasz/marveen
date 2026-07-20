// CostOps v0.7 -- subscription lifecycle.
//
// Per-subscription active/canceled/paid_until/next_renewal facts, loaded from
// store/costops-subscriptions.json (gitignored, same convention as
// costops-config.json -- real dates/amounts never enter a tracked file). This
// module is pure I/O + derived-field computation. No Gmail access, no secrets,
// no raw email/PII -- the facts here are already-extracted structured data.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const SUBSCRIPTIONS_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json')
export const SUBSCRIPTIONS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-subscriptions.json.example')

export type SubscriptionStatus = 'active' | 'canceled' | 'expired' | 'unknown'
export type AmountSource = 'invoice' | 'manual_fallback' | 'no_invoice_found' | 'pending_permission'

export interface SubscriptionEntry {
  id: string
  name: string
  provider: string
  source: string             // where the lifecycle fact came from, e.g. 'google_play' | 'anthropic' | 'openai'
  status: SubscriptionStatus
  paid_until?: string        // 'YYYY-MM-DD', renews-then-ends date if canceled
  next_renewal?: string      // 'YYYY-MM-DD', next charge/renewal date if active
  amount?: number            // per-period amount, omitted entirely if unknown (never 0-fabricated)
  currency?: string
  amount_source: AmountSource
  notes?: string
  // v0.8 (card 6f4d1332 §5): optional real ceiling, only if the operator supplies one. No official
  // Claude Max/ChatGPT quota API exists (checked) -- absent, limits.ts reports the usage
  // honestly as 'unknown' rather than inventing a number. Config-schema-only addition.
  weekly_limit_tokens?: number
  five_hour_limit_tokens?: number
  // Card 2ed90db1: Claude session/weekly usage as a manual snapshot -- the operator occasionally
  // reads this off the Claude usage screen and shares it. There is no absolute token ceiling
  // behind this (Anthropic exposes percent-of-limit only), so this is percent + a raw reset
  // label, never a derived/fabricated token count.
  usage_snapshot?: UsageSnapshot
}

export interface UsageSnapshot {
  as_of: string                // ISO datetime this snapshot was captured/reported (manual, not live-polled)
  session_pct: number          // 0..100, current 5-hour session window usage
  weekly_pct: number           // 0..100, weekly (all models) usage -- this is what the 80% alert rule watches
  // Raw label as given (e.g. 'Tue 08:59'), NOT parsed into a computed calendar date -- the
  // reset's timezone and exact cadence aren't confirmed, so showing the verbatim fact the operator
  // reported beats silently guessing a specific date and risking it being wrong.
  weekly_reset_label: string
  fable_pct?: number           // optional, Fable-specific weekly % if reported (0 in the first snapshot)
}

export interface SubscriptionsConfig {
  version: number
  subscriptions: SubscriptionEntry[]
}

const EMPTY: SubscriptionsConfig = { version: 1, subscriptions: [] }

const EXAMPLE_CONFIG = {
  version: 1,
  _doc: 'CostOps v0.7 subscription lifecycle facts. Copy to store/costops-subscriptions.json. paid_until/next_renewal are ISO dates (YYYY-MM-DD). amount is omitted (not 0) when genuinely unknown -- set amount_source accordingly. usage_snapshot (card 2ed90db1) is an OPTIONAL manual reading off a Claude usage screen -- percent + a raw reset label only, never a derived token count; weekly_pct is what feeds the 80% alert.',
  subscriptions: [
    { id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', source: 'google_play', status: 'canceled', paid_until: '2026-07-16', amount_source: 'invoice', notes: 'cancellation notice received; active until paid_until, then ends' },
    {
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source: 'anthropic', status: 'active', next_renewal: '2026-07-20', amount_source: 'manual_fallback', notes: 'no invoice amount available yet',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59', fable_pct: 0 },
    },
    { id: 'openai-chatgpt', name: 'ChatGPT Plus', provider: 'openai', source: 'openai', status: 'active', amount_source: 'no_invoice_found' },
  ],
}

export interface SubscriptionsLoadResult {
  config: SubscriptionsConfig
  exists: boolean
  errors: string[]
}

export function loadSubscriptionsConfig(): SubscriptionsLoadResult {
  if (!existsSync(SUBSCRIPTIONS_PATH)) {
    ensureExampleSubscriptions()
    return { config: { ...EMPTY }, exists: false, errors: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'costops-subscriptions.json is not valid JSON')
    return { config: { ...EMPTY }, exists: true, errors: ['config is not valid JSON'] }
  }
  return validateSubscriptionsConfig(raw)
}

export function ensureExampleSubscriptions(): void {
  try {
    if (!existsSync(SUBSCRIPTIONS_EXAMPLE_PATH)) {
      writeFileSync(SUBSCRIPTIONS_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8')
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to write costops-subscriptions example')
  }
}

const VALID_STATUS = new Set(['active', 'canceled', 'expired', 'unknown'])
const VALID_AMOUNT_SOURCE = new Set(['invoice', 'manual_fallback', 'no_invoice_found', 'pending_permission'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateSubscriptionsConfig(raw: unknown): SubscriptionsLoadResult {
  const errors: string[] = []
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const rawSubs = Array.isArray(obj.subscriptions) ? obj.subscriptions : []
  const subscriptions: SubscriptionEntry[] = []
  for (const [i, e] of rawSubs.entries()) {
    const s = e as Record<string, unknown>
    if (typeof s?.id !== 'string' || !s.id) { errors.push(`subscriptions[${i}]: missing id`); continue }
    if (typeof s?.name !== 'string' || !s.name) { errors.push(`subscriptions[${i}] (${s.id}): missing name`); continue }
    const status = VALID_STATUS.has(s.status as string) ? s.status as SubscriptionStatus : 'unknown'
    const amount_source = VALID_AMOUNT_SOURCE.has(s.amount_source as string) ? s.amount_source as AmountSource : 'no_invoice_found'
    if (s.paid_until !== undefined && !ISO_DATE.test(s.paid_until as string)) { errors.push(`subscriptions[${i}] (${s.id}): paid_until must be YYYY-MM-DD`); continue }
    if (s.next_renewal !== undefined && !ISO_DATE.test(s.next_renewal as string)) { errors.push(`subscriptions[${i}] (${s.id}): next_renewal must be YYYY-MM-DD`); continue }
    if (s.amount !== undefined && (typeof s.amount !== 'number' || !isFinite(s.amount as number) || (s.amount as number) < 0)) {
      errors.push(`subscriptions[${i}] (${s.id}): amount must be a non-negative number when present`); continue
    }
    if (s.weekly_limit_tokens !== undefined && (typeof s.weekly_limit_tokens !== 'number' || !isFinite(s.weekly_limit_tokens as number) || (s.weekly_limit_tokens as number) < 0)) {
      errors.push(`subscriptions[${i}] (${s.id}): weekly_limit_tokens must be a non-negative number when present`); continue
    }
    if (s.five_hour_limit_tokens !== undefined && (typeof s.five_hour_limit_tokens !== 'number' || !isFinite(s.five_hour_limit_tokens as number) || (s.five_hour_limit_tokens as number) < 0)) {
      errors.push(`subscriptions[${i}] (${s.id}): five_hour_limit_tokens must be a non-negative number when present`); continue
    }
    // Malformed usage_snapshot is dropped (not fatal to the whole subscription entry) -- a typo
    // in a manually-pasted snapshot shouldn't lose the subscription's active/canceled status.
    const usage_snapshot = parseUsageSnapshot(s.usage_snapshot)
    subscriptions.push({
      id: s.id, name: s.name,
      provider: typeof s.provider === 'string' ? s.provider : 'other',
      source: typeof s.source === 'string' ? s.source : 'unknown',
      status,
      paid_until: typeof s.paid_until === 'string' ? s.paid_until : undefined,
      next_renewal: typeof s.next_renewal === 'string' ? s.next_renewal : undefined,
      amount: typeof s.amount === 'number' ? s.amount : undefined,
      currency: typeof s.currency === 'string' ? s.currency : undefined,
      amount_source,
      notes: typeof s.notes === 'string' ? s.notes : undefined,
      weekly_limit_tokens: typeof s.weekly_limit_tokens === 'number' ? s.weekly_limit_tokens : undefined,
      five_hour_limit_tokens: typeof s.five_hour_limit_tokens === 'number' ? s.five_hour_limit_tokens : undefined,
      usage_snapshot,
    })
  }
  return { config: { version: typeof obj.version === 'number' ? obj.version : 1, subscriptions }, exists: true, errors }
}

function isPct(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100
}

function parseUsageSnapshot(raw: unknown): UsageSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  if (typeof u.as_of !== 'string' || isNaN(Date.parse(u.as_of))) return undefined
  if (!isPct(u.session_pct) || !isPct(u.weekly_pct)) return undefined
  if (typeof u.weekly_reset_label !== 'string' || !u.weekly_reset_label) return undefined
  return {
    as_of: u.as_of,
    session_pct: u.session_pct,
    weekly_pct: u.weekly_pct,
    weekly_reset_label: u.weekly_reset_label,
    fable_pct: isPct(u.fable_pct) ? u.fable_pct : undefined,
  }
}

export interface SubscriptionLifecycle extends SubscriptionEntry {
  days_until_next_date: number | null  // to paid_until (if canceled) or next_renewal (if active); null if neither present
  past_due: boolean                    // next_renewal/paid_until date has passed with no corresponding invoice update
}

/**
 * Derive lifecycle display fields (days remaining, past-due flag) from the
 * static config facts + `now`. Pure function -- no I/O, no DB.
 */
export function deriveLifecycle(config: SubscriptionsConfig, now: number): SubscriptionLifecycle[] {
  const nowDay = Math.floor(now / 86400)
  return config.subscriptions.map(s => {
    const targetDate = s.status === 'canceled' ? s.paid_until : s.next_renewal
    let days_until_next_date: number | null = null
    let past_due = false
    if (targetDate && ISO_DATE.test(targetDate)) {
      const targetDay = Math.floor(Date.parse(`${targetDate}T00:00:00Z`) / 1000 / 86400)
      days_until_next_date = targetDay - nowDay
      past_due = s.status === 'active' && days_until_next_date < 0
    }
    return { ...s, days_until_next_date, past_due }
  })
}
