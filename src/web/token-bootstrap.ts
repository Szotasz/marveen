// Enrolls the file-based dashboard bearer token into the api_tokens table on
// first boot. After enrollment the DB-lookup path in auth-gate.ts resolves it
// with explicit role=admin and default tenant; the legacy file-token fallback
// still runs for any token NOT in the DB, keeping rollback trivial.
//
// Idempotent: INSERT OR IGNORE -- the UNIQUE constraint on token_hash means a
// second call (restart, redeploy) is a no-op with zero side effects.
//
// Rollback: DELETE FROM api_tokens WHERE name = 'dashboard'
// The fallback in auth-gate.ts (step 2 in the precedence list) immediately
// takes over -- no server restart required.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'

export function bootstrapDashboardToken(rawToken: string, db: Database.Database): void {
  try {
    const hash = createHash('sha256').update(rawToken).digest('hex')
    const now = Math.floor(Date.now() / 1000)
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO api_tokens
           (token_hash, name, role, created_at)
         VALUES (?, 'dashboard', 'admin', ?)`,
      )
      .run(hash, now)
    if (info.changes > 0) {
      logger.info('api_tokens: dashboard token enrolled (role=admin, no expiry)')
    }
  } catch (err) {
    // Non-fatal: the legacy file-token fallback in auth-gate.ts keeps working.
    logger.warn({ err }, 'api_tokens: dashboard token bootstrap failed -- using file-token fallback')
  }
}
