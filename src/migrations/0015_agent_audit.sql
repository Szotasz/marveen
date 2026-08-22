-- Agent-level audit log and backup restore log.
-- SCHEMA ONLY -- no INSERT/UPDATE, no vec0 dependency.
-- Safe to run before the sqlite-vec extension loads (no triggers referencing vec0).

-- agent_audit_log: records agent-initiated write operations on core entities
-- (memories, kanban cards, messages, agent config). Actor is always an agent_id.
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT    NOT NULL,
  entity      TEXT    NOT NULL, -- 'memory' | 'kanban' | 'message' | 'agent'
  action      TEXT    NOT NULL, -- 'create' | 'update' | 'delete'
  entity_id   TEXT,             -- row id of the affected record (string for flexibility)
  detail      TEXT,             -- JSON blob with relevant fields (key, tier, status, etc.)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_aal_agent    ON agent_audit_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_entity   ON agent_audit_log(entity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_created  ON agent_audit_log(created_at DESC);

-- restore_log: records every DB restore attempt (success or failure).
-- Written by verify-restore.sh and any future restore tooling.
CREATE TABLE IF NOT EXISTS restore_log (
  id            INTEGER PRIMARY KEY,
  archive_path  TEXT    NOT NULL,
  checksum      TEXT,             -- sha256 of the archive at restore time
  integrity_ok  INTEGER NOT NULL, -- 1 = PRAGMA integrity_check passed, 0 = failed
  restored_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  note          TEXT              -- free-form, e.g. error message or trigger reason
);

CREATE INDEX IF NOT EXISTS idx_rl_restored ON restore_log(restored_at DESC);
