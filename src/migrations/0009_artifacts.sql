-- Migration 0009: Artifact store
-- Persists Claude Artifact objects (HTML, Markdown, JSON, plain text, binary)
-- directly in the SQLite database instead of loose files or cloud storage.
-- The `content` column holds the raw bytes as a BLOB; mime carries the
-- Content-Type for serving. `meta` is an open JSON bag for optional fields
-- (e.g. description, tags, size hint, source URL).

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  agent_id    TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK(kind IN ('html', 'markdown', 'json', 'text', 'binary')),
  mime        TEXT    NOT NULL DEFAULT 'application/octet-stream',
  content     BLOB    NOT NULL,
  meta        TEXT    NOT NULL DEFAULT '{}',
  source      TEXT,
  -- Populated only for cloud-synced artifacts (source = 'cloud:artifact').
  -- UNIQUE so POST /api/artifacts can UPSERT on cloud_url without duplicates.
  cloud_url   TEXT    UNIQUE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- List by agent, ordered newest-first
CREATE INDEX IF NOT EXISTS idx_artifacts_agent_created ON artifacts(agent_id, created_at DESC);
-- Filter by kind (e.g. list all HTML artifacts)
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
-- Fast lookup by cloud URL for UPSERT deduplication
CREATE INDEX IF NOT EXISTS idx_artifacts_cloud_url ON artifacts(cloud_url) WHERE cloud_url IS NOT NULL;

-- Keep updated_at current on every UPDATE
CREATE TRIGGER IF NOT EXISTS artifacts_updated_at
  AFTER UPDATE ON artifacts
  FOR EACH ROW
  BEGIN
    UPDATE artifacts SET updated_at = unixepoch() WHERE id = NEW.id;
  END;
