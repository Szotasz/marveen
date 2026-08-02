-- Migration 0010: FTS5 full-text search index for artifacts
-- Indexes title, meta (JSON bag), and the textual body of non-binary artifacts.
-- Uses an external-content FTS5 table (content='') with contentless_delete=1
-- so that the trigger-managed index does not depend on column order of the
-- backing `artifacts` table (which stores `content` as a BLOB).
--
-- Search: GET /api/artifacts?q=term  resolves to FTS5 MATCH on this table,
-- returning rowid matches joined back to artifacts for the full row.

CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  title,
  meta,
  body,
  content=''
);

-- Sync triggers: INSERT
CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, title, meta, body)
  VALUES (
    new.rowid,
    new.title,
    new.meta,
    CASE WHEN new.kind IN ('html', 'markdown', 'json', 'text')
         THEN CAST(new.content AS TEXT)
         ELSE ''
    END
  );
END;

-- Sync triggers: DELETE (content='' external FTS5: must supply all indexed column values)
CREATE TRIGGER IF NOT EXISTS artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, meta, body)
  VALUES (
    'delete',
    old.rowid,
    old.title,
    old.meta,
    CASE WHEN old.kind IN ('html', 'markdown', 'json', 'text')
         THEN CAST(old.content AS TEXT)
         ELSE ''
    END
  );
END;

-- Sync triggers: UPDATE (delete old entry by all values, then re-insert)
CREATE TRIGGER IF NOT EXISTS artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, meta, body)
  VALUES (
    'delete',
    old.rowid,
    old.title,
    old.meta,
    CASE WHEN old.kind IN ('html', 'markdown', 'json', 'text')
         THEN CAST(old.content AS TEXT)
         ELSE ''
    END
  );
  INSERT INTO artifacts_fts(rowid, title, meta, body)
  VALUES (
    new.rowid,
    new.title,
    new.meta,
    CASE WHEN new.kind IN ('html', 'markdown', 'json', 'text')
         THEN CAST(new.content AS TEXT)
         ELSE ''
    END
  );
END;
