// Pure logic for remote access key enrollment.
//
// This module holds the side-effect-free parts of the enrollment helper so
// they can be unit-tested without touching the real home directory or SSH
// configuration: public-key line validation, restricted authorized_keys line
// construction, replace-by-id merging, host-key parsing, and connection
// bundle building. All filesystem work lives in remote-enroll-fs.ts.

/** Fixed loopback endpoint the enrolled key is permitted to open. */
export const REMOTE_PORT = 3420

/** The only key type accepted for enrollment. */
export const ACCEPTED_KEY_TYPE = 'ssh-ed25519'

/** Prefix that every per-device comment must carry. The full comment is
 * `marveen-remote:<uuid>`, where the uuid is the per-device revocation and
 * replace identifier. */
export const COMMENT_PREFIX = 'marveen-remote:'

/** Bundle format tag, versioned so the consuming side can evolve safely. */
export const BUNDLE_FORMAT = 'marveen-remote/1'

/** Raised for any validation failure so the CLI can print a clear message
 * and exit non-zero without a stack trace. */
export class RemoteEnrollError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteEnrollError'
  }
}

export interface ParsedKey {
  keyType: typeof ACCEPTED_KEY_TYPE
  base64: string
  comment: string
  /** The uuid extracted from the comment. */
  installId: string
}

// UUID v4 shape. The connecting device generates this per install; it is the
// stable identity used to revoke or replace a single device's access.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Verify a string is canonical standard base64: it decodes and re-encodes to
 * exactly the same text. Buffer.from is lenient (it silently drops invalid
 * characters), so a plain decode is not enough to reject malformed input.
 */
function isCanonicalBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false
  return Buffer.from(s, 'base64').toString('base64') === s
}

/**
 * Parse and validate the OpenSSH wire-format blob for an ed25519 public key.
 * The blob is a sequence of length-prefixed fields:
 *   uint32 len | "ssh-ed25519" | uint32 len | 32-byte public key
 * Anything else (wrong embedded type, wrong key length, trailing bytes) is
 * rejected.
 */
function validateEd25519Blob(base64: string): void {
  if (!isCanonicalBase64(base64)) {
    throw new RemoteEnrollError('key body is not valid base64')
  }
  const buf = Buffer.from(base64, 'base64')
  let off = 0
  if (buf.length < 4) throw new RemoteEnrollError('key blob is too short')
  const typeLen = buf.readUInt32BE(off)
  off += 4
  if (typeLen !== ACCEPTED_KEY_TYPE.length || off + typeLen > buf.length) {
    throw new RemoteEnrollError('key blob has an unexpected type field')
  }
  const embeddedType = buf.subarray(off, off + typeLen).toString('utf8')
  off += typeLen
  if (embeddedType !== ACCEPTED_KEY_TYPE) {
    throw new RemoteEnrollError(
      `embedded key type must be ${ACCEPTED_KEY_TYPE}, found "${embeddedType}"`,
    )
  }
  if (off + 4 > buf.length) throw new RemoteEnrollError('key blob is truncated')
  const keyLen = buf.readUInt32BE(off)
  off += 4
  // ed25519 public keys are exactly 32 bytes.
  if (keyLen !== 32) {
    throw new RemoteEnrollError('ed25519 public key must be 32 bytes')
  }
  if (off + keyLen !== buf.length) {
    throw new RemoteEnrollError('key blob has trailing or missing bytes')
  }
}

/**
 * Validate a single OpenSSH public key line of the exact shape
 *   ssh-ed25519 <base64 key> marveen-remote:<uuid>
 * The line must contain nothing else: no authorized_keys options, no extra
 * fields. Returns the parsed pieces or throws RemoteEnrollError.
 */
export function validatePublicKeyLine(rawLine: string): ParsedKey {
  if (typeof rawLine !== 'string') {
    throw new RemoteEnrollError('public key line is required')
  }
  const line = rawLine.trim()
  if (line.length === 0) {
    throw new RemoteEnrollError('public key line is empty')
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new RemoteEnrollError('public key line must be a single line')
  }
  const fields = line.split(/\s+/)
  if (fields.length !== 3) {
    throw new RemoteEnrollError(
      'line must contain exactly three fields: type, key, comment (no options, no extra fields)',
    )
  }
  const [keyType, base64, comment] = fields
  if (keyType !== ACCEPTED_KEY_TYPE) {
    throw new RemoteEnrollError(`key type must be exactly ${ACCEPTED_KEY_TYPE}`)
  }
  validateEd25519Blob(base64)
  if (!comment.startsWith(COMMENT_PREFIX)) {
    throw new RemoteEnrollError(`comment must start with "${COMMENT_PREFIX}"`)
  }
  const installId = comment.slice(COMMENT_PREFIX.length)
  if (!UUID_V4.test(installId)) {
    throw new RemoteEnrollError('comment must be marveen-remote:<uuid v4>')
  }
  return { keyType: ACCEPTED_KEY_TYPE, base64, comment, installId }
}

/** Options string prepended to the enrolled key in authorized_keys. This is
 * the tight restriction set: no shell (command forced to /bin/false), no
 * agent/x11/pty, forwarding limited to a single loopback endpoint. */
export const RESTRICT_OPTIONS =
  `restrict,port-forwarding,permitopen="127.0.0.1:${REMOTE_PORT}",command="/bin/false"`

/**
 * Build the exact restricted authorized_keys line for a validated key.
 * The key material and comment are reproduced verbatim.
 */
export function buildRestrictedLine(parsed: ParsedKey): string {
  return `${RESTRICT_OPTIONS} ${parsed.keyType} ${parsed.base64} ${parsed.comment}`
}

/** Extract the trailing comment field of an authorized_keys line, or null if
 * the line is blank. Used to find a prior enrollment by its install id. */
function lineComment(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const fields = trimmed.split(/\s+/)
  return fields[fields.length - 1]
}

export type MergeAction = 'added' | 'replaced'

export interface MergeResult {
  content: string
  action: MergeAction
}

/**
 * Merge a restricted line into existing authorized_keys content by install
 * id. If a line already carries the same `marveen-remote:<uuid>` comment it
 * is replaced in place (re-enrollment); every other line is preserved
 * byte-for-byte. Otherwise the restricted line is appended. The result always
 * ends with a single trailing newline.
 */
export function mergeAuthorizedKeys(
  existing: string,
  restrictedLine: string,
  installId: string,
): MergeResult {
  const target = `${COMMENT_PREFIX}${installId}`
  const lines = existing.length ? existing.split('\n') : []
  // A file that ends in a newline yields a trailing '' element; drop it so it
  // does not become a spurious blank line, then re-add exactly one newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  let replaced = false
  const out = lines.map((line) => {
    if (lineComment(line) === target) {
      replaced = true
      return restrictedLine
    }
    return line
  })
  if (!replaced) out.push(restrictedLine)
  let content = out.join('\n')
  if (!content.endsWith('\n')) content += '\n'
  return { content, action: replaced ? 'replaced' : 'added' }
}

/**
 * Extract the base64 body (second whitespace field) of an OpenSSH public key
 * file such as /etc/ssh/ssh_host_ed25519_key.pub. Returns null when the
 * content does not look like a public key line.
 */
export function parseHostKeyPub(content: string): string | null {
  const line = content.trim()
  if (line.length === 0) return null
  const fields = line.split(/\s+/)
  if (fields.length < 2) return null
  const body = fields[1]
  if (!isCanonicalBase64(body)) return null
  return body
}

export interface ConnectionBundleInput {
  displayName: string
  host: string
  sshPort: number
  sshUser: string
  /** Omitted from the bundle entirely when undefined. */
  hostKey?: string
  installId: string
}

export interface ConnectionBundle {
  format: typeof BUNDLE_FORMAT
  kind: 'connection'
  displayName: string
  host: string
  sshPort: number
  sshUser: string
  remotePort: number
  hostKey?: string
  installId: string
}

/**
 * Build the connection bundle object. The hostKey field is included only when
 * a host key was available; when absent the connecting device falls back to a
 * first-use fingerprint confirmation. Field order matches the documented
 * format.
 */
export function buildBundle(input: ConnectionBundleInput): ConnectionBundle {
  const bundle: ConnectionBundle = {
    format: BUNDLE_FORMAT,
    kind: 'connection',
    displayName: input.displayName,
    host: input.host,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    remotePort: REMOTE_PORT,
    installId: input.installId,
  }
  if (input.hostKey !== undefined) {
    // Insert hostKey before installId to match the documented field order.
    return {
      format: bundle.format,
      kind: bundle.kind,
      displayName: bundle.displayName,
      host: bundle.host,
      sshPort: bundle.sshPort,
      sshUser: bundle.sshUser,
      remotePort: bundle.remotePort,
      hostKey: input.hostKey,
      installId: bundle.installId,
    }
  }
  return bundle
}

/** Encode a bundle as a single-line base64 string. */
export function encodeBundle(bundle: ConnectionBundle): string {
  return Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')
}

/** Decode a base64 bundle back to an object. Exposed for tests and tooling. */
export function decodeBundle(encoded: string): ConnectionBundle {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ConnectionBundle
}
