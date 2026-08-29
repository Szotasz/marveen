-- Migration 0025: tenant-agent availability matrix + device_key tenant assignment
--
-- tenant_agent_availability: deny-by-default opt-in table.
-- A (tenant_id, agent_id) row with enabled=1 means the tenant can interact
-- with that agent. No row (or enabled=0) means the agent is invisible to that
-- tenant. Global admins bypass this table entirely.
CREATE TABLE IF NOT EXISTS tenant_agent_availability (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, agent_id)
);

-- device_keys: add optional tenant_id so device tokens can be scoped to one
-- tenant. NULL means the key is fleet-wide (legacy behaviour, unchanged).
ALTER TABLE device_keys ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;
