-- Migration 0001: Baseline schema snapshot
-- This is the canonical "fresh install" schema: all tables in their final
-- column layout (ALTER TABLE history collapsed in). Existing installs are
-- bootstrapped to this version via otel_spans sentinel detection and never
-- run this SQL (it would be a no-op anyway due to IF NOT EXISTS guards).

-- ── schema_version ────────────────────────────────────────────────────────────
-- Tracked by the migration runner; included here so a fresh install always has
-- the table regardless of execution order.
CREATE TABLE IF NOT EXISTS schema_version (
  version      INTEGER PRIMARY KEY,
  applied_at   INTEGER NOT NULL,
  description  TEXT NOT NULL,
  checksum     TEXT
);

-- ── sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  chat_id       TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

-- ── memories ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT NOT NULL,
  topic_key      TEXT,
  content        TEXT NOT NULL,
  sector         TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
  salience       REAL NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL,
  accessed_at    INTEGER NOT NULL,
  agent_id       TEXT NOT NULL DEFAULT 'marveen',
  category       TEXT NOT NULL DEFAULT 'warm' CHECK(category IN ('hot','warm','cold','shared')),
  auto_generated INTEGER NOT NULL DEFAULT 0,
  keywords       TEXT,
  embedding      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  keywords,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

-- ── scheduled_tasks ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  schedule   TEXT NOT NULL,
  next_run   INTEGER NOT NULL,
  last_run   INTEGER,
  last_result TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run);

-- ── kanban_cards ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_cards (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'planned'
                 CHECK(status IN ('planned','in_progress','testing','waiting','done')),
  assignee     TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal'
                 CHECK(priority IN ('low','normal','high','urgent')),
  project      TEXT,
  due_date     INTEGER,
  sort_order   REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  parent_id    TEXT REFERENCES kanban_cards(id),
  dispatched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id);
CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at);

-- ── conversation_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text       TEXT,
  ts         TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, chat_id, direction, message_id)
);
CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at);

-- ── daily_logs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(agent_id, date);

-- ── kanban_comments ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL,
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id);

-- ── kanban_card_events ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_card_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kanban_events_card ON kanban_card_events(card_id, created_at);

-- ── labels ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── kanban_card_labels ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kanban_card_labels (
  card_id    TEXT NOT NULL,
  label_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_card_labels_label ON kanban_card_labels(label_id);

-- ── agent_messages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  content        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','delivered','done','failed')),
  result         TEXT,
  created_at     INTEGER NOT NULL,
  delivered_at   INTEGER,
  completed_at   INTEGER,
  origin_note    TEXT,
  trace_id       TEXT,
  span_id        TEXT,
  parent_span_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_agent);
CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(from_agent, to_agent, created_at);

-- ── pending_channel_requests ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_channel_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  channel_name TEXT,
  user_id      TEXT,
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','approved','denied'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_agent_channel
  ON pending_channel_requests(agent, channel_id) WHERE status = 'pending';

-- ── task_runs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_runs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  agent  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'fired'
);
CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(ts);

-- ── pending_task_retries ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_task_retries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name     TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  first_attempt INTEGER NOT NULL,
  last_attempt  INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_reason   TEXT,
  alert_sent_at INTEGER,
  UNIQUE(task_name, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_pending_retries_first_attempt ON pending_task_retries(first_attempt);

-- ── background_tasks ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS background_tasks (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK(status IN ('running','done','failed','timeout')),
  tmux_session TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  output       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent ON background_tasks(agent_id, status);

-- ── token_usage ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent                 TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  timestamp             INTEGER NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  model                 TEXT,
  content_preview       TEXT,
  tool_name             TEXT,
  task_title            TEXT,
  project               TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent);
CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts ON token_usage(agent, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup
  ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);

-- ── token_usage_cursors ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage_cursors (
  file_path  TEXT PRIMARY KEY,
  last_line  INTEGER NOT NULL DEFAULT 0,
  last_size  INTEGER NOT NULL DEFAULT 0
);

-- ── idea_box ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idea_box (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'Egyéb',
  status      TEXT NOT NULL DEFAULT 'new'
                CHECK(status IN ('new','reviewed','kanban','rejected')),
  source      TEXT NOT NULL DEFAULT 'marveen',
  kanban_id   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  impact      INTEGER,
  effort      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_idea_box_status ON idea_box(status);
CREATE INDEX IF NOT EXISTS idx_idea_box_category ON idea_box(category);

-- ── idea_comments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idea_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id    TEXT NOT NULL,
  author     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idea_comments_idea ON idea_comments(idea_id);

-- ── idea_status_log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idea_status_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idea_status_log_idea ON idea_status_log(idea_id, created_at);

-- ── tool_call_log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  input_summary TEXT,
  success       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  agent_id      TEXT,
  trace_id      TEXT,
  duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_call_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_log_ts ON tool_call_log(created_at);

-- ── skill_usage ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  skill_name   TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('tool_call','skill_read')),
  session_id   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_agent ON skill_usage(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_name, created_at);

-- ── config_change_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_change_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  actor      TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_change_log_key ON config_change_log(key, created_at);

-- ── store_file_audit ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_file_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  file_size    INTEGER,
  agent        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_file_audit_ts ON store_file_audit(created_at);

-- ── cost_sources ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_sources (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  source_type TEXT NOT NULL,
  account_ref TEXT,
  currency    TEXT NOT NULL DEFAULT 'HUF',
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ── cost_line_items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_line_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id            TEXT NOT NULL REFERENCES cost_sources(id),
  charge_period_start  INTEGER NOT NULL,
  charge_period_end    INTEGER NOT NULL,
  charge_category      TEXT NOT NULL,
  service_name         TEXT,
  usage_type           TEXT,
  consumed_quantity    REAL,
  consumed_unit        TEXT,
  billed_cost          REAL NOT NULL,
  effective_cost       REAL,
  currency             TEXT NOT NULL DEFAULT 'HUF',
  confidence           TEXT NOT NULL,
  data_freshness       INTEGER NOT NULL,
  source_ref           TEXT,
  dedup_key            TEXT UNIQUE,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_line_items_period
  ON cost_line_items(charge_period_start, charge_period_end);
CREATE INDEX IF NOT EXISTS idx_cost_line_items_source ON cost_line_items(source_id);

-- ── vault_ssh_keys ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_ssh_keys (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  username    TEXT NOT NULL,
  vault_key_id TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_type    TEXT NOT NULL DEFAULT 'ed25519',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_ssh_keys_label ON vault_ssh_keys(label);

-- ── vault_ssh_servers ─────────────────────────────────────────────────────────
-- Legacy per-server key columns (key_type, fingerprint, vault_key_id,
-- key_expires_at) are not included; they were dropped in a 2026-07-01 migration.
CREATE TABLE IF NOT EXISTS vault_ssh_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL DEFAULT 22,
  username    TEXT NOT NULL,
  ssh_key_id  TEXT REFERENCES vault_ssh_keys(id),
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_ssh_servers_name ON vault_ssh_servers(name);
CREATE INDEX IF NOT EXISTS idx_vault_ssh_servers_key ON vault_ssh_servers(ssh_key_id);

-- ── approvals ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL,
  category           TEXT NOT NULL,
  action_description TEXT NOT NULL,
  action_payload     TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','approved','rejected','timeout')),
  timeout_at         INTEGER,
  telegram_message_id INTEGER,
  requested_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at        INTEGER,
  resolved_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id, requested_at);

-- ── dashboard_users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dashboard_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0
);

-- ── auth_sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  username     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  remote_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

-- ── device_keys ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at  INTEGER
);

-- ── otel_spans ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otel_spans (
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,
  parent_span_id TEXT,
  agent_id       TEXT NOT NULL,
  operation      TEXT NOT NULL,
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER,
  status         TEXT NOT NULL DEFAULT 'ok'
                   CHECK(status IN ('ok','error','timeout','running')),
  attributes     TEXT,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_otel_spans_agent ON otel_spans(agent_id, start_ms);
