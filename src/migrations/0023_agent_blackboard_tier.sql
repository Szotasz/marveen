CREATE TABLE IF NOT EXISTS agent_blackboard_tier (
  agent_id TEXT PRIMARY KEY,
  tier     TEXT NOT NULL DEFAULT 'default'
    CHECK(tier IN ('orchestrator','interactive','short-running','default'))
);
