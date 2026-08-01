// CostOps v0.1 -- local cost config loader.
//
// The operator's fixed/manual monthly costs (Claude Max, ChatGPT, hosting,
// domain, SaaS, ...) and budgets live in store/costops-config.json. That path
// is under the gitignored store/ tree, so real amounts / account references
// NEVER enter a tracked file. A safe placeholder skeleton is generated as
// store/costops-config.json.example on first load if no config exists.
//
// This module is pure I/O + validation. No secrets, no network, no LLM.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const COSTOPS_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-config.json')
export const COSTOPS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-config.json.example')

export type CostConfidence =
  | 'actual_invoice'
  | 'provider_api'
  | 'billing_export'
  | 'local_usage'
  | 'estimate'
  | 'manual'

export type ChargeCategory =
  | 'usage'
  | 'subscription'
  | 'purchase'
  | 'tax'
  | 'credit'
  | 'adjustment'

export interface FixedCostEntry {
  source_id: string
  name: string
  provider: string          // 'anthropic' | 'openai' | 'github' | 'render' | 'namecheap' | 'aware' | 'other'
  source_type: string       // 'subscription' | 'hosting' | 'domain' | 'saas' | 'usage' | 'manual'
  amount: number            // per-PERIOD amount in `currency` -- see monthlyAmount()
  period?: 'monthly' | 'yearly'
  charge_category?: ChargeCategory
  confidence?: CostConfidence
  currency?: string         // the currency actually BILLED; never converted on the way in
  /**
   * Which project this cost belongs to. Anything that serves more than one
   * project (the Claude subscription, the box, the browser tools) belongs in
   * the shared bucket -- see SHARED_PROJECT for why we do not split it.
   */
  project?: string
  notes?: string
}

/**
 * The bucket for costs that serve more than one project.
 *
 * Deliberately NOT split across projects by some ratio. A split needs a
 * defensible key (revenue? time? tokens?), and every candidate here would be
 * invented rather than measured -- an invented split reads as fact once it is
 * in a table. The owner labelled these costs shared, so shared is what they
 * stay, and the per-project figures below stay honest about what they exclude.
 */
export const SHARED_PROJECT = 'shared'

// The owner writes this file by hand, in Hungarian, so the shared bucket has
// to answer to what a person would type -- not to one canonical spelling.
const SHARED_ALIASES = new Set(['', 'kozos', 'közös', 'shared', 'common', 'kozös'])

export function normalizeProject(raw: string | null | undefined): string {
  const p = (raw ?? '').trim()
  return SHARED_ALIASES.has(p.toLowerCase()) ? SHARED_PROJECT : p
}

/**
 * The monthly share of a fixed cost. A yearly subscription is divided by 12
 * rather than landing whole in its renewal month, so a project's monthly
 * figure does not jump 999 USD in the month the domain bill happens to fall.
 * This is amortization, not an estimate: the amount is exact, only its
 * placement in time is spread.
 */
export function monthlyAmount(e: FixedCostEntry): number {
  return e.period === 'yearly' ? e.amount / 12 : e.amount
}

export interface BudgetEntry {
  id: string
  name?: string
  scope?: 'global' | 'source' | 'provider' | 'product' | 'agent'
  scope_ref?: string
  amount: number
  currency?: string
  warning_threshold?: number  // fraction, default 0.8
  hard_threshold?: number     // fraction, default 1.0
}

export interface CostOpsConfig {
  version: number
  /** Display currency. Amounts are STORED in the currency they are billed in. */
  currency: string
  /**
   * Rate per unit of a foreign currency in the display currency, e.g.
   * `{ "USD": 355, "EUR": 395 }` with `currency: "HUF"`. Applied only when a
   * figure is shown, never when it is stored -- a rate baked into the ledger
   * would freeze today's rate into last month's history and could not be
   * corrected. A currency with no rate here is NOT converted and NOT guessed:
   * it stays in its own currency and the summary says a rate is missing.
   */
  fx_rates: Record<string, number>
  /** When the operator last updated the rates. Display only. */
  fx_asof?: string
  fixed_costs: FixedCostEntry[]
  budgets: BudgetEntry[]
}

const EMPTY_CONFIG: CostOpsConfig = {
  version: 1,
  currency: 'HUF',
  fx_rates: {},
  fixed_costs: [],
  budgets: [],
}

// Safe skeleton with placeholder (zero) values -- contains no real amounts,
// account IDs or secrets, so it is safe to keep as a tracked example too.
const EXAMPLE_CONFIG = {
  version: 1,
  currency: 'HUF',
  _doc: 'CostOps local config. Copy to store/costops-config.json and fill in real values. Enter each amount in the currency it is BILLED in, with its own period (monthly/yearly); conversion happens at display time using fx_rates, never on the way in. `project` groups a cost under one project -- leave it empty or write KOZOS for anything serving several. No secrets/API keys here -- put those in the Vault.',
  fx_rates: { USD: 0, EUR: 0 },
  fx_asof: '',
  fixed_costs: [
    { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 0, period: 'monthly', currency: 'EUR', project: 'KOZOS', charge_category: 'subscription', confidence: 'manual' },
    { source_id: 'openai-chatgpt', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 0, period: 'monthly', currency: 'USD', project: 'KOZOS', confidence: 'manual' },
    { source_id: 'github', name: 'GitHub', provider: 'github', source_type: 'saas', amount: 0, period: 'monthly', currency: 'USD', project: 'KOZOS', confidence: 'manual' },
    { source_id: 'hosting', name: 'Hosting', provider: 'other', source_type: 'hosting', amount: 0, period: 'monthly', currency: 'USD', project: 'example-product', confidence: 'manual' },
    { source_id: 'domain', name: 'Domain', provider: 'other', source_type: 'domain', amount: 0, period: 'yearly', currency: 'USD', project: 'example-product', confidence: 'manual' },
  ],
  budgets: [
    { id: 'global-monthly', name: 'Global monthly', scope: 'global', amount: 0, warning_threshold: 0.8, hard_threshold: 1.0 },
  ],
}

export interface ConfigLoadResult {
  config: CostOpsConfig
  exists: boolean
  errors: string[]
}

/**
 * Load and validate the local CostOps config. Never throws: a missing or
 * malformed config yields an empty (but valid) config plus a list of errors,
 * so the read-only summary endpoint degrades gracefully instead of 500ing.
 * On a missing config, writes the placeholder example alongside for guidance.
 */
export function loadCostopsConfig(): ConfigLoadResult {
  if (!existsSync(COSTOPS_CONFIG_PATH)) {
    ensureExampleConfig()
    return { config: { ...EMPTY_CONFIG }, exists: false, errors: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(COSTOPS_CONFIG_PATH, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'costops-config.json is not valid JSON')
    return { config: { ...EMPTY_CONFIG }, exists: true, errors: ['config is not valid JSON'] }
  }
  return validateConfig(raw)
}

export function ensureExampleConfig(): void {
  try {
    if (!existsSync(COSTOPS_EXAMPLE_PATH)) {
      writeFileSync(COSTOPS_EXAMPLE_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf-8')
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to write costops-config example')
  }
}

/**
 * Pure validation of a parsed config object. Exported for unit tests.
 * Drops invalid entries (with an error note) rather than failing the whole load.
 */
export function validateConfig(raw: unknown): ConfigLoadResult {
  const errors: string[] = []
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const currency = typeof obj.currency === 'string' ? obj.currency : 'HUF'

  const fixed_costs: FixedCostEntry[] = []
  const rawFixed = Array.isArray(obj.fixed_costs) ? obj.fixed_costs : []
  for (const [i, e] of rawFixed.entries()) {
    const c = e as Record<string, unknown>
    if (typeof c?.source_id !== 'string' || !c.source_id) { errors.push(`fixed_costs[${i}]: missing source_id`); continue }
    if (typeof c?.amount !== 'number' || !isFinite(c.amount) || c.amount < 0) { errors.push(`fixed_costs[${i}] (${c.source_id}): amount must be a non-negative number`); continue }
    if (c.period !== undefined && c.period !== 'monthly' && c.period !== 'yearly') { errors.push(`fixed_costs[${i}] (${c.source_id}): period must be 'monthly' or 'yearly'`); continue }
    fixed_costs.push({
      source_id: c.source_id,
      name: typeof c.name === 'string' ? c.name : c.source_id,
      provider: typeof c.provider === 'string' ? c.provider : 'other',
      source_type: typeof c.source_type === 'string' ? c.source_type : 'manual',
      amount: c.amount,
      period: c.period === 'yearly' ? 'yearly' : 'monthly',
      project: normalizeProject(typeof c.project === 'string' ? c.project : undefined),
      charge_category: (typeof c.charge_category === 'string' ? c.charge_category : 'subscription') as ChargeCategory,
      confidence: (typeof c.confidence === 'string' ? c.confidence : 'manual') as CostConfidence,
      currency: typeof c.currency === 'string' ? c.currency : currency,
      notes: typeof c.notes === 'string' ? c.notes : undefined,
    })
  }

  const budgets: BudgetEntry[] = []
  const rawBudgets = Array.isArray(obj.budgets) ? obj.budgets : []
  for (const [i, e] of rawBudgets.entries()) {
    const b = e as Record<string, unknown>
    if (typeof b?.id !== 'string' || !b.id) { errors.push(`budgets[${i}]: missing id`); continue }
    if (typeof b?.amount !== 'number' || !isFinite(b.amount) || b.amount < 0) { errors.push(`budgets[${i}] (${b.id}): amount must be a non-negative number`); continue }
    budgets.push({
      id: b.id,
      name: typeof b.name === 'string' ? b.name : b.id,
      scope: (typeof b.scope === 'string' ? b.scope : 'global') as BudgetEntry['scope'],
      scope_ref: typeof b.scope_ref === 'string' ? b.scope_ref : undefined,
      amount: b.amount,
      currency: typeof b.currency === 'string' ? b.currency : currency,
      warning_threshold: typeof b.warning_threshold === 'number' ? b.warning_threshold : 0.8,
      hard_threshold: typeof b.hard_threshold === 'number' ? b.hard_threshold : 1.0,
    })
  }

  // A rate must be a positive finite number. A zero or negative "rate" would
  // silently zero out or invert a whole currency's costs, which is worse than
  // having no rate at all (no rate is visible; a wrong rate is not).
  const fx_rates: Record<string, number> = {}
  const rawRates = (obj.fx_rates && typeof obj.fx_rates === 'object') ? obj.fx_rates as Record<string, unknown> : {}
  for (const [code, value] of Object.entries(rawRates)) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      errors.push(`fx_rates.${code}: rate must be a positive number`)
      continue
    }
    fx_rates[code.toUpperCase()] = value
  }

  return {
    config: {
      version: typeof obj.version === 'number' ? obj.version : 1,
      currency,
      fx_rates,
      fx_asof: typeof obj.fx_asof === 'string' ? obj.fx_asof : undefined,
      fixed_costs,
      budgets,
    },
    exists: true,
    errors,
  }
}

/**
 * Convert an amount into the display currency, or null when we cannot.
 *
 * Null is a real answer here: "no rate configured" must surface as a gap in
 * the UI, not as an unconverted number sitting next to converted ones where it
 * reads as though it were the same unit.
 */
export function toDisplayCurrency(
  amount: number,
  from: string,
  config: Pick<CostOpsConfig, 'currency' | 'fx_rates'>,
): number | null {
  const src = (from || config.currency).toUpperCase()
  if (src === config.currency.toUpperCase()) return amount
  const rate = config.fx_rates[src]
  return rate === undefined ? null : amount * rate
}
