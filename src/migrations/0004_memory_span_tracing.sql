-- Migration 0004: Memory span tracing
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

-- 4. Version capture is handled explicitly in updateMemory() (db.ts) to avoid
-- ownership corruption: a trigger using NEW.agent_id as changed_by would
-- overwrite the memory owner when a different agent edits it. The explicit
-- approach reads old state first, inserts into memory_versions with the
-- correct changed_by, then performs the UPDATE without touching agent_id.

-- 5. Seed existing memories with a migration-time span_read so the first
-- maintenance run does not mass-demote them to cold. Before span tracing
-- existed these memories were actively used. context=NULL signals a system
-- read (not subject to the heartbeat/search/direct CHECK constraint) and
-- distinguishes seed rows from real agent reads.
-- The read_at timestamp gives each memory a 30-day grace period.
INSERT INTO span_reads (agent_id, memory_id, read_at, context)
SELECT agent_id, id, unixepoch(), NULL
FROM memories;
