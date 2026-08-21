-- Shadow rows for import_memories in the main memories table.
-- Every import_memories entry gets a corresponding row in memories
-- (agent_id='import') so it is picked up by the existing
-- embedding and link-maintenance pipelines without schema changes there.

ALTER TABLE import_memories ADD COLUMN memory_shadow_id INTEGER REFERENCES memories(id);
CREATE INDEX IF NOT EXISTS idx_import_shadow ON import_memories(memory_shadow_id);

-- Backfill: create shadow rows for any existing import_memories entries.
-- Shadow rows use agent_id='import' as the discriminator (category='warm' so
-- it satisfies the existing CHECK constraint).  chat_id and sector are
-- sentinel values required by the NOT NULL constraints on the base schema.
INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
SELECT 'import', im.content, 'warm', im.keywords, 'import', 'semantic', im.updated_at, im.updated_at, im.updated_at
FROM import_memories im
WHERE im.memory_shadow_id IS NULL;

UPDATE import_memories
SET memory_shadow_id = (
  SELECT m.id FROM memories m
  WHERE m.agent_id = 'import'
    AND m.category = 'warm'
    AND m.content = import_memories.content
    AND m.created_at = import_memories.updated_at
  LIMIT 1
)
WHERE memory_shadow_id IS NULL;
