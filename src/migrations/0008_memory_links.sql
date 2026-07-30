-- Migration 0008: Memory semantic link graph
-- Introduces the memory_links table: a directed weighted edge list between
-- memories. Edges are created automatically by the saveMemory pipeline (F2)
-- when a new memory's embedding is close enough to existing ones.
--
-- link_type values:
--   semantic      -- cosine similarity above threshold (auto-created)
--   explicit      -- user or agent explicitly linked two memories
--   entity        -- both memories share a detected named entity
--   cooccurrence  -- appeared in same conversation window

CREATE TABLE IF NOT EXISTS memory_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type        TEXT    NOT NULL CHECK(link_type IN ('semantic', 'explicit', 'entity', 'cooccurrence')),
  weight           REAL    NOT NULL DEFAULT 1.0 CHECK(weight > 0 AND weight <= 1),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  last_traversed_at INTEGER,
  UNIQUE(src_id, dst_id, link_type)
);

-- Lookup by source (most common: "what does this memory link to?")
CREATE INDEX IF NOT EXISTS idx_memory_links_src  ON memory_links(src_id, weight DESC);
-- Lookup by destination (reverse traversal for hub detection)
CREATE INDEX IF NOT EXISTS idx_memory_links_dst  ON memory_links(dst_id, weight DESC);
-- Maintenance: find stale links (decayed, not traversed recently)
CREATE INDEX IF NOT EXISTS idx_memory_links_traversed ON memory_links(last_traversed_at);
