-- Fleet shared blackboard: agents post their current task/status for fleet-wide visibility.
-- SCHEMA ONLY -- no INSERT/UPDATE, no vec0 dependency.
-- Each agent has at most one active row; PATCH updates it in place.

CREATE TABLE IF NOT EXISTS fleet_blackboard (
  id         TEXT    PRIMARY KEY,                  -- UUID v4 short (8 hex chars)
  agent_id   TEXT    NOT NULL UNIQUE,              -- one row per agent (upsert target)
  task_ref   TEXT,                                 -- optional kanban card id or free-form ref
  status     TEXT    NOT NULL DEFAULT 'active'     -- 'active' | 'done' | 'blocked'
               CHECK (status IN ('active', 'done', 'blocked')),
  summary    TEXT    NOT NULL                      -- max 500 chars enforced at API layer
               CHECK (length(summary) <= 500),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fb_agent     ON fleet_blackboard(agent_id);
CREATE INDEX IF NOT EXISTS idx_fb_status    ON fleet_blackboard(status);
CREATE INDEX IF NOT EXISTS idx_fb_updated   ON fleet_blackboard(updated_at DESC);
