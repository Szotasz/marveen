-- artifacts: add tenant_id for multi-tenant isolation.
-- Existing rows default to 'default' (the global tenant), matching the
-- behaviour of memories, kanban_cards, and workspace_docs.
ALTER TABLE artifacts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS artifacts_tenant ON artifacts(tenant_id);
