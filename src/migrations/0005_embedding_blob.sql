-- Store vector embeddings as compact Float32 binary instead of JSON text.
-- The TEXT column is kept for schema compatibility but nulled out after migration.
ALTER TABLE memories ADD COLUMN embedding_blob BLOB;
