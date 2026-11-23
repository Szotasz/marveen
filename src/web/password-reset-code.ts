// DASHUSERGATE1123: the one-time reset code of a forgotten dashboard password.
//
// An agent asks for a code (POST /api/auth/password-reset/request); the server sends it ONLY to the owner's private
// channel (sendOwnerPrivate in ../notify.ts), never back to the caller. The member types it into the dashboard's
// own sign-in window ("Visszaállító kódom van"), so it works wherever the dashboard opens, the Bridge included, whose
// tunnel address the server cannot know and so cannot put into a link.
//
// Rules (owner-approved process, work/dashuser-folyamat.md):
//   - one live code per user; a new request replaces the old one;
//   - 15 minutes, single use;
//   - 5 wrong attempts invalidate it (a wrong second-factor code counts too);
//   - the request changes nothing: the old password stays valid until the code is used.
//
// The codes live in this process only, as SHA-256 hashes. A restart drops them, which only means asking again; the
// hourly request cap is counted from the audit log instead (see the route), so a restart does not reset it.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

export const RESET_CODE_TTL_MS = 15 * 60 * 1000
export const RESET_CODE_MAX_FAILURES = 5
export const RESET_REQUESTS_PER_HOUR = 3

/** Crockford base32: no I, L, O or U, so a code read off a phone is typed back without guessing. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 10 symbols of 32: 50 bits, against at most 5 guesses per code. */
const CODE_LENGTH = 10

interface PendingReset {
  hash: Buffer
  expiresAt: number
  failures: number
}

const pending = new Map<number, PendingReset>()

function hashCode(normalized: string): Buffer {
  return createHash('sha256').update(normalized).digest()
}

/** The typed code in its canonical form: upper case, separators dropped, the look-alike letters folded (O->0, I/L->1). */
export function normalizeResetCode(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, 64)
}

/** A fresh code, shown as XXXX-XXXX-XX. */
export function generateResetCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

/** Issue a code for `userId`, replacing any earlier one. Returns the code to send (never stored in clear). */
export function issueResetCode(userId: number, now: number = Date.now()): { code: string; expiresAt: number } {
  const code = generateResetCode()
  const expiresAt = now + RESET_CODE_TTL_MS
  pending.set(userId, { hash: hashCode(normalizeResetCode(code)), expiresAt, failures: 0 })
  return { code, expiresAt }
}

export type ResetCodeCheck =
  | { ok: true }
  | { ok: false; reason: 'none' | 'expired' | 'wrong' | 'locked' }

/**
 * Check a typed code against the user's live one, without using it up. A wrong code counts a failure, and the fifth
 * invalidates the code ('locked'). An expired code is dropped ('expired', once; 'none' after).
 */
export function checkResetCode(userId: number, raw: string, now: number = Date.now()): ResetCodeCheck {
  const entry = pending.get(userId)
  if (!entry) return { ok: false, reason: 'none' }
  if (now >= entry.expiresAt) {
    pending.delete(userId)
    return { ok: false, reason: 'expired' }
  }
  const typed = hashCode(normalizeResetCode(raw))
  if (timingSafeEqual(typed, entry.hash)) return { ok: true }
  return countResetFailure(userId) ? { ok: false, reason: 'locked' } : { ok: false, reason: 'wrong' }
}

/** Count one failed attempt (a wrong code, or a wrong second-factor code after a right one). True when that
 *  attempt used up the last try and the code is gone. */
export function countResetFailure(userId: number): boolean {
  const entry = pending.get(userId)
  if (!entry) return false
  entry.failures += 1
  if (entry.failures >= RESET_CODE_MAX_FAILURES) {
    pending.delete(userId)
    return true
  }
  return false
}

/** Use the code up (after the password was set) or drop it (a failed delivery). */
export function dropResetCode(userId: number): void {
  pending.delete(userId)
}

export function _resetPasswordResetCodesForTest(): void {
  pending.clear()
}
