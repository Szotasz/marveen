-- Add tenant_id to approvals so B2B tenant users can be scoped to their own
-- approval requests. NULL means fleet-global (admin / bearer-token callers).
ALTER TABLE approvals ADD COLUMN tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id, requested_at);
