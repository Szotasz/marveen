-- Adds RBAC columns to dashboard_users so session-login callers carry an
-- explicit role and tenant scope, consistent with api_tokens.
--
--   role      -- 'admin' | 'agent' | 'read_only' | 'viewer' (DEFAULT viewer)
--   tenant_id -- NULL = global (all tenants); concrete value = tenant-scoped
--
-- Existing rows: the first user by id is promoted to global admin (NULL tenant).
-- All subsequent existing users stay at the viewer default.
-- Fresh installs (no rows yet): handled by the first-user-wins bootstrap in
-- createDashboardUser().

ALTER TABLE dashboard_users ADD COLUMN
  role TEXT NOT NULL DEFAULT 'viewer'
  CHECK(role IN ('admin', 'agent', 'read_only', 'viewer'));

ALTER TABLE dashboard_users ADD COLUMN
  tenant_id TEXT;

-- Promote the first existing user to global admin.
-- Safe when the table is empty: UPDATE with no rows is a no-op.
UPDATE dashboard_users
   SET role = 'admin', tenant_id = NULL
 WHERE id = (SELECT MIN(id) FROM dashboard_users);
