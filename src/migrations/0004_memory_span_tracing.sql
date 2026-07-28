-- Migration 0004: Memory span tracing (issue #37)
-- Adds read-tracing (span_reads) and version history (memory_versions) to the
-- memories system. updated_at column added to memories for stale-read detection.

-- 1. Add updated_at column to memories (backfill from created_at)
ALTER TABLE memories ADD COLUMN updated_at INTEGER;
UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL;

-- 2. Read-trace table: one row per agent read event
CREATE TABLE IF NOT EXISTS span_reads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  read_at    INTEGER NOT NULL,
  context    TEXT    CHECK(context IN ('heartbeat', 'search', 'direct'))
);
CREATE INDEX IF NOT EXISTS idx_span_reads_agent_memory ON span_reads(agent_id, memory_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_span_reads_memory       ON span_reads(memory_id, read_at DESC);

-- 3. Version history table: full content snapshot before each update
CREATE TABLE IF NOT EXISTS memory_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  keywords    TEXT,
  changed_at  INTEGER NOT NULL,
  changed_by  TEXT    NOT NULL,
  change_type TEXT    NOT NULL CHECK(change_type IN ('create', 'update', 'category_change'))
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id, changed_at DESC);

-- 4. Trigger: capture old content into memory_versions before an update
-- Fires when content, category, or keywords change -- not on accessed_at bumps.
CREATE TRIGGER IF NOT EXISTS memories_version_before_update
BEFORE UPDATE ON memories
WHEN OLD.content   != NEW.content
  OR OLD.category  != NEW.category
  OR OLD.keywords  IS NOT NEW.keywords
BEGIN
  INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type)
  VALUES (
    OLD.id,
    OLD.content,
    OLD.category,
    OLD.keywords,
    unixepoch(),
    COALESCE(NEW.agent_id, OLD.agent_id),
    CASE
      WHEN OLD.content != NEW.content AND OLD.category != NEW.category THEN 'update'
      WHEN OLD.category != NEW.category                                THEN 'category_change'
      ELSE 'update'
    END
  );
END;
