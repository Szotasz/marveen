-- ROLLBACK SCRIPT for migration 0022
-- 'stale' and 'assigned' are derived states (written by cron/delivery-hook, not by users).
-- Rolling back maps them to 'active' -- we lose the finer signal but keep all rows.
-- This rollback is safe to run even after the stale-cron has run.
--
-- Run this manually in sqlite3 against store/claudeclaw.db AFTER stopping the dashboard.
-- Then restart the dashboard (it will re-check migration checksums on boot).

-- Advisory pre-check: shows how many rows will be remapped (not a gate, comment out to skip).
-- SELECT status, count(*) FROM fleet_blackboard
--   WHERE status IN ('stale','assigned') GROUP BY status;
-- SELECT status, count(*) FROM fleet_blackboard_history
--   WHERE status IN ('stale','assigned') GROUP BY status;

BEGIN;

-- Map derived statuses back to 'active' before rebuilding with old constraint.
UPDATE fleet_blackboard SET status = 'active'
  WHERE status IN ('stale', 'assigned');
UPDATE fleet_blackboard_history SET status = 'active'
  WHERE status IN ('stale', 'assigned');

-- Rebuild fleet_blackboard with original 3-value constraint.
CREATE TABLE fleet_blackboard_rollback (
  id         TEXT    PRIMARY KEY,
  agent_id   TEXT    NOT NULL UNIQUE,
  task_ref   TEXT,
  status     TEXT    NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'done', 'blocked')),
  summary    TEXT    NOT NULL
               CHECK (length(summary) <= 500),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO fleet_blackboard_rollback (id, agent_id, task_ref, status, summary, updated_at)
  SELECT id, agent_id, task_ref, status, summary, updated_at FROM fleet_blackboard;
DROP TABLE fleet_blackboard;
ALTER TABLE fleet_blackboard_rollback RENAME TO fleet_blackboard;
CREATE INDEX idx_fb_agent   ON fleet_blackboard(agent_id);
CREATE INDEX idx_fb_status  ON fleet_blackboard(status);
CREATE INDEX idx_fb_updated ON fleet_blackboard(updated_at DESC);

-- History table same way.
CREATE TABLE fleet_blackboard_history_rollback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  task_ref   TEXT,
  status     TEXT    NOT NULL CHECK (status IN ('active', 'done', 'blocked')),
  summary    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO fleet_blackboard_history_rollback (id, agent_id, task_ref, status, summary, created_at)
  SELECT id, agent_id, task_ref, status, summary, created_at FROM fleet_blackboard_history;
DROP TABLE fleet_blackboard_history;
ALTER TABLE fleet_blackboard_history_rollback RENAME TO fleet_blackboard_history;
CREATE INDEX idx_fbh_agent   ON fleet_blackboard_history(agent_id);
CREATE INDEX idx_fbh_created ON fleet_blackboard_history(created_at DESC);
CREATE INDEX idx_fbh_status  ON fleet_blackboard_history(status);

-- Remove migration record so the runner re-runs cleanly on next boot.
DELETE FROM schema_version WHERE version = 22;

COMMIT;
