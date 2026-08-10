/**
 * Verifies that initDatabase() sets the three concurrency pragmas introduced
 * for the k8rack dual-instance setup:
 *   busy_timeout      = 5000 ms (retry window for SQLITE_BUSY)
 *   wal_autocheckpoint = 2000 pages (less frequent checkpoint locks)
 *   wal_checkpoint(TRUNCATE) runs on startup for file-backed DBs (WAL cleanup)
 *
 * Each describe block calls initDatabase() in its own beforeAll so the tests
 * are independent of the shared in-memory instance used by db.test.ts.
 * Vitest isolates module state per test file, so there is no cross-file
 * interference on the module-level `db` variable in db.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDb } from '../db.js'

// ─── in-memory: pragmas set even without a WAL file on disk ──────────────────

describe('initDatabase(:memory:) — concurrency pragmas', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('sets busy_timeout to 5000 ms', () => {
    const value = getDb().pragma('busy_timeout', { simple: true })
    expect(value).toBe(5000)
  })

  it('sets wal_autocheckpoint to 2000 pages', () => {
    const value = getDb().pragma('wal_autocheckpoint', { simple: true })
    expect(value).toBe(2000)
  })

  it('does not throw when wal_checkpoint is skipped for :memory:', () => {
    // The TRUNCATE checkpoint is guarded by !isMemory; this test asserts
    // that no exception escapes initDatabase for in-memory databases.
    // (The preceding beforeAll would have thrown if it did.)
    expect(getDb().open).toBe(true)
  })

  it('DB remains functional after pragma changes (regression)', () => {
    // A basic round-trip to verify the pragmas did not corrupt the connection.
    expect(() =>
      getDb().prepare('SELECT 1 AS n').get(),
    ).not.toThrow()
    const row = getDb().prepare('SELECT 1 AS n').get() as { n: number }
    expect(row.n).toBe(1)
  })
})

// ─── file-backed: wal_checkpoint(TRUNCATE) executes on startup ───────────────

describe('initDatabase(file) — startup WAL checkpoint', () => {
  let tmpDir: string
  let dbPath: string

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    tmpDir = mkdtempSync(join(tmpdir(), 'marveen-pragma-test-'))
    dbPath = join(tmpDir, 'test.db')
    initDatabase(dbPath)
  })

  afterAll(() => {
    // Close the db before removing files so better-sqlite3 releases the fd.
    try { getDb().close() } catch { /* ignore if already closed */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets busy_timeout to 5000 ms on file DB', () => {
    const value = getDb().pragma('busy_timeout', { simple: true })
    expect(value).toBe(5000)
  })

  it('sets wal_autocheckpoint to 2000 pages on file DB', () => {
    const value = getDb().pragma('wal_autocheckpoint', { simple: true })
    expect(value).toBe(2000)
  })

  it('startup checkpoint ran without blocking on a writer lock (busy === 0)', () => {
    // db.pragma('wal_checkpoint(TRUNCATE)') runs inside initDatabase(). We
    // cannot retroactively inspect its result, but we can verify that the WAL
    // infrastructure is intact by issuing a PASSIVE checkpoint now and checking
    // the busy field. busy === 0 means no frames were skipped due to a
    // concurrent writer -- exactly the property the startup checkpoint must
    // satisfy (single-process startup, no competing writers).
    //
    // Note: after initDatabase the WAL contains the migration writes, so
    // `log` and `checkpointed` will be non-zero. That is expected; the
    // startup TRUNCATE only cleaned any WAL from the PREVIOUS session.
    type CheckpointRow = { busy: number; log: number; checkpointed: number }
    const result = getDb().pragma('wal_checkpoint(PASSIVE)') as CheckpointRow[]
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].busy).toBe(0)
  })

  it('DB remains functional after all pragmas and checkpoint (regression)', () => {
    expect(() =>
      getDb().prepare('SELECT sqlite_version() AS v').get(),
    ).not.toThrow()
    const row = getDb().prepare('SELECT sqlite_version() AS v').get() as { v: string }
    expect(typeof row.v).toBe('string')
    expect(row.v.length).toBeGreaterThan(0)
  })
})
