-- Migration 0005: Token usage aggregation tables
-- Adds daily and monthly rollup tables so raw token_usage rows can be pruned
-- aggressively (30-day window) without losing billing/cost-audit history.
-- The aggregator tables are idempotently maintained by pruneTokenUsage().

-- 1. Daily rollup: one row per (day, agent, model); retained for 1 year.
CREATE TABLE IF NOT EXISTS token_usage_daily (
  day                   TEXT    NOT NULL,  -- 'YYYY-MM-DD' local time
  agent                 TEXT    NOT NULL,
  model                 TEXT    NOT NULL DEFAULT '',
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  row_count             INTEGER NOT NULL DEFAULT 0,  -- raw rows aggregated
  PRIMARY KEY (day, agent, model)
);

-- 2. Monthly rollup: one row per (month, agent, model); retained for 3 years.
CREATE TABLE IF NOT EXISTS token_usage_monthly (
  month                 TEXT    NOT NULL,  -- 'YYYY-MM' local time
  agent                 TEXT    NOT NULL,
  model                 TEXT    NOT NULL DEFAULT '',
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  session_count         INTEGER NOT NULL DEFAULT 0,  -- distinct session_ids
  row_count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, agent, model)
);
