// Per-device dashboard keys (AUTHPLAN1 #1).
//
// A device key is a long-lived Bearer credential minted for ONE device (a
// Bridge install, a phone) so it can be revoked alone, without rotating the
// shared dashboard token that every fleet script embeds. Modeled on
// auth-sessions.ts: only sha256(key) is stored -- in the DB (device_keys) and
// the in-memory cache -- so neither a DB leak nor a heap dump yields a usable
// credential.
//
// Differences from sessions, both deliberate:
//   - No idle/absolute TTL by default. A rarely used phone must not die
//     silently; expiry is per-key OPT-IN (expires_at) chosen at mint time.
//   - The principal is the device itself (name + id), not a user.
//
// Zero rows = the feature is off: resolveDeviceKey misses and the gate falls
// through exactly as before, so a byte-copy fresh install is unaffected.
//
// What a device key may DO is decided elsewhere: the gate hands out
// { kind: 'device' } and the per-endpoint allowlists (routes/auth.ts) deny it
// on every access-granting path -- a device can use the dashboard, it can
// never mint users, keys, or reset passwords.

import { randomBytes, createHash } from 'node:crypto'
import { getDb } from '../db.js'

const LAST_USED_DEBOUNCE_SEC = 60

// Prefix makes a leaked credential recognizable in logs/repos (secret
// scanners) and visually distinct from the 64-hex dashboard token.
const KEY_PREFIX = 'mvdk_'

export interface DeviceKeyPrincipal {
  id: number
  name: string
}

export interface DeviceKeyInfo {
  id: number
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
}

export interface MintedDeviceKey extends DeviceKeyInfo {
  /** The raw credential. Returned ONCE at mint time, never recoverable. */
  key: string
}

interface CachedKey {
  id: number
  name: string
  lastUsedAt: number | null
  expiresAt: number | null
}

const cache = new Map<string, CachedKey>()

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Mint a new key. The raw value exists only in the returned object; the row
// stores its hash. expiresInDays is opt-in -- omitted means the key lives until
// revoked.
export function createDeviceKey(name: string, opts: { expiresInDays?: number } = {}): MintedDeviceKey {
  const raw = KEY_PREFIX + randomBytes(32).toString('base64url')
  const keyHash = sha256hex(raw)
  const now = nowSec()
  const expiresAt = opts.expiresInDays ? now + Math.floor(opts.expiresInDays * 24 * 60 * 60) : null
  const info = getDb()
    .prepare('INSERT INTO device_keys (key_hash, name, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(keyHash, name, now, null, expiresAt)
  const id = Number(info.lastInsertRowid)
  cache.set(keyHash, { id, name, lastUsedAt: null, expiresAt })
  return { id, name, createdAt: now, lastUsedAt: null, expiresAt, key: raw }
}

function removeByHash(keyHash: string): void {
  cache.delete(keyHash)
  getDb().prepare('DELETE FROM device_keys WHERE key_hash = ?').run(keyHash)
}

// Validate a presented raw key. Returns the device principal or null. Enforces
// the opt-in expiry and debounces the last_used write to <= once per 60s. The
// cache is hydrated lazily from SQLite so keys survive dashboard restarts.
export function resolveDeviceKey(raw: string): DeviceKeyPrincipal | null {
  if (!raw || !raw.startsWith(KEY_PREFIX)) return null
  const keyHash = sha256hex(raw)
  let entry = cache.get(keyHash)
  if (!entry) {
    const row = getDb()
      .prepare('SELECT id, name, last_used_at, expires_at FROM device_keys WHERE key_hash = ?')
      .get(keyHash) as { id: number; name: string; last_used_at: number | null; expires_at: number | null } | undefined
    if (!row) return null
    entry = { id: row.id, name: row.name, lastUsedAt: row.last_used_at, expiresAt: row.expires_at }
    cache.set(keyHash, entry)
  }
  const now = nowSec()
  if (entry.expiresAt !== null && now > entry.expiresAt) {
    removeByHash(keyHash)
    return null
  }
  if (entry.lastUsedAt === null || now - entry.lastUsedAt >= LAST_USED_DEBOUNCE_SEC) {
    entry.lastUsedAt = now
    const res = getDb().prepare('UPDATE device_keys SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash)
    // The debounced write doubles as an existence check: zero changed rows
    // means the key was revoked OUTSIDE this process (dashboard-user
    // security:reset runs in its own process and cannot reach this cache), so
    // an out-of-band revocation takes effect here within <=60s instead of
    // lingering until the next restart.
    if (res.changes === 0) {
      cache.delete(keyHash)
      return null
    }
  }
  return { id: entry.id, name: entry.name }
}

export function listDeviceKeys(): DeviceKeyInfo[] {
  const rows = getDb()
    .prepare('SELECT id, name, created_at, last_used_at, expires_at FROM device_keys ORDER BY created_at DESC')
    .all() as { id: number; name: string; created_at: number; last_used_at: number | null; expires_at: number | null }[]
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at }))
}

// Revocation is immediate: the row and any cached entry go together, so the
// very next request with the key falls through the gate.
export function revokeDeviceKey(id: number): boolean {
  const res = getDb().prepare('DELETE FROM device_keys WHERE id = ?').run(id)
  for (const [hash, entry] of cache) {
    if (entry.id === id) cache.delete(hash)
  }
  return res.changes > 0
}

// Nuclear option for the security:reset break-glass path (#5): every device
// loses access at once. Returns the number of keys revoked.
export function revokeAllDeviceKeys(): number {
  const res = getDb().prepare('DELETE FROM device_keys').run()
  cache.clear()
  return res.changes
}

// Hourly sweep of keys past their (opt-in) expiry, alongside the session sweep.
// Keys without expires_at are never touched.
export function sweepExpiredDeviceKeys(): number {
  const now = nowSec()
  const res = getDb().prepare('DELETE FROM device_keys WHERE expires_at IS NOT NULL AND expires_at < ?').run(now)
  for (const [hash, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt < now) cache.delete(hash)
  }
  return res.changes
}

// Test seam: drop the in-memory cache to simulate a process restart (durable
// rows in device_keys must still resolve afterwards).
export function _clearDeviceKeyCacheForTest(): void {
  cache.clear()
}

// Test seam: direct cache access, so tests can age a last_used stamp across
// the debounce window without sleeping.
export const _cacheForTest = cache
