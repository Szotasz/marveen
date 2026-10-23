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
  amount: number            // per-period amount in `currency`
  period?: 'monthly'        // v0.1 supports monthly only
  charge_category?: ChargeCategory
  confidence?: CostConfidence
  currency?: string
  notes?: string
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

export interface TokenPrice {
  input: number          // per 1M input tokens, in the config currency
  output: number         // per 1M output tokens
  cache_write?: number   // per 1M cache-creation tokens; absent = those tokens are unpriced
  cache_read?: number    // per 1M cache-read tokens; absent = those tokens are unpriced
}

export interface CostOpsConfig {
  version: number
  currency: string
  fixed_costs: FixedCostEntry[]
  budgets: BudgetEntry[]
  token_prices?: Record<string, TokenPrice>  // keyed by model id as stored in token_usage.model
  enforce_agent_budgets?: boolean  // opt-in: defer an agent's background scheduled tasks while it is at its hard budget level; default false
}

const EMPTY_CONFIG: CostOpsConfig = {
  version: 1,
  currency: 'HUF',
  fixed_costs: [],
  budgets: [],
  enforce_agent_budgets: false,
}

// Safe skeleton with placeholder (zero) values -- contains no real amounts,
// account IDs or secrets, so it is safe to keep as a tracked example too.
const EXAMPLE_CONFIG = {
  version: 1,
  currency: 'HUF',
  _doc: 'CostOps local config. Copy to store/costops-config.json and fill in real values. Amounts are per month. No secrets/API keys here -- put those in the Vault.',
  fixed_costs: [
    { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 0, period: 'monthly', charge_category: 'subscription', confidence: 'manual' },
    { source_id: 'openai-chatgpt', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 0, period: 'monthly', confidence: 'manual' },
    { source_id: 'github', name: 'GitHub', provider: 'github', source_type: 'saas', amount: 0, period: 'monthly', confidence: 'manual' },
    { source_id: 'hosting', name: 'Hosting', provider: 'other', source_type: 'hosting', amount: 0, period: 'monthly', confidence: 'manual' },
    { source_id: 'domain', name: 'Domain', provider: 'other', source_type: 'domain', amount: 0, period: 'monthly', confidence: 'manual' },
  ],
  budgets: [
    { id: 'global-monthly', name: 'Global monthly', scope: 'global', amount: 0, warning_threshold: 0.8, hard_threshold: 1.0 },
  ],
  token_prices: {},
  enforce_agent_budgets: false,
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
    if (c.period !== undefined && c.period !== 'monthly') { errors.push(`fixed_costs[${i}] (${c.source_id}): only period 'monthly' is supported in v0.1`); continue }
    fixed_costs.push({
      source_id: c.source_id,
      name: typeof c.name === 'string' ? c.name : c.source_id,
      provider: typeof c.provider === 'string' ? c.provider : 'other',
      source_type: typeof c.source_type === 'string' ? c.source_type : 'manual',
      amount: c.amount,
      period: 'monthly',
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

  const collected: Record<string, TokenPrice> = Object.create(null)
  const rawPrices = obj.token_prices
  if (rawPrices !== undefined && !(rawPrices && typeof rawPrices === 'object' && !Array.isArray(rawPrices))) {
    errors.push('token_prices: must be an object mapping a model id to its prices')
  } else if (rawPrices !== undefined) {
    const okNum = (v: unknown) => typeof v === 'number' && isFinite(v) && v >= 0
    for (const [model, p] of Object.entries(rawPrices as Record<string, unknown>)) {
      if (model === '__proto__') { errors.push('token_prices.__proto__: not a valid model id'); continue }
      const t = (p && typeof p === 'object') ? p as Record<string, unknown> : {}
      if (!okNum(t.input) || !okNum(t.output)) { errors.push(`token_prices.${model}: input and output must be non-negative numbers`); continue }
      if (t.cache_write !== undefined && !okNum(t.cache_write)) { errors.push(`token_prices.${model}: cache_write must be a non-negative number`); continue }
      if (t.cache_read !== undefined && !okNum(t.cache_read)) { errors.push(`token_prices.${model}: cache_read must be a non-negative number`); continue }
      const price: TokenPrice = { input: t.input as number, output: t.output as number }
      if (t.cache_write !== undefined) price.cache_write = t.cache_write as number
      if (t.cache_read !== undefined) price.cache_read = t.cache_read as number
      collected[model] = price
    }
  }
  const token_prices: Record<string, TokenPrice> = { ...collected }

  let enforce_agent_budgets = false
  if (obj.enforce_agent_budgets === undefined) enforce_agent_budgets = false
  else if (typeof obj.enforce_agent_budgets === 'boolean') enforce_agent_budgets = obj.enforce_agent_budgets
  else errors.push('enforce_agent_budgets: must be true or false')

  return {
    config: {
      version: typeof obj.version === 'number' ? obj.version : 1, currency, fixed_costs, budgets, enforce_agent_budgets,
      ...(Object.keys(token_prices).length > 0 ? { token_prices } : {}),
    },
    exists: true,
    errors,
  }
}
