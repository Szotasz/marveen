-- #ad5c6f0d: import memories -- external file sources (local FS, Google Drive, SharePoint)
-- ingested as a separate memory tier, deduplicated by content hash.

CREATE TABLE IF NOT EXISTS import_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('local', 'gdrive', 'sharepoint')),
  path TEXT NOT NULL,
  label TEXT,
  interval_hours INTEGER NOT NULL DEFAULT 4,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_memories (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES import_sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_import_memories_source ON import_memories(source_id);
CREATE INDEX IF NOT EXISTS idx_import_memories_hash ON import_memories(content_hash);

-- Audit log: one row per crawl run, records what happened and why files were skipped.
CREATE TABLE IF NOT EXISTS import_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES import_sources(id) ON DELETE CASCADE,
  run_at INTEGER NOT NULL,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_added INTEGER NOT NULL DEFAULT 0,
  files_updated INTEGER NOT NULL DEFAULT 0,
  files_skipped_hash INTEGER NOT NULL DEFAULT 0,
  files_skipped_secret INTEGER NOT NULL DEFAULT 0,
  files_skipped_size INTEGER NOT NULL DEFAULT 0,
  files_skipped_type INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_audit_source ON import_audit_log(source_id, run_at DESC);
