// CostOps schema -- ALL CostOps CREATE TABLE / ALTER TABLE / CREATE INDEX
// statements live here, not in src/db.ts. This is the "schema" seam
// (docs/fork-upstream-policy.md §2a): db.ts owns exactly one call,
// `initCostOpsSchema(db)`, marked `// LOCAL-FORK: costops seam`. Every table
// this feature has ever added (v0.1 through PR-B) is consolidated here,
// verbatim, so the upstream-owned db.ts stops growing a table per CostOps
// release. Idempotent by construction (CREATE TABLE IF NOT EXISTS, ALTER
// TABLE wrapped in try/catch) -- calling this on an already-migrated DB is a
// safe no-op, exactly like the individual statements were before the move.

import type Database from 'better-sqlite3'
import { initForecastSchema } from './forecast.js'
import { initFxSchema } from './fx.js'

export function initCostOpsSchema(db: Database.Database): void {
  // CostOps v0.2: model/provider enrichment on the CORE token_usage table
  // (not CostOps-owned, but this feature bolts 2 nullable columns onto it for
  // token-cost estimation). Nullable + forward-only: NEW ingested rows carry
  // the model from the transcript; existing rows stay NULL (unknown) -> left
  // unpriced, never guessed. Must run after token_usage itself exists --
  // db.ts calls initCostOpsSchema() after that table's own setup.
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN model TEXT`) } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN provider TEXT`) } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE token_usage ADD COLUMN model_source TEXT`) } catch { /* column already exists */ }
  // --- CostOps (local cost ledger, v0.1) ---
  // Read-mostly, FOCUS-inspired. cost_sources = provider/subscription origin,
  // cost_line_items = individual charge rows (estimate or provider-sourced).
  // No secrets/account IDs stored raw. Budgets are config-driven (costops/config.ts's
  // BudgetEntry, from store/costops-config.json) -- there is deliberately no separate
  // `budgets` DB table: an earlier draft of this schema had one, but it was never
  // read from or written to (config.budgets was always the actual source), so it was
  // a dead, unused second source of truth. Removed rather than wired up, since the
  // config file already covers this fully and a DB table would just be a sync burden
  // for no benefit.
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
  // Currency-retention (Phase-3 per spec): when a line's billed_cost is
  // HUF-converted from a foreign-currency invoice, keep the original
  // amount/currency/fx_rate/fx_date alongside it so the UI can show "11.15 USD ->
  // 4014 HUF" instead of just the converted number. NULL for lines that were never
  // converted (already-HUF entries) -- never fabricated, no existing calc touched.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN original_amount REAL`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN original_currency TEXT`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_rate REAL`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_date INTEGER`) } catch { /* already exists */ }
  // v0.8: distinguishes "we queried the provider API live" (provider_api) from
  // "we read an email invoice" (email_invoice) from "config-driven fixed cost" (manual_entry) --
  // neither `confidence` (the priority/authoritativeness axis) nor `cost_sources.source_type`
  // (a category axis) cleanly carries this. Nullable, no default: every write site sets it
  // explicitly; a NULL row (pre-migration history) falls back to 'no_data' at read time, never guessed.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN actual_source TEXT`) } catch { /* already exists */ }
  // CostOps Phase 0: a financial ledger row must never silently disappear --
  // void/archive instead of hard DELETE, so a mistaken/superseded manual entry
  // stays auditable. NULL = active (the overwhelming majority of rows, including
  // all pre-Phase-0 history); every read path that aggregates cost_line_items
  // must filter `voided_at IS NULL`.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN voided_at INTEGER`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN void_reason TEXT`) } catch { /* already exists */ }
  // A correction voids the wrong row AND inserts a new row pointing back at it
  // via corrects_line_id, so "what replaced this, and why" stays traceable
  // instead of two unrelated void+POST rows correlated only by matching
  // source_id/month/timing. See correction.ts.
  try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN corrects_line_id INTEGER REFERENCES cost_line_items(id)`) } catch { /* already exists */ }
  // Phase 1 (GAP-09): fx_source/conversion_method columns + fx_rates table
  initFxSchema(db)
  // Phase 1 (GAP-10): forecast_snapshots table
  initForecastSchema(db)
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
  // v0.5: sanitized per-run detail (service_count, plan breakdown, not_covered) as JSON.
  // NO raw service/account IDs -- the breakdown carries only type/plan labels + counts.
  try { db.exec(`ALTER TABLE import_runs ADD COLUMN detail_json TEXT`) } catch { /* already exists */ }
  // CostOps: provider prepaid-balance snapshots. For prepaid providers (e.g.
  // DeepSeek) that expose remaining balance but not per-period cost, MTD spend
  // is derived from the balance DROP across snapshots. No secret, no raw id.
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
}
