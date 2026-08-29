-- workspace_docs: fleet-agent owned working documents (plans, briefs, reports,
-- notes, source code snippets, binary blobs). Tenant-scoped and UPSERT-friendly
-- via the (agent_id, doc_key) unique index.
--
-- Vector index (vec_workspace_docs) is created at runtime by initVecSupport()
-- because vec0 may not be available. No SQL here -- app-level sync only.

CREATE TABLE IF NOT EXISTS workspace_docs (
  id               TEXT    NOT NULL PRIMARY KEY,
  agent_id         TEXT    NOT NULL,
  tenant_id        TEXT    NOT NULL DEFAULT 'default',
  doc_key          TEXT,
  title            TEXT    NOT NULL,
  content          TEXT,
  content_blob     BLOB,
  content_type     TEXT    NOT NULL DEFAULT 'text'
                   CHECK(content_type IN ('text', 'code', 'binary')),
  type             TEXT    NOT NULL DEFAULT 'plan'
                   CHECK(type IN ('plan', 'brief', 'report', 'notes')),
  task_ref         TEXT,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  embedding_blob   BLOB,
  last_accessed_at INTEGER,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_docs_agent_key
  ON workspace_docs(agent_id, doc_key) WHERE doc_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_docs_agent_tenant
  ON workspace_docs(agent_id, tenant_id, type);

CREATE INDEX IF NOT EXISTS workspace_docs_task_ref
  ON workspace_docs(task_ref) WHERE task_ref IS NOT NULL;
