-- partner_senders: DB-backed, per-tenant allowlist for external (non-fleet)
-- message senders. Replaces the static SYSTEM_SENDER_IDS env var for B2B
-- partner integrations. SYSTEM_SENDER_IDS is kept for backward compat.
--
-- sender_id is the sanitized agent identifier the partner uses in `from`.
-- tenant_id links to the tenants table (0019); the pair is the PK so a
-- partner may have different sender-ids on different tenants.
-- disabled_at = NULL means active; soft-delete, never hard-delete.

CREATE TABLE IF NOT EXISTS partner_senders (
  sender_id    TEXT    NOT NULL,
  tenant_id    TEXT    NOT NULL,
  display_name TEXT    NOT NULL DEFAULT '',
  created_by   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  disabled_at  INTEGER,
  PRIMARY KEY (sender_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_ps_tenant ON partner_senders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ps_sender ON partner_senders(sender_id);
