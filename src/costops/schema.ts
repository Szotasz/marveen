// CostOps schema -- ALL CostOps CREATE TABLE / ALTER TABLE / CREATE INDEX
// statements live here, not in src/db.ts. This is the "schema" seam: db.ts
// owns exactly one call, `initCostOpsSchema(db)`, marked
// `// LOCAL-FORK: costops seam`. Every table
// this feature has ever added (v0.1 through Phase 0) is consolidated here,
// verbatim, so the upstream-owned db.ts stops growing a table per CostOps
// release. Idempotent by construction (CREATE TABLE IF NOT EXISTS, ALTER
// TABLE wrapped in try/catch) -- calling this on an already-migrated DB is a
// safe no-op, exactly like the individual statements were before the move.

import type Database from 'better-sqlite3'
import { initFxSchema } from './fx.js'
import { initAlertsSchema } from './alerts.js'
import { initForecastSchema } from './forecast.js'
import { initPeriodCloseSchema } from './period-close.js'
import { initBudgetAuditSchema } from './budgets.js'
import { initOptimizationSchema } from './optimization.js'
import { initInvoiceSchema } from './invoice.js'

export function initCostOpsSchema(db: Database.Database): void {
  // CostOps v0.2: model/provider enrichment on the CORE token_usage table
  // (not CostOps-owned, but this feature bolts 3 nullable columns onto it for
  // token-cost estimation). Nullable + forward-only: NEW ingested rows carry
  // the model from the transcript; existing rows stay NULL (unknown) -> left
  // unpriced, never guessed. Must run after token_usage itself exists --
  // db.ts calls initCostOpsSchema() after that table's own setup.
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN model TEXT`) } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN provider TEXT`) } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN model_source TEXT`) } catch { /* column already exists */ }
  // --- CostOps (local cost ledger, v0.1) ---
  // Read-mostly, FOCUS-inspired. cost_sources = provider/subscription origin,
  // cost_line_items = individual charge rows (estimate or provider-sourced),
  // budgets = display-only warning thresholds. No secrets/account IDs stored raw.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_type TEXT NOT NULL,
      account_ref TEXT,
      currency TEXT NOT NULL DEFAULT 'HUF',
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES cost_sources(id),
      charge_period_start INTEGER NOT NULL,
      charge_period_end INTEGER NOT NULL,
      charge_category TEXT NOT NULL,
      service_name TEXT,
      usage_type TEXT,
      consumed_quantity REAL,
      consumed_unit TEXT,
      billed_cost REAL NOT NULL,
      effective_cost REAL,
      currency TEXT NOT NULL DEFAULT 'HUF',
      confidence TEXT NOT NULL,
      data_freshness INTEGER NOT NULL,
      source_ref TEXT,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_period ON cost_line_items(charge_period_start, charge_period_end)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_source ON cost_line_items(source_id)`)
  // v0.7 currency-retention (additive): when a line's billed_cost is HUF-converted
  // from a foreign-currency invoice, keep the original amount/currency/fx_rate/fx_date
  // alongside it so the UI can show the conversion. NULL for already-HUF entries.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN original_amount REAL`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN original_currency TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_rate REAL`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_date INTEGER`) } catch { /* already exists */ }
  // v0.8: distinguishes provider API live query from email invoice from config-driven
  // manual entry. Nullable, no default: every write site sets it explicitly.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN actual_source TEXT`) } catch { /* already exists */ }
  // Phase 0: a financial ledger row must never silently disappear -- void/archive
  // instead of hard DELETE, so a mistaken/superseded manual entry stays auditable.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN voided_at INTEGER`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN void_reason TEXT`) } catch { /* already exists */ }
  // Phase 1 (GAP-05/GAP-06/GAP-14): correction chain -- a correction voids the wrong
  // row and inserts a new row pointing back at it via corrects_line_id.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN corrects_line_id INTEGER REFERENCES cost_line_items(id)`) } catch { /* already exists */ }
  // Phase 1 (GAP-09): fx_source/conversion_method columns + fx_rates history table.
  initFxSchema(db)
  // Phase 3 (GAP-12): costops_alerts lifecycle table.
  initAlertsSchema(db)
  // Phase 1 (GAP-10): forecast_snapshots table. FK to cost_sources(id).
  initForecastSchema(db)
  // Phase 2 (GAP-13): period_status/period_close_events -- monthly close workflow.
  initPeriodCloseSchema(db)
  // Phase 3 (GAP-11): budget change audit trail.
  initBudgetAuditSchema(db)
  // Phase 4: optimization recommendations persistence.
  initOptimizationSchema(db)
  // Phase 1: invoice/credit/refund/correction workflow tables.
  initInvoiceSchema(db)

  // CostOps v0.3: provider cost-collector run history / sync status. No raw
  // account id, no raw API response, no secret ever stored here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      collector_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      period_start INTEGER,
      period_end INTEGER,
      imported_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message_sanitized TEXT,
      data_freshness_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_runs_provider ON import_runs(provider, started_at)`)
  // v0.5: sanitized per-run detail (service_count, plan breakdown) as JSON.
  try { db.exec(`ALTER TABLE import_runs ADD COLUMN detail_json TEXT`) } catch { /* already exists */ }
  // Phase 1 (GAP-07): per-provider import lock for concurrent sync safety.
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_locks (
      provider TEXT PRIMARY KEY,
      locked_at INTEGER NOT NULL,
      lock_token TEXT NOT NULL
    )
  `)
  // CostOps: provider prepaid-balance snapshots. For prepaid providers (e.g.
  // DeepSeek) that expose remaining balance but not per-period cost.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL,
      captured_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_balance_snapshots_provider ON provider_balance_snapshots(provider, captured_at)`)
  // CostOps: provider rate-limit / quota-usage snapshots.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_ratelimit_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      limit_id TEXT,
      used_percent REAL NOT NULL,
      window_duration_mins INTEGER,
      resets_at INTEGER,
      plan_type TEXT,
      captured_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ratelimit_snapshots_provider ON provider_ratelimit_snapshots(provider, captured_at)`)
  // CostOps Phase 0: 7-day source-reliability observation window snapshots.
  db.exec(`
    CREATE TABLE IF NOT EXISTS costops_reliability_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      inventory_json TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reliability_snapshots_captured ON costops_reliability_snapshots(captured_at)`)
  // v0.7/v2: Google Workspace payment-failure/suspension signal.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      message_ref TEXT,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_alerts_account ON workspace_alerts(account, detected_at)`)
  try { db.exec(`ALTER TABLE workspace_alerts ADD COLUMN suspension_date INTEGER`) } catch { /* already exists */ }
  // CostOps v1.0: included-usage/entitlement model. Kept SEPARATE from
  // cost_line_items -- included usage must never leak into operational_spend.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      product TEXT NOT NULL,
      plan_name TEXT,
      billing_period TEXT NOT NULL,
      entitlement_type TEXT NOT NULL,
      included_limit REAL,
      included_unit TEXT,
      usage_to_date REAL,
      remaining REAL,
      usage_pct REAL,
      reset_at INTEGER,
      usage_source TEXT NOT NULL,
      usage_confidence TEXT,
      forecast_usage_period_end REAL,
      forecast_exhaustion_at INTEGER,
      overage_supported INTEGER NOT NULL DEFAULT 0,
      overage_unit_price REAL,
      forecast_overage_quantity REAL,
      forecast_overage_cost REAL,
      status TEXT NOT NULL,
      dedup_key TEXT UNIQUE,
      last_updated INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entitlements_provider ON entitlements(provider, product)`)
  // Budgets table -- per-budget scope/amount/threshold.
  db.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_ref TEXT,
      period TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'HUF',
      warning_threshold REAL NOT NULL DEFAULT 0.8,
      hard_threshold REAL NOT NULL DEFAULT 1.0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}
