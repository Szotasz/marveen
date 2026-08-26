-- Append-only audit trail for fleet_blackboard state transitions.
-- Written at the API layer (upsert and patch) so every write is unit-testable
-- without SQL triggers.

CREATE TABLE IF NOT EXISTS fleet_blackboard_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  task_ref   TEXT,
  status     TEXT    NOT NULL CHECK (status IN ('active', 'done', 'blocked')),
  summary    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fbh_agent   ON fleet_blackboard_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_fbh_created ON fleet_blackboard_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fbh_status  ON fleet_blackboard_history(status);
