import Database from 'better-sqlite3'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyMigrations } from '../db-migrations.js'
import { logger } from '../logger.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  return db
}

function tempMigrationsDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-migrations-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf-8')
}

function maxVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')
    .get() as { v: number }
  return row.v
}

function appliedVersions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map(
    r => r.version,
  )
}

// ── 1. Fresh DB: baseline runs, schema_version.MAX() = 1 ────────────────────

describe('fresh DB', () => {
  it('applies the baseline migration and records version 1', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(
        dir,
        '0001_baseline.sql',
        'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      )
      const db = freshDb()
      applyMigrations(db, dir)

      expect(maxVersion(db)).toBe(1)

      // Table created by the migration must exist.
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_table'")
        .get()
      expect(row).toBeTruthy()
    } finally {
      cleanup()
    }
  })
})

// ── 2. Already-migrated DB: no-op ────────────────────────────────────────────

describe('already-migrated DB', () => {
  it('does not re-apply an already recorded migration', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE idempotency_test (id INTEGER PRIMARY KEY);')
      const db = freshDb()

      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Second call must not throw and must not duplicate the version row.
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })
})

// ── 3. Partial: only pending migrations run ───────────────────────────────────

describe('partial migration state', () => {
  it('runs only versions above the current max', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // First: apply only v1 (write just v1 file, then migrate).
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE tbl1 (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Now add v2 and v3; re-running should apply only them.
      writeMigration(dir, '0002_add_name.sql', 'ALTER TABLE tbl1 ADD COLUMN name TEXT;')
      writeMigration(dir, '0003_add_flag.sql', 'ALTER TABLE tbl1 ADD COLUMN active INTEGER DEFAULT 1;')
      applyMigrations(db, dir)

      expect(appliedVersions(db)).toEqual([1, 2, 3])

      // Columns added by v2 and v3 must be usable.
      db.prepare('INSERT INTO tbl1 (name, active) VALUES (?, ?)').run('x', 1)
    } finally {
      cleanup()
    }
  })

  it('starts from the correct version when max=K and new files exist', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE partial_test (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Add v2 migration file after the fact.
      writeMigration(dir, '0002_extend.sql', 'ALTER TABLE partial_test ADD COLUMN val TEXT;')
      applyMigrations(db, dir)

      expect(appliedVersions(db)).toEqual([1, 2])
    } finally {
      cleanup()
    }
  })
})

// ── 4. CRITICAL: bootstrap test ──────────────────────────────────────────────
// Legacy DB: otel_spans present, schema_version absent. applyMigrations must
// record v1 without running the baseline SQL (otel_spans is the sentinel for
// "full schema already applied"). Data in pre-existing tables must be intact.

describe('bootstrap legacy install', () => {
  it('bootstraps to v1 without re-running baseline SQL, preserving existing data', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // The baseline SQL creates a sessions table. On a real legacy install
      // this table already exists; IF NOT EXISTS is safe, but the key guarantee
      // is that schema_version gets recorded as v1 and the migration is not
      // treated as "pending".
      writeMigration(
        dir,
        '0001_baseline.sql',
        [
          'CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL);',
          'CREATE TABLE IF NOT EXISTS otel_spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, agent_id TEXT NOT NULL, operation TEXT NOT NULL, start_ms INTEGER NOT NULL, PRIMARY KEY (trace_id, span_id));',
        ].join('\n'),
      )

      // Simulate legacy DB: otel_spans exists, schema_version does NOT.
      const db = freshDb()
      db.exec(`
        CREATE TABLE sessions (
          chat_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE otel_spans (
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          PRIMARY KEY (trace_id, span_id)
        )
      `)
      // Seed data that must survive the migration call.
      db.prepare('INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)').run(
        'test-chat-1',
        'sess-abc',
        1000000,
      )

      applyMigrations(db, dir)

      // schema_version must now exist and contain version 1.
      expect(maxVersion(db)).toBe(1)
      expect(appliedVersions(db)).toEqual([1])

      // Data must be intact.
      const sess = db.prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get('test-chat-1') as
        | { session_id: string }
        | undefined
      expect(sess?.session_id).toBe('sess-abc')

      // Calling applyMigrations a second time must be a no-op.
      applyMigrations(db, dir)
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })

  it('does NOT bootstrap when otel_spans is absent (treats as genuinely fresh)', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE new_install_check (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      // Neither schema_version nor otel_spans -- genuine fresh install.
      applyMigrations(db, dir)

      // The migration SQL must have run (table exists).
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='new_install_check'")
        .get()
      expect(row).toBeTruthy()
      expect(maxVersion(db)).toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ── 5. Bad SQL: throws, no schema_version entry written ──────────────────────

describe('bad migration SQL', () => {
  it('throws on invalid SQL and does not record the version', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // Apply v1 first (only v1 file exists at this point).
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);')
      const db = freshDb()
      applyMigrations(db, dir)
      expect(appliedVersions(db)).toEqual([1])

      // Now add the broken v2 and expect the next migration run to throw.
      writeMigration(dir, '0002_broken.sql', 'THIS IS NOT VALID SQL;')
      expect(() => applyMigrations(db, dir)).toThrow()

      // schema_version must still only have v1 -- the failed v2 was rolled back.
      expect(appliedVersions(db)).toEqual([1])
    } finally {
      cleanup()
    }
  })
})

// ── 6. memory_links table: migration 0008 creates expected schema ─────────────

describe('memory_links migration', () => {
  it('creates memory_links table with required columns and constraints', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      // Baseline must exist first (schema_version + memories table for FK)
      writeMigration(
        dir,
        '0001_baseline.sql',
        `CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT, topic_key TEXT, content TEXT NOT NULL,
          sector TEXT, salience REAL, category TEXT, agent_id TEXT,
          keywords TEXT, embedding TEXT, embedding_blob BLOB,
          created_at INTEGER DEFAULT (unixepoch()),
          accessed_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER
        );`,
      )
      // 0008 migration SQL (verbatim copy of what we ship)
      const sql0008 = `CREATE TABLE IF NOT EXISTS memory_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id           INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  link_type        TEXT    NOT NULL CHECK(link_type IN ('semantic', 'explicit', 'entity', 'cooccurrence')),
  weight           REAL    NOT NULL DEFAULT 1.0 CHECK(weight > 0 AND weight <= 1),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  last_traversed_at INTEGER,
  UNIQUE(src_id, dst_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_memory_links_src  ON memory_links(src_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_dst  ON memory_links(dst_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_links_traversed ON memory_links(last_traversed_at);`
      writeMigration(dir, '0008_memory_links.sql', sql0008)

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(8)

      // Table exists
      const tableRow = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_links'")
        .get()
      expect(tableRow).toBeTruthy()

      // Indexes exist
      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_links'").all() as { name: string }[]
      ).map(r => r.name)
      expect(indexes).toContain('idx_memory_links_src')
      expect(indexes).toContain('idx_memory_links_dst')

      // UNIQUE constraint: duplicate (src, dst, type) must fail
      db.exec("INSERT INTO memories (id, content) VALUES (1, 'a'), (2, 'b')")
      db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.9)")
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'semantic', 0.8)")
      ).toThrow()

      // CHECK constraint: invalid link_type must fail
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'invalid', 0.5)")
      ).toThrow()

      // CHECK constraint: weight out of range must fail
      expect(() =>
        db.exec("INSERT INTO memory_links (src_id, dst_id, link_type, weight) VALUES (1, 2, 'explicit', 1.5)")
      ).toThrow()
    } finally {
      cleanup()
    }
  })
})

// ── 7. Checksum mismatch: WARNING log, migration continues ───────────────────

describe('checksum mismatch', () => {
  it('emits a warning but does not abort when an applied migration file changed', () => {
    const { dir, cleanup } = tempMigrationsDir()
    // Spy on the pino logger instance exported from logger.ts.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    try {
      const migrationPath = join(dir, '0001_baseline.sql')
      writeMigration(dir, '0001_baseline.sql', 'CREATE TABLE chk_test (id INTEGER PRIMARY KEY);')

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(1)

      // Mutate the migration file after it was applied.
      writeFileSync(migrationPath, 'CREATE TABLE chk_test (id INTEGER PRIMARY KEY, extra TEXT);', 'utf-8')

      // Must not throw, must not re-apply.
      expect(() => applyMigrations(db, dir)).not.toThrow()
      expect(appliedVersions(db)).toEqual([1])

      // logger.warn must have been called with a message about checksum.
      const checksumWarnCalled = warnSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('checksum')),
      )
      expect(checksumWarnCalled).toBe(true)
    } finally {
      warnSpy.mockRestore()
      cleanup()
    }
  })

  it('emits INFO (not WARN) when the mismatch is in KNOWN_SAFE_MISMATCHES (version 4)', () => {
    const { dir, cleanup } = tempMigrationsDir()
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    try {
      // Version 4 is listed in KNOWN_SAFE_MISMATCHES.
      const migrationPath = join(dir, '0004_span_tracing.sql')
      writeMigration(dir, '0004_span_tracing.sql', 'CREATE TABLE safe_chk (id INTEGER PRIMARY KEY);')

      const db = freshDb()
      applyMigrations(db, dir)
      expect(maxVersion(db)).toBe(4)

      // Mutate the file (simulates the post-apply privacy scrub that happened in production).
      writeFileSync(migrationPath, 'CREATE TABLE safe_chk (id INTEGER PRIMARY KEY); -- comment added', 'utf-8')

      infoSpy.mockClear()
      warnSpy.mockClear()

      expect(() => applyMigrations(db, dir)).not.toThrow()
      expect(appliedVersions(db)).toEqual([4])

      // WARN must NOT have been called with a checksum message.
      const checksumWarnCalled = warnSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('checksum')),
      )
      expect(checksumWarnCalled).toBe(false)

      // INFO must have been called with a "known safe" message.
      const safeInfoCalled = infoSpy.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('known safe')),
      )
      expect(safeInfoCalled).toBe(true)
    } finally {
      infoSpy.mockRestore()
      warnSpy.mockRestore()
      cleanup()
    }
  })
})

// ── 8. import shadow migration (0013): schema-only, safe without vec0 ─────────

describe('import shadow migration schema-only', () => {
  it('adds memory_shadow_id column without firing vec_memories_ai trigger', () => {
    const { dir, cleanup } = tempMigrationsDir()
    try {
      const prereqSql = `CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT,
          chat_id TEXT NOT NULL DEFAULT '',
          sector TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          category TEXT CHECK(category IN ('hot','warm','cold','shared')),
          keywords TEXT,
          embedding_blob BLOB,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE import_sources (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          label TEXT,
          interval_hours INTEGER NOT NULL DEFAULT 4,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE import_memories (
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
        );`

      // Phase 1: apply baseline (0001) so that all prerequisite tables exist.
      writeMigration(dir, '0001_baseline.sql', prereqSql)
      const db = freshDb()
      applyMigrations(db, dir)

      // Phase 2: simulate the persistent vec_memories_ai trigger that exists in
      // production SQLite from previous deploys.  Its body aborts on any INSERT
      // INTO memories, mimicking what happens when vec0 is not loaded.  The
      // schema-only 0013 migration must not touch the memories table at all.
      db.exec(
        `CREATE TRIGGER vec_memories_ai
           AFTER INSERT ON memories
         BEGIN
           SELECT raise(ABORT, 'vec0 not loaded -- would crash in production');
         END`,
      )

      // Phase 3: add 0013 to the same dir and re-run.  Version 1 is already
      // recorded so only version 13 is applied.
      writeMigration(
        dir,
        '0013_import_memory_shadow.sql',
        `ALTER TABLE import_memories ADD COLUMN memory_shadow_id INTEGER REFERENCES memories(id);
         CREATE INDEX IF NOT EXISTS idx_import_shadow ON import_memories(memory_shadow_id);`,
      )
      expect(() => applyMigrations(db, dir)).not.toThrow()

      // Column was added to import_memories.
      const cols = db.prepare('PRAGMA table_info(import_memories)').all() as { name: string }[]
      expect(cols.find(c => c.name === 'memory_shadow_id')).toBeTruthy()

      // Index was created.
      const idx = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_import_shadow'")
        .get()
      expect(idx).toBeTruthy()

      // Verify the trigger is still armed -- i.e. the migration never fired it.
      expect(() =>
        db.exec("INSERT INTO memories (content, chat_id, sector) VALUES ('x', 'c', 's')"),
      ).toThrow(/vec0 not loaded/)

      expect(maxVersion(db)).toBe(13)
    } finally {
      cleanup()
    }
  })
})
