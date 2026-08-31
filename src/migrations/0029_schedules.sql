-- schedules: SQL-backed scheduled tasks replacing the file-based system.
-- Replaces the deprecated `scheduled_tasks` table (Telegram-era API, never
-- used by the current file runner). tenant_id=NULL means fleet-owned
-- (heartbeats, morning chain, etc.); TEXT means a B2B-tenant-created task.
-- The file system under ~/.claude/scheduled-tasks/ is kept as a read-only
-- fallback for the duration of the transition and is not removed here.

CREATE TABLE IF NOT EXISTS schedules (
  id                       TEXT PRIMARY KEY,   -- sanitized slug, e.g. "morning-chain"
  prompt                   TEXT NOT NULL DEFAULT '',
  description              TEXT NOT NULL DEFAULT '',
  schedule                 TEXT NOT NULL,       -- cron expression
  agent                    TEXT NOT NULL,
  type                     TEXT NOT NULL DEFAULT 'task'
                             CHECK(type IN ('task','heartbeat','command')),
  enabled                  INTEGER NOT NULL DEFAULT 1,
  tenant_id                TEXT,               -- NULL = fleet scope
  skip_if_busy             INTEGER NOT NULL DEFAULT 0,
  force_send               INTEGER NOT NULL DEFAULT 0,
  target_session           TEXT,
  command                  TEXT,               -- type='command' only
  timeout_ms               INTEGER,
  fail_threshold           INTEGER,
  pre_check                TEXT,
  catch_up_max_age_minutes INTEGER,
  stuck_after_minutes      INTEGER,
  requires                 TEXT,               -- JSON blob: {mcp_servers:[...]}
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS schedules_enabled   ON schedules(enabled);
CREATE INDEX IF NOT EXISTS schedules_tenant_id ON schedules(tenant_id);
CREATE INDEX IF NOT EXISTS schedules_agent     ON schedules(agent);
