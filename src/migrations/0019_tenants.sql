-- B2B tenant registry: one row per customer / external organization.
-- The 'default' tenant (id = 'default') is the fleet's own namespace and is
-- pre-seeded here so it is always present without application-level checks.
--
-- disabled_at: NULL = active tenant; non-NULL = disabled (rejected at auth).
--
-- dashboard_users.tenant_id FK is advisory (SQLite has no enforced FK here
-- by default); application logic validates existence before INSERT.

CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  disabled_at  INTEGER
);

INSERT OR IGNORE INTO tenants (id, display_name) VALUES ('default', 'Fleet (default)');
