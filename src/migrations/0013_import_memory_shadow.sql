-- Shadow rows for import_memories in the main memories table.
-- Every import_memories entry gets a corresponding row in memories
-- (agent_id='import') so it is picked up by the existing
-- embedding and link-maintenance pipelines without schema changes there.
--
-- NOTE: backfill of existing rows runs at startup AFTER the vec0 extension
-- is loaded (see backfillImportShadowRows in db.ts).  Any INSERT INTO memories
-- before loadSqliteVec() would fire the persistent vec_memories_ai trigger and
-- crash with "no such module: vec0" -- so this migration is schema-only.

ALTER TABLE import_memories ADD COLUMN memory_shadow_id INTEGER REFERENCES memories(id);
CREATE INDEX IF NOT EXISTS idx_import_shadow ON import_memories(memory_shadow_id);
