// DOCKERHTTPS1119: where the dashboard login's optional second factor lives, and its two short-lived states.
//
// Durable: store/.dashboard-totp.json, mode 0600, written atomically, one entry per dashboard user id:
//   { "users": { "<id>": { "secret": <base32>, "last_step": <n>, "backup": [<sha256 hex>...], "enabled_at": <unix s> } } }
// No entry for a user = the second factor is off for that user (the default). The secret is never logged and never in
// an API response after the setup step; the backup codes are stored hashed only.
//
// Fail closed: a file that exists but cannot be read or parsed THROWS (TotpStoreError). Reading it as "nobody has the
// second factor" would turn a damaged file into a password-only login; the login answers 503 instead. The way back is on
// the machine: repair or remove the file (removing it turns the second factor off for every user); the bearer token
// keeps working meanwhile. A readable file and one lost phone: npm run dashboard-user -- totp:off <username>.
//
// In memory only (a dashboard restart drops them, which costs the owner one more password or one more setup):
//   - the pending sign-in: the password was right, the code is still due (PENDING_LOGIN_TTL_S);
//   - the pending setup: a secret shown to the owner, not yet confirmed with a code (PENDING_SETUP_TTL_S).
// Both are keyed by sha256 of a random token or by the user id, and expire on their own.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const PENDING_LOGIN_TTL_S = 5 * 60
export const PENDING_SETUP_TTL_S = 10 * 60

export interface TotpRecord {
  secret: string
  last_step: number
  backup: string[]
  enabled_at: number
}

interface TotpFile {
  users: Record<string, TotpRecord>
}

export class TotpStoreError extends Error {}

let storePath = join(STORE_DIR, '.dashboard-totp.json')

export function totpStorePath(): string {
  return storePath
}

/** Test seam: point the store at a temp file. */
export function _setTotpStorePathForTest(p: string): void {
  storePath = p
}

function readFile(): TotpFile {
  if (!existsSync(storePath)) return { users: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(storePath, 'utf-8'))
  } catch {
    throw new TotpStoreError('the two-step sign-in store cannot be read')
  }
  const users = (parsed as { users?: unknown } | null)?.users
  if (!users || typeof users !== 'object' || Array.isArray(users)) throw new TotpStoreError('the two-step sign-in store is malformed')
  return { users: users as Record<string, TotpRecord> }
}

function writeFile(f: TotpFile): void {
  mkdirSync(dirname(storePath), { recursive: true })
  atomicWriteFileSync(storePath, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 })
}

/** The user's record, or undefined when the second factor is off. Throws TotpStoreError on a damaged file. */
export function getTotpRecord(userId: number): TotpRecord | undefined {
  const rec = readFile().users[String(userId)]
  if (rec === undefined) return undefined
  if (typeof rec.secret !== 'string' || !Number.isInteger(rec.last_step) || !Array.isArray(rec.backup)) {
    throw new TotpStoreError('the two-step sign-in store is malformed')
  }
  return rec
}

export function saveTotpRecord(userId: number, rec: TotpRecord): void {
  const f = readFile()
  f.users[String(userId)] = rec
  writeFile(f)
}

/** Turns the second factor off for this user. True when there was a record. */
export function removeTotpRecord(userId: number): boolean {
  if (!existsSync(storePath)) return false
  const f = readFile()
  if (f.users[String(userId)] === undefined) return false
  delete f.users[String(userId)]
  writeFile(f)
  return true
}

// ---- pending sign-in -------------------------------------------------------------------------------------------

interface PendingLogin {
  userId: number
  username: string
  expiresAt: number // ms
}

const pendingLogins = new Map<string, PendingLogin>()

function sha256hex(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

function sweepPendingLogins(now: number): void {
  for (const [k, v] of pendingLogins) if (v.expiresAt <= now) pendingLogins.delete(k)
}

/** After a right password with the second factor on: a random token naming the user, valid PENDING_LOGIN_TTL_S. */
export function createPendingLogin(userId: number, username: string, now: number = Date.now()): string {
  sweepPendingLogins(now)
  const token = randomBytes(32).toString('base64url')
  pendingLogins.set(sha256hex(token), { userId, username, expiresAt: now + PENDING_LOGIN_TTL_S * 1000 })
  return token
}

export function getPendingLogin(token: string, now: number = Date.now()): { userId: number; username: string } | null {
  if (!token) return null
  sweepPendingLogins(now)
  const p = pendingLogins.get(sha256hex(token))
  return p ? { userId: p.userId, username: p.username } : null
}

export function consumePendingLogin(token: string): void {
  pendingLogins.delete(sha256hex(token))
}

// ---- pending setup ----------------------------------------------------------------------------------------------

const pendingSetups = new Map<number, { secret: string; expiresAt: number }>()

export function setPendingSetup(userId: number, secret: string, now: number = Date.now()): void {
  pendingSetups.set(userId, { secret, expiresAt: now + PENDING_SETUP_TTL_S * 1000 })
}

export function getPendingSetup(userId: number, now: number = Date.now()): string | null {
  const p = pendingSetups.get(userId)
  if (!p) return null
  if (p.expiresAt <= now) {
    pendingSetups.delete(userId)
    return null
  }
  return p.secret
}

export function clearPendingSetup(userId: number): void {
  pendingSetups.delete(userId)
}

/** Test seam. */
export function _resetTotpStateForTest(): void {
  pendingLogins.clear()
  pendingSetups.clear()
}
