-- Migration 0022: add 'stale' and 'assigned' to fleet_blackboard status enum
-- Both tables migrated; runner wraps this in its own transaction (BEGIN/COMMIT
-- must NOT appear here -- see src/db-migrations.ts:95).

-- 1. New fleet_blackboard with extended CHECK constraint
CREATE TABLE fleet_blackboard_new (
  id         TEXT    PRIMARY KEY,
  agent_id   TEXT    NOT NULL UNIQUE,
  task_ref   TEXT,
  status     TEXT    NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'done', 'blocked', 'stale', 'assigned')),
  summary    TEXT    NOT NULL
               CHECK (length(summary) <= 500),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 2. Copy existing rows (explicit column list to surface schema drift at migration time)
INSERT INTO fleet_blackboard_new (id, agent_id, task_ref, status, summary, updated_at)
  SELECT id, agent_id, task_ref, status, summary, updated_at FROM fleet_blackboard;

-- 3. Swap
DROP TABLE fleet_blackboard;
ALTER TABLE fleet_blackboard_new RENAME TO fleet_blackboard;

-- 4. Rebuild indexes
CREATE INDEX idx_fb_agent   ON fleet_blackboard(agent_id);
CREATE INDEX idx_fb_status  ON fleet_blackboard(status);
CREATE INDEX idx_fb_updated ON fleet_blackboard(updated_at DESC);

-- History table: same pattern
CREATE TABLE fleet_blackboard_history_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  task_ref   TEXT,
  status     TEXT    NOT NULL
               CHECK (status IN ('active', 'done', 'blocked', 'stale', 'assigned')),
  summary    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO fleet_blackboard_history_new (id, agent_id, task_ref, status, summary, created_at)
  SELECT id, agent_id, task_ref, status, summary, created_at FROM fleet_blackboard_history;

DROP TABLE fleet_blackboard_history;
ALTER TABLE fleet_blackboard_history_new RENAME TO fleet_blackboard_history;

CREATE INDEX idx_fbh_agent   ON fleet_blackboard_history(agent_id);
CREATE INDEX idx_fbh_created ON fleet_blackboard_history(created_at DESC);
CREATE INDEX idx_fbh_status  ON fleet_blackboard_history(status);
