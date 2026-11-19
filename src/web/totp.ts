// DOCKERHTTPS1119: RFC 6238 TOTP (SHA1, 6 digits, 30 s steps) and one-time backup codes for the optional second
// factor of the dashboard owner login. node:crypto only, no dependency.
//
// What the caller must hold on to: the last ACCEPTED step per user. matchTotp() accepts a code only for a step after
// it, so a code that already signed in once is refused on replay, and so is any older code of the window.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_S = 30
export const TOTP_DIGITS = 6
/** Steps accepted on each side of the current one: +-1 (one 30 s step of clock drift either way). */
export const TOTP_WINDOW = 1
export const TOTP_ISSUER = 'Marveen'
export const BACKUP_CODE_COUNT = 10

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** RFC 4226 HOTP over HMAC-SHA1, `digits` decimal digits. */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', key).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_S)
}

/** The step whose code `code` is, within +-TOTP_WINDOW of now and strictly after `lastStep`; null when none.
 *  Every candidate is compared (no early exit), in constant time. */
export function matchTotp(secretB32: string, code: string, nowMs: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secretB32)
  const current = totpStepAt(nowMs)
  let matched: number | null = null
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))
    if (ok && step > lastStep && matched === null) matched = step
  }
  return matched
}

/** A fresh shared secret: 20 random bytes (the RFC's SHA1 key length), base32 for the authenticator app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function otpauthUri(account: string, secretB32: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`
}

// Backup codes: 10 characters from a 31-letter alphabet without look-alikes (no 0/o, 1/l/i), about 49.5 bits each,
// shown as xxxxx-xxxxx. Stored as sha256 only: the codes are random and high-entropy (unlike a password, no KDF needed
// against a dictionary), and the same file holds the TOTP secret itself, so a slower hash would protect nothing more.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function generateBackupCodes(n: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = []
  for (let i = 0; i < n; i++) {
    let c = ''
    for (let j = 0; j < 10; j++) c += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`)
  }
  return codes
}

export function normalizeBackupCode(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(normalizeBackupCode(code)).digest('hex')
}

/** Index of the stored hash `code` matches, or -1. Compares every stored hash. */
export function findBackupCode(hashes: readonly string[], code: string): number {
  const norm = normalizeBackupCode(code)
  if (norm.length !== 10) return -1
  const h = Buffer.from(hashBackupCode(norm), 'hex')
  let found = -1
  hashes.forEach((stored, i) => {
    const s = Buffer.from(stored, 'hex')
    if (s.length === h.length && timingSafeEqual(s, h) && found < 0) found = i
  })
  return found
}
