-- Migration 0017: row-level multi-tenancy
--
-- Adds tenant_id to the four core tables and creates the api_tokens table for
-- token lifecycle management (rotation, expiry, revocation).
--
-- vec0 safety: this migration contains ONLY ALTER TABLE ADD COLUMN statements.
-- Only ALTER TABLE ADD COLUMN statements. The sqlite-vec extension is not
-- loaded during migrations, so the AFTER INSERT and AFTER UPDATE OF
-- embedding_blob triggers on memories never fire. vec_memories is untouched.
--
-- Backward-compat: all existing rows receive tenant_id = 'default' via the
-- NOT NULL DEFAULT clause. The running fleet and the current bearer token
-- continue to operate without any configuration change.

-- ── Core table extensions ───────────────────────────────────────────────────

ALTER TABLE memories ADD COLUMN
  tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE kanban_cards ADD COLUMN
  tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE agent_messages ADD COLUMN
  tenant_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE import_memories ADD COLUMN
  tenant_id TEXT NOT NULL DEFAULT 'default';

-- ── Indexes for tenant-scoped query patterns ────────────────────────────────
--
-- Each index leads with tenant_id so the query-scope wrapper (WHERE tenant_id = ?)
-- can use the index for all common access patterns without a full-table scan.

CREATE INDEX IF NOT EXISTS idx_memories_tenant
  ON memories(tenant_id, agent_id, category);

CREATE INDEX IF NOT EXISTS idx_kanban_tenant
  ON kanban_cards(tenant_id, status, archived_at);

CREATE INDEX IF NOT EXISTS idx_agent_msg_tenant
  ON agent_messages(tenant_id, status, to_agent);

CREATE INDEX IF NOT EXISTS idx_import_mem_tenant
  ON import_memories(tenant_id, source_id);

-- ── api_tokens table ────────────────────────────────────────────────────────
--
-- Stores hashed bearer tokens with role and tenant scope. The current
-- file-based bearer token (store/.dashboard-token) receives a bootstrap row
-- in the token-management step; until then the auth-gate fallback treats
-- any unrecognised token hash as admin + default tenant (backward-compat).

CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT    NOT NULL UNIQUE,   -- SHA-256 hex of the raw token
  name          TEXT    NOT NULL,          -- human label, e.g. "default-admin"
  role          TEXT    NOT NULL
                  CHECK(role IN ('admin', 'agent', 'read_only', 'viewer')),
  tenant_id     TEXT    NOT NULL DEFAULT 'default',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                   -- NULL = does not expire
  revoked_at    INTEGER,                   -- NULL = active
  last_used_at  INTEGER,
  rotated_from  INTEGER REFERENCES api_tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant
  ON api_tokens(tenant_id, role, revoked_at);
