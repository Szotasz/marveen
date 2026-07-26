// Browser-login session store for the optional dashboard password auth.
//
// A session id is 32 random bytes (base64url) handed to the client in an
// HttpOnly cookie. Only sha256(id) is stored -- in the DB (auth_sessions) AND in
// the in-memory cache -- so neither a DB leak nor a heap dump yields a usable
// cookie value.
//
// Two TTLs, both server-authoritative regardless of the cookie's Max-Age:
//   idle (sliding)  7 days  -- last_seen_at bumped on use, DB write debounced 60s
//   absolute cap   30 days  -- from created_at, non-renewable => monthly re-login
//
// The cache is hydrated lazily from SQLite, so a session survives the frequent
// dashboard restarts / auto-updates (resolveSession re-reads the row on a cache
// miss). Restart is treated as an in-memory reset only; the durable state is the
// table.

import { randomBytes, createHash } from 'node:crypto'
import { getDb } from '../db.js'

const IDLE_TTL_SEC = 7 * 24 * 60 * 60
const ABSOLUTE_TTL_SEC = 30 * 24 * 60 * 60
const LAST_SEEN_DEBOUNCE_SEC = 60

export interface AuthSessionUser {
  userId: number
  username: string
}

export interface ResolvedSession {
  userId: number
  username: string
}

export interface UserSessionInfo {
  idHashPrefix: string
  createdAt: number
  lastSeenAt: number
  userAgent: string | null
}

interface CachedSession {
  userId: number
  username: string
  createdAt: number
  lastSeenAt: number
}

const cache = new Map<string, CachedSession>()

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Mint a fresh session (always at successful login only -- never from a
// client-supplied value) and return the raw token for the Set-Cookie header.
export function createSession(user: AuthSessionUser, opts: { userAgent?: string | null; remoteNote?: string | null } = {}): string {
  const token = randomBytes(32).toString('base64url')
  const idHash = sha256hex(token)
  const now = nowSec()
  getDb()
    .prepare('INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at, user_agent, remote_note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(idHash, user.userId, user.username, now, now, opts.userAgent ?? null, opts.remoteNote ?? null)
  cache.set(idHash, { userId: user.userId, username: user.username, createdAt: now, lastSeenAt: now })
  return token
}

function removeByHash(idHash: string): void {
  cache.delete(idHash)
  getDb().prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash)
}

// Validate a presented cookie value. Returns the session principal or null.
// Enforces both TTLs and debounces the last_seen write to <= once per 60s.
export function resolveSession(cookieValue: string): ResolvedSession | null {
  if (!cookieValue) return null
  const idHash = sha256hex(cookieValue)
  let entry = cache.get(idHash)
  if (!entry) {
    // Cache miss (fresh process after a restart, or a session minted by another
    // path): rehydrate from the durable table.
    const row = getDb()
      .prepare('SELECT user_id, username, created_at, last_seen_at FROM auth_sessions WHERE id_hash = ?')
      .get(idHash) as { user_id: number; username: string; created_at: number; last_seen_at: number } | undefined
    if (!row) return null
    entry = { userId: row.user_id, username: row.username, createdAt: row.created_at, lastSeenAt: row.last_seen_at }
    cache.set(idHash, entry)
  }
  const now = nowSec()
  if (now - entry.createdAt > ABSOLUTE_TTL_SEC) {
    removeByHash(idHash)
    return null
  }
  if (now - entry.lastSeenAt > IDLE_TTL_SEC) {
    removeByHash(idHash)
    return null
  }
  if (now - entry.lastSeenAt >= LAST_SEEN_DEBOUNCE_SEC) {
    entry.lastSeenAt = now
    const res = getDb().prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash)
    // Zero changed rows = the session row was deleted OUTSIDE this process
    // (dashboard-user sessions:clear / security:reset run in their own process
    // and cannot reach this cache). Honor the revocation within <=60s instead
    // of serving the cached session until the next restart.
    if (res.changes === 0) {
      cache.delete(idHash)
      return null
    }
  }
  return { userId: entry.userId, username: entry.username }
}

export function revokeSession(cookieValue: string): void {
  if (!cookieValue) return
  removeByHash(sha256hex(cookieValue))
}

// Revoke every session of a user, optionally sparing the caller's own (used by
// password-change and logout-all). exceptCookieValue is the RAW cookie value.
export function revokeAllForUser(userId: number, exceptCookieValue?: string | null): void {
  const exceptHash = exceptCookieValue ? sha256hex(exceptCookieValue) : null
  for (const [hash, entry] of cache) {
    if (entry.userId === userId && hash !== exceptHash) cache.delete(hash)
  }
  if (exceptHash) {
    getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash)
  } else {
    getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
  }
}

// Revoke EVERY browser session at once (break-glass security reset). Cache and
// table go together -- a DB-only delete would leave cached sessions resolving
// until the next restart.
export function revokeAllSessions(): number {
  cache.clear()
  return getDb().prepare('DELETE FROM auth_sessions').run().changes
}

export function listUserSessions(userId: number): UserSessionInfo[] {
  const rows = getDb()
    .prepare('SELECT id_hash, created_at, last_seen_at, user_agent FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId) as { id_hash: string; created_at: number; last_seen_at: number; user_agent: string | null }[]
  return rows.map((r) => ({ idHashPrefix: r.id_hash.slice(0, 12), createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent }))
}

// Hourly sweep of rows past either TTL. Cheap: two indexed range deletes plus a
// cache prune. Returns the number of DB rows removed.
export function sweepExpiredSessions(): number {
  const now = nowSec()
  const idleCutoff = now - IDLE_TTL_SEC
  const absoluteCutoff = now - ABSOLUTE_TTL_SEC
  const res = getDb()
    .prepare('DELETE FROM auth_sessions WHERE last_seen_at < ? OR created_at < ?')
    .run(idleCutoff, absoluteCutoff)
  for (const [hash, entry] of cache) {
    if (entry.lastSeenAt < idleCutoff || entry.createdAt < absoluteCutoff) cache.delete(hash)
  }
  return res.changes
}

// Test seam: drop the in-memory cache to simulate a process restart (durable
// rows in auth_sessions must still resolve afterwards).
export function _clearSessionCacheForTest(): void {
  cache.clear()
}

// Test seam: direct cache access, so tests can age a last_seen stamp across
// the debounce window without sleeping.
export const _cacheForTest = cache
