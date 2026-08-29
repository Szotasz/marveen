import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Migrations live next to this source file (src/ in dev, dist/ when compiled).
// The build step copies src/migrations/ → dist/migrations/ verbatim.
// Tests may pass a custom directory via the second argument of applyMigrations.
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations')

// ── schema_version DDL ──────────────────────────────────────────────────────
const CREATE_SCHEMA_VERSION = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT    NOT NULL,
    checksum    TEXT
  )
`

// ── helpers ─────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/** True when the named table exists in the database. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { 1: number } | undefined
  return row !== undefined
}

/** Sorted list of migration files: [{version, description, path, sql}] */
interface MigrationFile {
  version: number
  description: string
  path: string
  sql: string
}

function loadMigrationFiles(dir: string): MigrationFile[] {
  let filenames: string[]
  try {
    filenames = readdirSync(dir)
  } catch (err) {
    throw new Error(`Cannot read migrations directory ${dir}: ${err}`)
  }

  // Accept files named NNNN_description.sql (4+ digit version prefix)
  const pattern = /^(\d{4,})_(.+)\.sql$/
  const files: MigrationFile[] = []

  for (const filename of filenames) {
    const match = pattern.exec(filename)
    if (!match) continue
    const version = parseInt(match[1], 10)
    const description = match[2].replace(/-/g, ' ')
    const path = join(dir, filename)
    const sql = readFileSync(path, 'utf-8')
    files.push({ version, description, path, sql })
  }

  files.sort((a, b) => a.version - b.version)
  return files
}

// ── bootstrap detection ──────────────────────────────────────────────────────

/**
 * Detects an existing install that pre-dates schema versioning.
 * Strategy: if `otel_spans` (the last table created in initDatabase) exists
 * but `schema_version` does not, this is a legacy database that already has
 * the full baseline schema applied via the old ALTER TABLE / CREATE TABLE
 * approach. We record version 1 as already applied without running the SQL.
 */
function bootstrapLegacyInstall(db: Database.Database, baseline: MigrationFile): void {
  logger.info('Detected legacy install (otel_spans present, no schema_version). Bootstrapping to v1.')
  db.prepare(`
    INSERT OR IGNORE INTO schema_version (version, applied_at, description, checksum)
    VALUES (?, ?, ?, ?)
  `).run(baseline.version, Math.floor(Date.now() / 1000), baseline.description, sha256(baseline.sql))
}

// ── apply a single migration ─────────────────────────────────────────────────

function applyMigration(db: Database.Database, m: MigrationFile): void {
  // Wrap SQL + schema_version INSERT in one transaction. If the SQL throws, the
  // version row is never written; the error propagates to the caller.
  const tx = db.transaction(() => {
    db.exec(m.sql)
    db.prepare(`
      INSERT INTO schema_version (version, applied_at, description, checksum)
      VALUES (?, ?, ?, ?)
    `).run(m.version, Math.floor(Date.now() / 1000), m.description, sha256(m.sql))
  })
  tx()
  logger.info({ version: m.version, description: m.description }, 'Migration applied')
}

// ── checksum guard ───────────────────────────────────────────────────────────

/**
 * Known-safe checksum mismatches: migrations whose SQL was edited after
 * application for non-schema reasons (comment cleanup, privacy scrub, etc.).
 * A mismatch on a listed version logs at INFO instead of WARN, because the
 * edit was deliberate and reviewed. Every entry must document the reason so
 * a future reader can distinguish it from an accidental edit.
 */
const KNOWN_SAFE_MISMATCHES: Record<number, string> = {
  4: 'Privacy scrub 2026-07-29: agent-name removed from seed comment. No schema change.',
}

/**
 * Warns (non-blocking) when the on-disk SQL differs from the recorded checksum.
 * This catches accidental edits to already-applied migrations. We warn and
 * continue rather than aborting because the schema change already happened.
 * Mismatches listed in KNOWN_SAFE_MISMATCHES are downgraded to INFO.
 */
function warnChecksumMismatch(
  db: Database.Database,
  m: MigrationFile,
): void {
  const row = db
    .prepare('SELECT checksum FROM schema_version WHERE version = ?')
    .get(m.version) as { checksum: string | null } | undefined
  if (!row || row.checksum === null) return
  const current = sha256(m.sql)
  if (current !== row.checksum) {
    const safeReason = KNOWN_SAFE_MISMATCHES[m.version]
    if (safeReason) {
      logger.info(
        { version: m.version, reason: safeReason },
        'Migration SQL updated after apply (known safe): checksum differs but schema is unchanged.',
      )
    } else {
      logger.warn(
        { version: m.version, expected: row.checksum, actual: current },
        'Migration checksum mismatch -- file was modified after being applied. Continuing.',
      )
    }
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Applies all pending migrations to `db`.
 *
 * Call this once, right after the database is opened and before any business
 * logic runs. Safe to call on an already-current database (no-op).
 *
 * `migrationsDir` overrides the default directory (next to this file).
 * Tests use this to supply custom SQL without touching the real migration files.
 */
export function applyMigrations(db: Database.Database, migrationsDir?: string): void {
  const dir = migrationsDir ?? DEFAULT_MIGRATIONS_DIR

  // Check before CREATE so we know if this is a first-ever call.
  const schemaVersionPreExisted = tableExists(db, 'schema_version')
  db.exec(CREATE_SCHEMA_VERSION)

  const files = loadMigrationFiles(dir)
  if (files.length === 0) {
    logger.warn({ dir }, 'No migration files found')
    return
  }

  const baseline = files[0]

  // Bootstrap detection: otel_spans sentinel marks a pre-versioning install.
  // If schema_version did NOT exist yet but otel_spans is present, this DB
  // already has the full baseline schema (applied by the old ALTER TABLE path).
  // Record version 1 without re-running the SQL -- it would hit IF NOT EXISTS
  // guards anyway, but the explicit bootstrap avoids the full file I/O and is
  // unambiguous about intent.
  if (!schemaVersionPreExisted && tableExists(db, 'otel_spans')) {
    if (baseline) bootstrapLegacyInstall(db, baseline)
  }

  // Determine the highest version already applied.
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS max_v FROM schema_version')
    .get() as { max_v: number }
  const currentVersion = row.max_v

  for (const m of files) {
    if (m.version <= currentVersion) {
      // Already applied: verify checksum but do not re-run.
      warnChecksumMismatch(db, m)
      continue
    }
    // Pending: apply it. Any error propagates up — the caller must decide
    // whether to abort the process (production) or fail the test.
    applyMigration(db, m)
  }
}
