// Support access: the pinned values. THE ONLY PLACE they live.
//
// A support line in authorized_keys is built from these constants and from the
// consent record, never from a request body, an env variable, a config file or
// a network answer. Anything an agent on the box could rewrite at runtime is
// not a pin; a source constant changes only with a release.
//
// Both lists ship EMPTY. With an empty list the feature is dark: every grant
// answers 412 before anything is written. The real public keys and the real
// source address are a separate, later commit.
//
// Key type: only FIDO2 ed25519 (`sk-ssh-ed25519@openssh.com`). The type is a
// real brake, not a formality. Measured on OpenSSH 8.4, 8.9, 9.2 and 9.6: a
// `verify-required` option on a PLAIN ed25519 key does not stop a login, the
// option only binds an sk key. A plain key in this list would therefore log in
// without a PIN and without a touch.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export const SUPPORT_KEY_TYPE = 'sk-ssh-ed25519@openssh.com'

/** At most two keys (a primary and a spare) and two source addresses. */
export const SUPPORT_MAX_KEYS = 2
export const SUPPORT_MAX_FROM = 2

export interface SupportKeyPin {
  /** Short label that ends up in the bound command and in the login record. */
  readonly name: string
  /** The base64 public key blob (the second field of the .pub file). */
  readonly pub: string
  /** `SHA256:<base64 without padding>` of the blob, as `ssh-keygen -l` prints it. */
  readonly fingerprint: string
}

/** Pinned support keys. Empty until the key ceremony; changed only by a release. */
export const SUPPORT_KEYS: readonly SupportKeyPin[] = []

/** Pinned source addresses, each an exact host: IPv4 `/32` or IPv6 `/128`. */
export const SUPPORT_FROM_CIDRS: readonly string[] = []

export type SupportPinsProblem = 'support_keys_unset' | 'support_from_unset' | 'support_pins_invalid'

export type SupportPinsCheck =
  | { ok: true }
  | { ok: false; code: SupportPinsProblem; reason: string }

const KEY_NAME = /^[a-z0-9]{1,16}$/
const SK_APPLICATION = /^ssh:[A-Za-z0-9._-]{0,64}$/

/** Canonical standard base64: decodes and re-encodes to exactly the same text.
 * Buffer.from is lenient (it silently drops invalid characters), so a plain
 * decode is not enough to reject malformed input. */
function isCanonicalBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false
  return Buffer.from(s, 'base64').toString('base64') === s
}

export type SkBlobParse =
  | { ok: true; application: string }
  | { ok: false; reason: string }

/**
 * Parse the OpenSSH wire blob of an sk-ssh-ed25519 public key:
 *   string "sk-ssh-ed25519@openssh.com" | string <32 key bytes> | string <application>
 * Anything else (another embedded type, another key length, a missing or odd
 * application, trailing bytes) is rejected.
 */
export function parseSkEd25519Blob(base64: string): SkBlobParse {
  if (!isCanonicalBase64(base64)) return { ok: false, reason: 'not canonical base64' }
  const buf = Buffer.from(base64, 'base64')
  let off = 0
  const readString = (): Buffer | null => {
    if (off + 4 > buf.length) return null
    const len = buf.readUInt32BE(off)
    off += 4
    if (off + len > buf.length) return null
    const out = buf.subarray(off, off + len)
    off += len
    return out
  }
  const type = readString()
  if (type === null || type.toString('latin1') !== SUPPORT_KEY_TYPE) {
    return { ok: false, reason: 'embedded key type is not ' + SUPPORT_KEY_TYPE }
  }
  const key = readString()
  if (key === null || key.length !== 32) return { ok: false, reason: 'public key is not 32 bytes' }
  const application = readString()
  if (application === null) return { ok: false, reason: 'application field is missing' }
  if (off !== buf.length) return { ok: false, reason: 'trailing bytes after the application field' }
  const app = application.toString('latin1')
  if (!SK_APPLICATION.test(app)) return { ok: false, reason: 'application field is not an ssh: application' }
  return { ok: true, application: app }
}

/** `SHA256:<base64 without padding>` of a public key blob, the form OpenSSH logs and prints. */
export function fingerprintOfBlob(base64: string): string {
  const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64')
  return 'SHA256:' + digest.replace(/=+$/, '')
}

/**
 * True for one exact host in CIDR form: a canonical IPv4 with `/32` or an IPv6
 * with `/128`. A range, a wildcard, a negation, a host name, a quote or a space
 * never passes: `from=` must name the one machine support connects from.
 */
export function isExactHostCidr(value: string): boolean {
  const m = /^([0-9A-Fa-f:.]{2,45})\/(32|128)$/.exec(value)
  if (m === null) return false
  const family = isIP(m[1])
  if (family === 4) return m[2] === '32' && m[1].split('.').every((part) => String(Number(part)) === part)
  if (family === 6) return m[2] === '128'
  return false
}

/**
 * Check the pins as a whole. Empty lists are "unset" (the feature is dark);
 * anything malformed is "invalid" (the feature refuses to work until a release
 * fixes it). A fingerprint that does not match its own blob is invalid: the
 * fingerprint is what the owner sees and consents to.
 */
export function validateSupportPins(
  keys: readonly SupportKeyPin[],
  fromCidrs: readonly string[],
): SupportPinsCheck {
  const invalid = (reason: string): SupportPinsCheck => ({ ok: false, code: 'support_pins_invalid', reason })
  if (keys.length > SUPPORT_MAX_KEYS) return invalid('more than ' + SUPPORT_MAX_KEYS + ' keys')
  if (fromCidrs.length > SUPPORT_MAX_FROM) return invalid('more than ' + SUPPORT_MAX_FROM + ' source addresses')
  const names = new Set<string>()
  const blobs = new Set<string>()
  for (const key of keys) {
    if (!KEY_NAME.test(key.name)) return invalid('key name is not a short lowercase label')
    if (names.has(key.name)) return invalid('duplicate key name ' + key.name)
    names.add(key.name)
    const parsed = parseSkEd25519Blob(key.pub)
    if (!parsed.ok) return invalid('key ' + key.name + ': ' + parsed.reason)
    if (blobs.has(key.pub)) return invalid('key ' + key.name + ' repeats another key')
    blobs.add(key.pub)
    if (fingerprintOfBlob(key.pub) !== key.fingerprint) {
      return invalid('key ' + key.name + ': the fingerprint does not belong to the key')
    }
  }
  const seenFrom = new Set<string>()
  for (const cidr of fromCidrs) {
    if (!isExactHostCidr(cidr)) return invalid('source address is not an exact /32 or /128 host')
    if (seenFrom.has(cidr)) return invalid('duplicate source address')
    seenFrom.add(cidr)
  }
  if (keys.length === 0) return { ok: false, code: 'support_keys_unset', reason: 'no support key is pinned' }
  if (fromCidrs.length === 0) return { ok: false, code: 'support_from_unset', reason: 'no source address is pinned' }
  return { ok: true }
}
