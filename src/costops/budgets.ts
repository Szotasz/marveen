// CostOps Phase 3 (GAP-11) -- multi-level budgets.
//
// Generalizes ledger.ts's single hardcoded 'global-monthly' budget
// resolution into one that works for every BudgetEntry.scope (global,
// provider, category, source) against the same CostSummary the dashboard
// already computes -- so a budget's current_spend/forecast never diverges
// from what the dashboard shows for that scope. 'product'/'agent' scopes are
// explicitly NOT resolved (GAP-11: no agent/task/product budget) -- they
// stay valid config values for backward compatibility but always resolve to
// zero spend/forecast here, never fabricated as something meaningful.
//
// Budgets are still config-file-defined (costops-config.json), matching
// every other CostOps config -- but a change through the API (not a manual
// file edit) is now auditable via costops_budget_audit, satisfying GAP-11's
// "budget change AUDIT (who/when/what changed)".

import type Database from 'better-sqlite3'
import { getCostSummary, type CostSummary } from './ledger.js'
import { saveCostopsConfig, type CostOpsConfig, type BudgetEntry } from './config.js'

export function initBudgetAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS costops_budget_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      budget_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_budget_audit_budget ON costops_budget_audit(budget_id, created_at)`)
}

const DEFAULT_OWNER = process.env.COSTOPS_DEFAULT_OWNER || 'operator'

export interface BudgetStatus {
  id: string
  name: string
  scope: NonNullable<BudgetEntry['scope']>
  scope_ref: string | null
  period: 'monthly'
  amount: number
  currency: string
  warning_threshold: number
  hard_threshold: number
  current_spend: number
  forecast: number
  variance: number  // forecast - amount; positive = projected overage
  used_pct: number
  forecast_pct: number
  status: 'ok' | 'warning' | 'hard'
  owner: string
  notes: string | null
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
function round4(n: number): number { return Math.round(n * 10000) / 10000 }

function spendForScope(budget: BudgetEntry, summary: CostSummary): { spend: number; forecast: number } {
  const scope = budget.scope ?? 'global'
  if (scope === 'global') {
    return { spend: summary.operational_spend, forecast: summary.operational_forecast_month_end }
  }
  if (scope === 'provider') {
    const sources = summary.all_sources.filter(s => s.provider === budget.scope_ref)
    return {
      spend: sources.reduce((sum, s) => sum + (s.spend ?? 0), 0),
      forecast: sources.reduce((sum, s) => sum + (s.forecast_month_end ?? 0), 0),
    }
  }
  if (scope === 'category') {
    const sources = summary.all_sources.filter(s => s.source_type === budget.scope_ref)
    return {
      spend: sources.reduce((sum, s) => sum + (s.spend ?? 0), 0),
      forecast: sources.reduce((sum, s) => sum + (s.forecast_month_end ?? 0), 0),
    }
  }
  if (scope === 'source') {
    const row = summary.all_sources.find(s => s.source_id === budget.scope_ref)
    return { spend: row?.spend ?? 0, forecast: row?.forecast_month_end ?? 0 }
  }
  // 'product' | 'agent': explicitly out of GAP-11 scope -- never resolved to
  // a real number here (no agent/task/product cost attribution exists).
  return { spend: 0, forecast: 0 }
}

/** Resolve one budget entry's live status against an already-computed CostSummary. Pure, no I/O. */
export function resolveBudgetStatus(budget: BudgetEntry, summary: CostSummary): BudgetStatus {
  const { spend, forecast } = spendForScope(budget, summary)
  const warning_threshold = budget.warning_threshold ?? 0.8
  const hard_threshold = budget.hard_threshold ?? 1.0
  const used_pct = budget.amount > 0 ? spend / budget.amount : 0
  const forecast_pct = budget.amount > 0 ? forecast / budget.amount : 0
  // Status is display-only (governance/alerting), never an automatic stop --
  // same convention as ledger.ts's existing single-budget status.
  const status: BudgetStatus['status'] = used_pct >= hard_threshold ? 'hard' : used_pct >= warning_threshold ? 'warning' : 'ok'
  return {
    id: budget.id, name: budget.name ?? budget.id, scope: budget.scope ?? 'global', scope_ref: budget.scope_ref ?? null,
    period: 'monthly', amount: budget.amount, currency: budget.currency ?? summary.currency,
    warning_threshold, hard_threshold,
    current_spend: round2(spend), forecast: round2(forecast), variance: round2(forecast - budget.amount),
    used_pct: round4(used_pct), forecast_pct: round4(forecast_pct), status,
    owner: budget.owner ?? DEFAULT_OWNER, notes: budget.notes ?? null,
  }
}

/** Every configured budget's live status for the given month. */
export function getAllBudgetStatuses(db: Database.Database, config: CostOpsConfig, now: number, monthKey?: string): BudgetStatus[] {
  const summary = getCostSummary(db, config, now, { monthKey })
  return config.budgets.map(b => resolveBudgetStatus(b, summary))
}

export interface BudgetWriteResult {
  ok: boolean
  error?: string
  status?: number
  budget?: BudgetEntry
}

export interface UpsertBudgetInput {
  id: string
  name?: string
  scope?: BudgetEntry['scope']
  scope_ref?: string
  amount: number
  currency?: string
  warning_threshold?: number
  hard_threshold?: number
  owner?: string
  notes?: string
}

/**
 * Create or update a budget entry, persist the config file, and record an
 * audited before/after change. Returns the freshly-loaded config's budgets
 * array is NOT returned here -- callers reload via loadCostopsConfig() for
 * the next request, same as every other CostOps write path.
 */
export function upsertBudget(db: Database.Database, config: CostOpsConfig, input: UpsertBudgetInput, actor: string, now: number): BudgetWriteResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required for a budget change (audit trail)', status: 400 }
  if (!input || typeof input.id !== 'string' || !input.id) return { ok: false, error: 'missing id', status: 400 }
  if (typeof input.amount !== 'number' || !isFinite(input.amount) || input.amount < 0) {
    return { ok: false, error: 'amount must be a non-negative number', status: 400 }
  }
  const existingIdx = config.budgets.findIndex(b => b.id === input.id)
  const before = existingIdx >= 0 ? config.budgets[existingIdx] : null
  const entry: BudgetEntry = {
    id: input.id, name: input.name ?? input.id, scope: input.scope ?? 'global', scope_ref: input.scope_ref,
    amount: input.amount, currency: input.currency ?? config.currency,
    warning_threshold: input.warning_threshold ?? 0.8, hard_threshold: input.hard_threshold ?? 1.0,
    owner: input.owner, notes: input.notes,
  }
  const budgets = [...config.budgets]
  if (existingIdx >= 0) budgets[existingIdx] = entry
  else budgets.push(entry)
  saveCostopsConfig({ ...config, budgets })
  db.prepare(`
    INSERT INTO costops_budget_audit (budget_id, action, actor, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.id, before ? 'updated' : 'created', actor, before ? JSON.stringify(before) : null, JSON.stringify(entry), now)
  return { ok: true, budget: entry }
}

/** Remove a budget entry, persist the config file, and record the audited deletion. */
export function deleteBudget(db: Database.Database, config: CostOpsConfig, id: string, actor: string, now: number): BudgetWriteResult {
  if (!actor || !actor.trim()) return { ok: false, error: 'actor is required for a budget change (audit trail)', status: 400 }
  const existingIdx = config.budgets.findIndex(b => b.id === id)
  if (existingIdx < 0) return { ok: false, error: `no budget '${id}'`, status: 404 }
  const before = config.budgets[existingIdx]
  const budgets = config.budgets.filter(b => b.id !== id)
  saveCostopsConfig({ ...config, budgets })
  db.prepare(`
    INSERT INTO costops_budget_audit (budget_id, action, actor, before_json, after_json, created_at)
    VALUES (?, 'deleted', ?, ?, NULL, ?)
  `).run(id, actor, JSON.stringify(before), now)
  return { ok: true }
}

export interface BudgetAuditEntry {
  budget_id: string
  action: 'created' | 'updated' | 'deleted'
  actor: string
  before: BudgetEntry | null
  after: BudgetEntry | null
  created_at: number
}

/** Full audit history, oldest first, optionally filtered to one budget id. */
export function getBudgetAuditHistory(db: Database.Database, budgetId?: string): BudgetAuditEntry[] {
  const rows = (budgetId
    ? db.prepare(`SELECT * FROM costops_budget_audit WHERE budget_id = ? ORDER BY created_at ASC`).all(budgetId)
    : db.prepare(`SELECT * FROM costops_budget_audit ORDER BY created_at ASC`).all()
  ) as Array<{ budget_id: string; action: string; actor: string; before_json: string | null; after_json: string | null; created_at: number }>
  return rows.map(r => ({
    budget_id: r.budget_id, action: r.action as BudgetAuditEntry['action'], actor: r.actor,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
    created_at: r.created_at,
  }))
}
