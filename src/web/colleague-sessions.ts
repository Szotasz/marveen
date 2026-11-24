// Browser sessions for colleague board accounts (colleague-accounts.ts).
//
// Deliberately NOT the owner's session store (auth-sessions.ts, cookie
// mv_session): a colleague session has its own cookie (mv_colleague), its own
// table and its own AuthResult kind ('colleague'), so no owner check can ever
// mistake it for the owner. mayActAsOwner trusts kind 'session' and the
// mv_session cookie only; neither is produced here.
//
// A session id is 32 random bytes (base64url) in an HttpOnly, SameSite=Strict
// cookie. Only sha256(id) is stored, so a database copy yields no usable cookie.
// Sessions survive a dashboard restart (they live in SQLite), and every request
// re-checks the account behind them: a deleted, disabled or password-reset
// account (generation bump) ends the session on its next request.
//
// TTLs, server-authoritative whatever the cookie's Max-Age says:
//   idle      12 hours from the last request (a workday; the next morning signs in again)
//   absolute   7 days from the login

import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { liveColleagueAccount } from './colleague-accounts.js'

export const COLLEAGUE_COOKIE_NAME = 'mv_colleague'
export const COLLEAGUE_IDLE_TTL_SEC = 12 * 60 * 60
export const COLLEAGUE_ABSOLUTE_TTL_SEC = 7 * 24 * 60 * 60
const LAST_SEEN_DEBOUNCE_SEC = 60

export interface ResolvedColleague {
  username: string
  person: string
}

// The table is this module's own; created on first use, once per database handle
// (tests re-open ':memory:' databases).
const ensured = new WeakSet<Database.Database>()
function db(): Database.Database {
  const d = getDb()
  if (!ensured.has(d)) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS colleague_sessions (
        id_hash      TEXT PRIMARY KEY,
        username     TEXT NOT NULL,
        generation   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent   TEXT
      )
    `)
    d.exec('CREATE INDEX IF NOT EXISTS idx_colleague_sessions_user ON colleague_sessions(username)')
    ensured.add(d)
  }
  return d
}

function sha256hex(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** Mint a session at a successful login only (never from a client-supplied value). Returns the raw cookie value. */
export function createColleagueSession(username: string, generation: number, opts: { userAgent?: string | null } = {}): string {
  const token = randomBytes(32).toString('base64url')
  const now = nowSec()
  db().prepare('INSERT INTO colleague_sessions (id_hash, username, generation, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256hex(token), username, generation, now, now, (opts.userAgent ?? '').slice(0, 200) || null)
  return token
}

/**
 * The colleague behind a cookie value, or null. Null when the session is
 * unknown or past a TTL, or when its account is gone, disabled, or had its
 * password reset since the login. A dead session row is removed on the way.
 */
export function resolveColleagueSession(cookieValue: string, accountsPath?: string): ResolvedColleague | null {
  if (!cookieValue || cookieValue.length > 128) return null
  const idHash = sha256hex(cookieValue)
  const row = db().prepare('SELECT username, generation, created_at, last_seen_at FROM colleague_sessions WHERE id_hash = ?')
    .get(idHash) as { username: string; generation: number; created_at: number; last_seen_at: number } | undefined
  if (!row) return null
  const now = nowSec()
  const account = liveColleagueAccount(row.username, row.generation, accountsPath)
  if (!account || now - row.created_at > COLLEAGUE_ABSOLUTE_TTL_SEC || now - row.last_seen_at > COLLEAGUE_IDLE_TTL_SEC) {
    db().prepare('DELETE FROM colleague_sessions WHERE id_hash = ?').run(idHash)
    return null
  }
  if (now - row.last_seen_at >= LAST_SEEN_DEBOUNCE_SEC) {
    db().prepare('UPDATE colleague_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash)
  }
  return { username: account.username, person: account.person }
}

export function revokeColleagueSession(cookieValue: string): void {
  if (!cookieValue) return
  db().prepare('DELETE FROM colleague_sessions WHERE id_hash = ?').run(sha256hex(cookieValue))
}

/** Every session of one account (the generation check already refuses them; this also clears the rows). */
export function revokeColleagueSessionsFor(username: string): number {
  return db().prepare('DELETE FROM colleague_sessions WHERE username = ?').run(username).changes
}

/** Every colleague session at once (security:reset). */
export function revokeAllColleagueSessions(): number {
  return db().prepare('DELETE FROM colleague_sessions').run().changes
}

export function sweepExpiredColleagueSessions(): number {
  const now = nowSec()
  return db().prepare('DELETE FROM colleague_sessions WHERE last_seen_at < ? OR created_at < ?')
    .run(now - COLLEAGUE_IDLE_TTL_SEC, now - COLLEAGUE_ABSOLUTE_TTL_SEC).changes
}

/** Test seam: age a session without sleeping. */
export function _ageColleagueSessionForTest(cookieValue: string, fields: { createdAt?: number; lastSeenAt?: number }): void {
  const h = sha256hex(cookieValue)
  if (fields.createdAt !== undefined) db().prepare('UPDATE colleague_sessions SET created_at = ? WHERE id_hash = ?').run(fields.createdAt, h)
  if (fields.lastSeenAt !== undefined) db().prepare('UPDATE colleague_sessions SET last_seen_at = ? WHERE id_hash = ?').run(fields.lastSeenAt, h)
}
