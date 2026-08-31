-- skills: SQL-backed skill storage for B2B tenant isolation and fleet-skill SOT.
-- Fleet-internal skills use tenant_id = 'fleet' and is_global = 1.
-- B2B tenant skills use their own tenant_id with is_global = 0 (default).
-- Cross-tenant access is granted explicitly via skill_tenant_access.

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  is_global   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_skills_tenant  ON skills(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_skills_global  ON skills(is_global) WHERE is_global = 1;

-- skill_tenant_access: explicit cross-tenant access grants (admin-only).
-- A skill is visible to a tenant if skill.tenant_id = tenant, OR a row here
-- links the skill to the tenant. Fleet (is_global=1) skills still need an
-- explicit row here to become visible to a B2B tenant.
CREATE TABLE IF NOT EXISTS skill_tenant_access (
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (skill_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sta_tenant ON skill_tenant_access(tenant_id);
