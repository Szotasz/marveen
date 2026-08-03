// Pure logic for remote access key enrollment.
//
// This module holds the side-effect-free parts of the enrollment helper so
// they can be unit-tested without touching the real home directory or SSH
// configuration: public-key line validation, restricted authorized_keys line
// construction, replace-by-id merging, host-key parsing, and connection
// bundle building. All filesystem work lives in remote-enroll-fs.ts.

/** Default loopback dashboard port. The enrolled key's permitopen and the
 * connection bundle both target the ACTUAL dashboard port (WEB_PORT); this is
 * only the fallback when a caller does not supply one. A hardcoded value here
 * silently broke any install whose dashboard ran on a non-default port
 * (INSTUX1): the permitopen stayed 3420 while the dashboard moved, so the
 * tunnel hit a dead port. The port is now threaded through from the caller. */
export const REMOTE_PORT = 3420

/** The only key type accepted for enrollment. */
export const ACCEPTED_KEY_TYPE = 'ssh-ed25519'

/**
 * Shape check for the pairing target address (JANKBRIDGE803).
 *
 * A customer typed the email address of his Tailscale ACCOUNT here. Nothing in
 * the chain objected: the bundle was built with it, the Bridge imported it, and
 * the failure surfaced only at connect time as `getaddrinfo EAI_FAIL <email>`.
 * Measured on the shipped Bridge before writing this: parseBundle accepted an
 * email, whitespace, a URL, an embedded newline and a 400-character string --
 * only the empty string was rejected, while the PORT field next to it was fully
 * validated. The asymmetry, not the customer, produced the incident.
 *
 * NOT reusable from the remote-AGENT host check (agent-config.ts
 * REMOTE_HOST_ALLOWED). That one is an ssh DESTINATION charset, where `user@host`
 * is legitimate, so it accepts `someone@gmail.com` -- measured. Reusing it here
 * would look like a fix and would let this exact report through again.
 *
 * Deliberately permissive about hostname purity: `_` is accepted because real
 * machines carry it, and a trailing dot is accepted because an FQDN may be
 * written that way. The job is to reject what CANNOT be a host (an address with
 * `@`, spaces, a URL, control characters), not to enforce RFC 1123.
 */
const HOSTNAME_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?'
const HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*\\.?$`)

export type HostCheck = { ok: true; host: string } | { ok: false; reason: string }

/**
 * Validate a user-supplied target address. `isIP` covers IPv4 and IPv6
 * literals; anything else must look like a hostname.
 *
 * The email case gets its OWN message on purpose. "Invalid host" would be
 * technically correct and useless: the reporter believed the field wanted his
 * Tailscale identity, so the message has to correct the belief, not the syntax.
 */
export function checkEnrollHost(raw: string, isIP: (s: string) => number): HostCheck {
  const host = raw.trim()
  if (!host) return { ok: false, reason: 'target address is empty' }
  // Quote back at most 60 characters: enough to recognise what was typed,
  // short enough that a pasted blob does not become the whole message.
  const seen = host.length > 60 ? `${host.slice(0, 60)}...` : host
  if (host.length > 253) {
    return { ok: false, reason: `target address is too long (${host.length} characters, maximum 253)` }
  }
  if (isIP(host) !== 0) return { ok: true, host }
  if (host.includes('@')) {
    return {
      ok: false,
      reason:
        `"${seen}" looks like an email address. The target address is the machine's IP address or ` +
        'hostname; with Tailscale it is the address starting with 100, not the email address of the Tailscale account.',
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(host)) {
    return { ok: false, reason: `"${seen}" is a URL. Enter only the address, without http:// or a path.` }
  }
  if (!HOSTNAME_RE.test(host)) {
    return { ok: false, reason: `"${seen}" is not a valid IP address or hostname.` }
  }
  return { ok: true, host }
}

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
/** The tight restriction set for a given dashboard port. The permitopen stays
 * a SINGLE loopback endpoint (never a wildcard or a range), and the forced
 * `command="/bin/false"` plus `restrict` are unchanged -- widening any of these
 * would turn the enrolled key into a general port-forward grant on the server.
 * Only the port follows the caller's WEB_PORT. */
export function restrictOptions(webPort: number = REMOTE_PORT): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${webPort}",command="/bin/false"`
}

/** The default-port restriction string. Retained for callers/tests that assert
 * the default shape; port-aware callers use restrictOptions(webPort). */
export const RESTRICT_OPTIONS = restrictOptions(REMOTE_PORT)

/**
 * Build the exact restricted authorized_keys line for a validated key.
 * The key material and comment are reproduced verbatim. `webPort` is the actual
 * dashboard port the key may tunnel to (defaults to REMOTE_PORT).
 */
export function buildRestrictedLine(parsed: ParsedKey, webPort: number = REMOTE_PORT): string {
  return `${restrictOptions(webPort)} ${parsed.keyType} ${parsed.base64} ${parsed.comment}`
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

export interface RemoveResult {
  content: string
  removed: boolean
}

/**
 * Remove the line carrying `marveen-remote:<installId>` from authorized_keys
 * content (the revoke counterpart of mergeAuthorizedKeys). Every other line is
 * preserved byte-for-byte. `removed:false` means no such line existed -- the
 * caller decides whether that is an error or an idempotent no-op. An empty
 * result stays empty (no lone trailing newline is invented).
 */
export function removeAuthorizedKey(existing: string, installId: string): RemoveResult {
  const target = `${COMMENT_PREFIX}${installId}`
  const lines = existing.length ? existing.split('\n') : []
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const out = lines.filter((line) => lineComment(line) !== target)
  const removed = out.length !== lines.length
  let content = out.join('\n')
  if (content.length > 0 && !content.endsWith('\n')) content += '\n'
  return { content, removed }
}

/**
 * Extract the base64 body (second whitespace field) of an OpenSSH ed25519
 * public key file such as /etc/ssh/ssh_host_ed25519_key.pub. The type field
 * must be ssh-ed25519 -- only that key type is pinned -- and the body must be
 * canonical base64. Returns null otherwise.
 */
export function parseHostKeyPub(content: string): string | null {
  const line = content.trim()
  if (line.length === 0) return null
  const fields = line.split(/\s+/)
  if (fields.length < 2) return null
  if (fields[0] !== ACCEPTED_KEY_TYPE) return null
  const body = fields[1]
  if (!isCanonicalBase64(body)) return null
  return body
}

/**
 * Known locations of the sshd ed25519 host public key. The Linux path is the
 * OpenSSH default; macOS keeps /etc under /private (usually symlinked, but the
 * symlink is not guaranteed), and Homebrew / local builds use their own
 * prefixes.
 */
export const HOST_KEY_PUB_CANDIDATES = [
  '/etc/ssh/ssh_host_ed25519_key.pub',
  '/private/etc/ssh/ssh_host_ed25519_key.pub',
  '/opt/homebrew/etc/ssh/ssh_host_ed25519_key.pub',
  '/usr/local/etc/ssh/ssh_host_ed25519_key.pub',
]

/**
 * Extract the ed25519 key body from `ssh-keyscan -t ed25519` output. Keyscan
 * lines are `<host> <type> <base64>`; comment lines start with '#'. Returns
 * null when no valid ed25519 line is present.
 */
export function parseKeyscanEd25519(output: string): string | null {
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 3) continue
    if (fields[1] !== ACCEPTED_KEY_TYPE) continue
    if (isCanonicalBase64(fields[2])) return fields[2]
  }
  return null
}

export interface HostKeySources {
  /** Read a file's content, or return null when unreadable/absent. */
  readFile: (path: string) => string | null
  /** Run ssh-keyscan against loopback and return its stdout, or null. */
  keyscan: () => string | null
}

export interface ResolvedHostKey {
  body: string
  /** Where the key came from: a candidate path, or 'ssh-keyscan'. */
  source: string
}

/**
 * Obtain the machine's ed25519 host key body: first from the known public-key
 * file locations, then by asking the running SSH server itself via
 * ssh-keyscan. Returns null only when every source fails, which callers must
 * treat as a hard error -- a connection bundle without a host key is not
 * accepted by the consuming side.
 */
export function resolveHostKey(
  sources: HostKeySources,
  candidates: readonly string[] = HOST_KEY_PUB_CANDIDATES,
): ResolvedHostKey | null {
  for (const path of candidates) {
    const content = sources.readFile(path)
    if (content === null) continue
    const body = parseHostKeyPub(content)
    if (body !== null) return { body, source: path }
  }
  const output = sources.keyscan()
  if (output !== null) {
    const body = parseKeyscanEd25519(output)
    if (body !== null) return { body, source: 'ssh-keyscan' }
  }
  return null
}

export interface ConnectionBundleInput {
  displayName: string
  host: string
  sshPort: number
  sshUser: string
  /** Omitted from the bundle entirely when undefined. */
  hostKey?: string
  installId: string
  /** Dashboard bearer token. Omitted when undefined. A bundle carrying this
   * field is a SECRET: it grants dashboard access to anyone holding it, so it
   * must be transported over a private channel, never email or chat logs. */
  dashboardToken?: string
  /** Actual dashboard port the tunnel targets. Defaults to REMOTE_PORT. Must
   * match the permitopen written by buildRestrictedLine, or the tunnel opens a
   * dead port (INSTUX1). */
  webPort?: number
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
  dashboardToken?: string
}

/**
 * Build the connection bundle object. The hostKey field is optional at the
 * wire level, but the consuming side requires it -- the CLI therefore refuses
 * to emit a bundle without one (see resolveHostKey). Field order matches the
 * documented format: hostKey before installId, dashboardToken last.
 */
export function buildBundle(input: ConnectionBundleInput): ConnectionBundle {
  return {
    format: BUNDLE_FORMAT,
    kind: 'connection',
    displayName: input.displayName,
    host: input.host,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    remotePort: input.webPort ?? REMOTE_PORT,
    ...(input.hostKey !== undefined ? { hostKey: input.hostKey } : {}),
    installId: input.installId,
    ...(input.dashboardToken !== undefined ? { dashboardToken: input.dashboardToken } : {}),
  }
}

/** Encode a bundle as a single-line base64 string. */
export function encodeBundle(bundle: ConnectionBundle): string {
  return Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')
}

/** Decode a base64 bundle back to an object. Exposed for tests and tooling. */
export function decodeBundle(encoded: string): ConnectionBundle {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ConnectionBundle
}
