// Support access: the authorized_keys line, as pure functions.
//
// One builder makes the line, and everything else (merge, remove,
// reconcile) compares against the builder's output as an exact string. Nothing
// here reads a file, the clock or the environment, so every rule below is a
// unit test away from being proven.
//
// THE CLOSED LIST HOLDS WHERE THE BYTES ARE ASSEMBLED, not only in the builder:
// the on-disk writers (support-access-fs.ts) take a grant's INPUTS and build
// the lines here, so no caller can hand them a string; and mergeSupportLines,
// which does take strings, refuses anything that is not one single physical
// line recognised as a support line.
//
// THE LINE (one per pinned key, all sharing one grant id):
//
//   restrict,command="/bin/sh <dispatcher> --key <name> --fp <fingerprint>
//   --grant <uuid> --consent <n>",from="<host>[,<host>]",verify-required
//   sk-ssh-ed25519@openssh.com <blob> marveen-support:<uuid>:<name>
//
// THE OPTION LIST IS CLOSED: these four options, in this order, and nothing
// else. Why each part, with what was measured on OpenSSH 7.6, 8.2, 8.4, 8.9,
// 9.2, 9.6 and 10.0 (throwaway containers, 2026-11-14):
//   restrict         no pty, no port, agent or X11 forwarding. Measured on
//                    this exact shape: -L, -D, -R and unix-socket forwards are
//                    all refused. Nothing that hands a capability back may
//                    follow it. There is deliberately NO port-forwarding
//                    variant: once port-forwarding is switched back on, a
//                    remote forward and a unix-socket remote forward stay open
//                    whatever permitopen/permitlisten say (measured).
//                    NOT covered by this line: tunnel devices. Whether a
//                    tunnel request is refused depends on the server's
//                    PermitTunnel setting (off by default), and no key option
//                    forbids it; some sshd builds refuse it under restrict,
//                    others do not (measured). The code that enables support
//                    access has to check that setting; the line cannot.
//   command=         the bound dispatcher. It carries the key name, the
//                    fingerprint of THIS line's key, the grant id and the
//                    consent version. sshd runs the command of the line whose
//                    key logged in, so the dispatcher learns on every start
//                    which key it is deciding about, and can check that its
//                    line still stands in the file. The fingerprint is
//                    computed here from the blob; no caller can supply it.
//   from=            the pinned source hosts.
//   verify-required  PIN on every login. Known from 8.4; on 8.2 the option is
//                    unknown and sshd drops the whole line, so the builder
//                    refuses to build for anything older than 8.4.
//   NO expiry-time   on purpose. The line is not what opens the door: the
//                    dispatcher decides at every start. An expiry in the line
//                    was also a measured source of silently dead lines (a `Z`
//                    stamp is rejected below 9.2, a local stamp is read in
//                    sshd's own zone), and without it the line has one shape
//                    on every supported sshd.
//   NEVER            no-touch-required, pty, any forwarding option, user-rc,
//                    permitopen, permitlisten, tunnel, environment,
//                    cert-authority.
import {
  SUPPORT_KEY_TYPE,
  SUPPORT_MAX_FROM,
  fingerprintOfBlob,
  isExactHostCidr,
  parseSkEd25519Blob,
  validateSupportPins,
  type SupportKeyPin,
} from './support-access-pins.js'

/** Every support line's comment starts with this; `marveen-remote:` lines belong to the Bridge. */
export const SUPPORT_COMMENT_PREFIX = 'marveen-support:'

export interface SshdVersion {
  readonly major: number
  readonly minor: number
}

/** `verify-required` is known from here (measured: 8.2 drops the line, 8.4 accepts it). */
export const SUPPORT_MIN_SSHD: SshdVersion = { major: 8, minor: 4 }

export type SupportLineProblem =
  | 'key_invalid'
  | 'grant_id_invalid'
  | 'consent_version_invalid'
  | 'install_path_unsupported'
  | 'from_invalid'
  | 'sshd_too_old'
  | 'pins_invalid'
  | 'line_refused'

/** Raised when the builder is asked for a line it must never emit. */
export class SupportLineError extends Error {
  readonly code: SupportLineProblem
  constructor(code: SupportLineProblem, message: string) {
    super(message)
    this.name = 'SupportLineError'
    this.code = code
  }
}

export interface SupportLineInput {
  readonly key: SupportKeyPin
  /** One id per grant, shared by all its lines. */
  readonly grantId: string
  readonly consentVersion: number
  /** Absolute path of the dispatcher script. */
  readonly dispatchPath: string
  readonly fromCidrs: readonly string[]
  /** The sshd that will read the line; below 8.4 no line is built. */
  readonly sshd: SshdVersion
}

const KEY_NAME = /^[a-z0-9]{1,16}$/
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// sshd hands command= to the login shell. A path with a space, a quote, a `$`
// or a `;` would run something else or break the option quoting, so only this
// alphabet is accepted; any other install path gets no support line at all.
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/

export function sshdAtLeast(version: SshdVersion, floor: SshdVersion): boolean {
  return version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor)
}

/** The comment of the line for one key of one grant. */
export function supportLineComment(grantId: string, keyName: string): string {
  return SUPPORT_COMMENT_PREFIX + grantId + ':' + keyName
}

/**
 * Build the one canonical line for one pinned key. THE ONLY LINE FACTORY: every
 * value comes from the pins and the consent record handed in by the caller;
 * nothing a request, a network answer or the environment says can reach it.
 * Throws rather than emit a line that would be wider than intended, or dead
 * on arrival.
 */
export function buildSupportLine(input: SupportLineInput): string {
  const { key, grantId, consentVersion, dispatchPath, fromCidrs, sshd } = input
  if (!KEY_NAME.test(key.name) || !parseSkEd25519Blob(key.pub).ok) {
    throw new SupportLineError('key_invalid', 'the key is not a named ' + SUPPORT_KEY_TYPE + ' key')
  }
  if (!GRANT_ID.test(grantId)) throw new SupportLineError('grant_id_invalid', 'the grant id is not a lowercase UUID v4')
  if (!Number.isInteger(consentVersion) || consentVersion < 1 || consentVersion > 9999) {
    throw new SupportLineError('consent_version_invalid', 'the consent version is not a small positive integer')
  }
  if (!SAFE_ABSOLUTE_PATH.test(dispatchPath)) {
    throw new SupportLineError('install_path_unsupported', 'the dispatcher path contains a character a bound command cannot carry')
  }
  if (fromCidrs.length < 1 || fromCidrs.length > SUPPORT_MAX_FROM || !fromCidrs.every(isExactHostCidr)) {
    throw new SupportLineError('from_invalid', 'the source list is not one or two exact hosts')
  }
  if (!sshdAtLeast(sshd, SUPPORT_MIN_SSHD)) {
    throw new SupportLineError('sshd_too_old', 'verify-required is unknown to this sshd; the line would be silently dead')
  }
  // `SHA256:` and 43 characters of A-Z a-z 0-9 + /: nothing the login shell or the option quoting reads as special.
  const fingerprint = fingerprintOfBlob(key.pub)
  const command =
    '/bin/sh ' + dispatchPath + ' --key ' + key.name + ' --fp ' + fingerprint + ' --grant ' + grantId + ' --consent ' + consentVersion
  const options = 'restrict,command="' + command + '",from="' + fromCidrs.join(',') + '",verify-required'
  return options + ' ' + SUPPORT_KEY_TYPE + ' ' + key.pub + ' ' + supportLineComment(grantId, key.name)
}

/** What one grant is made of: the pinned keys and sources, and the consent record. */
export interface SupportGrantInput {
  /** The pinned keys; the grant gets one line for each. */
  readonly keys: readonly SupportKeyPin[]
  readonly fromCidrs: readonly string[]
  readonly grantId: string
  readonly consentVersion: number
  readonly dispatchPath: string
  readonly sshd: SshdVersion
}

/**
 * Build every line of one grant, one per key. The keys and sources must pass
 * the same check as the pinned lists as a whole (count, distinct names and
 * keys, a fingerprint that belongs to its key): a set the pins check would
 * refuse gets no line. This is what the on-disk writers call; they never see
 * a line made anywhere else.
 */
export function buildSupportGrantLines(grant: SupportGrantInput): string[] {
  const pins = validateSupportPins(grant.keys, grant.fromCidrs)
  if (!pins.ok) throw new SupportLineError('pins_invalid', 'the keys and sources do not pass the pins check: ' + pins.reason)
  return grant.keys.map((key) =>
    buildSupportLine({
      key,
      grantId: grant.grantId,
      consentVersion: grant.consentVersion,
      dispatchPath: grant.dispatchPath,
      fromCidrs: grant.fromCidrs,
      sshd: grant.sshd,
    }),
  )
}

export interface AuthorizedKeysFields {
  /** The options field exactly as written, or null when the line starts with the key type. */
  readonly options: string | null
  readonly keyType: string
  readonly blob: string
  /** Everything after the blob, trimmed (may be empty). */
  readonly comment: string
}

const KEY_TYPE_NAME =
  /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)(-cert-v01@openssh\.com)?$/

/** Read one whitespace-delimited field, honouring double quotes (with \" inside) the way an options field needs. */
function readField(line: string, start: number): { value: string; next: number } | null {
  let i = start
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  if (i >= line.length) return null
  const begin = i
  let quoted = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '\\' && line[i + 1] === '"') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === ' ' || c === '\t') break
  }
  if (quoted) return null
  return { value: line.slice(begin, i), next: i }
}

/**
 * Split an authorized_keys line into its fields. Returns null for a blank line,
 * a `#` comment, or anything that does not read as `[options] type blob [comment]`.
 */
export function splitAuthorizedKeysLine(line: string): AuthorizedKeysFields | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null
  const first = readField(trimmed, 0)
  if (first === null) return null
  let options: string | null = null
  let type = first
  if (!KEY_TYPE_NAME.test(first.value)) {
    options = first.value
    const second = readField(trimmed, first.next)
    if (second === null || !KEY_TYPE_NAME.test(second.value)) return null
    type = second
  }
  const blob = readField(trimmed, type.next)
  if (blob === null) return null
  return { options, keyType: type.value, blob: blob.value, comment: trimmed.slice(blob.next).trim() }
}

/**
 * Is this line support access? Yes when its comment carries the support prefix
 * OR it holds one of the pinned key blobs, whatever the rest says. The second
 * half matters: a copy of a pinned key with looser options and another comment
 * is still our key on the customer's machine, and must go when support goes.
 * A blank line or a `#` comment is never a support line (sshd ignores it).
 */
export function isSupportLine(line: string, pinnedBlobs: ReadonlySet<string>): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return false
  const fields = splitAuthorizedKeysLine(trimmed)
  if (fields === null) {
    // Unreadable (for instance an unbalanced quote). Fall back to plain words so
    // a mangled copy of our line does not survive by being mangled.
    const words = trimmed.split(/\s+/)
    return words.some((w) => w.startsWith(SUPPORT_COMMENT_PREFIX) || pinnedBlobs.has(w))
  }
  if (pinnedBlobs.has(fields.blob)) return true
  return fields.comment.split(/\s+/).some((w) => w.startsWith(SUPPORT_COMMENT_PREFIX))
}

function splitLines(existing: string): string[] {
  const lines = existing.length ? existing.split('\n') : []
  // A file that ends in a newline yields a trailing '' element; drop it so it
  // does not become a spurious blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(lines: readonly string[]): string {
  let content = lines.join('\n')
  if (content.length > 0 && !content.endsWith('\n')) content += '\n'
  return content
}

export interface RemoveSupportResult {
  readonly content: string
  readonly removed: number
}

/** Remove EVERY support line. Every other line, the Bridge's included, is kept byte for byte. */
export function removeSupportLines(existing: string, pinnedBlobs: ReadonlySet<string>): RemoveSupportResult {
  const lines = splitLines(existing)
  const kept = lines.filter((line) => !isSupportLine(line, pinnedBlobs))
  const removed = lines.length - kept.length
  return { content: removed === 0 ? existing : joinLines(kept), removed }
}

/** How many support lines the content holds. */
export function countSupportLines(existing: string, pinnedBlobs: ReadonlySet<string>): number {
  return splitLines(existing).filter((line) => isSupportLine(line, pinnedBlobs)).length
}

export interface MergeSupportResult {
  readonly content: string
  /** Support lines that were there before and are gone now (a re-grant replaces them). */
  readonly replaced: number
}

/**
 * Put a grant's lines in: every earlier support line goes (one grant per
 * machine), then the new lines are appended. There is no "key already present"
 * case left to refuse, because any line that holds a pinned key IS a support
 * line and is replaced by the canonical one.
 *
 * A new line is refused, and nothing is merged, when it holds anything but
 * printable ASCII, or when it is not recognised as a support line (no later
 * removal or reconcile would ever take it out again). A built line is
 * printable ASCII by construction (key name, path, grant id and blob
 * alphabets). A line break or a carriage return would reach the file as more
 * than one line, and the extra one could be any key; a NUL, a vertical tab or
 * a form feed could hide a second key from this check without anyone having
 * measured how sshd reads them.
 *
 * THIS IS THE SECOND LAYER, NOT THE BUILDER. It accepts whatever the
 * recogniser calls ours, and that includes a line with no options at all that
 * only carries our comment prefix: the "treated as ours" choice of
 * isSupportLine, seen from the write side. What makes a written line the
 * closed option list is that the on-disk writers pass nothing here but the
 * output of buildSupportGrantLines.
 */
export function mergeSupportLines(
  existing: string,
  newLines: readonly string[],
  pinnedBlobs: ReadonlySet<string>,
): MergeSupportResult {
  if (newLines.length === 0) throw new Error('mergeSupportLines needs at least one line')
  for (const line of newLines) {
    if (/[^\x20-\x7e]/.test(line)) {
      throw new SupportLineError('line_refused', 'a line to write holds a character that is not printable ASCII')
    }
    if (!isSupportLine(line, pinnedBlobs)) {
      throw new SupportLineError('line_refused', 'a line to write is not recognised as a support line')
    }
  }
  const kept = splitLines(existing).filter((line) => !isSupportLine(line, pinnedBlobs))
  const replaced = splitLines(existing).length - kept.length
  return { content: joinLines([...kept, ...newLines]), replaced }
}

export interface ReconcileSupportResult {
  readonly content: string
  /** Expected lines found exactly as built. */
  readonly kept: number
  /** Support lines that are not an expected line: edited, loosened, copied, left over. Removed. */
  readonly removed: number
  /** Expected lines that are not in the file. They are NOT created. */
  readonly missing: number
}

/**
 * Compare the file with what the live grant says should be there. Every
 * support line that is not, byte for byte, one of the expected lines is
 * removed (an added option, a dropped option, a second copy, a line of a
 * revoked grant); a second copy of an expected line is removed too. Nothing is
 * ever added. With no live grant, `expected` is empty and every support line goes.
 */
export function reconcileSupportLines(
  existing: string,
  expected: readonly string[],
  pinnedBlobs: ReadonlySet<string>,
): ReconcileSupportResult {
  const wanted = new Set(expected)
  const seen = new Set<string>()
  let removed = 0
  const kept = splitLines(existing).filter((line) => {
    if (wanted.has(line) && !seen.has(line)) {
      seen.add(line)
      return true
    }
    if (wanted.has(line) || isSupportLine(line, pinnedBlobs)) {
      removed++
      return false
    }
    return true
  })
  return {
    content: removed === 0 ? existing : joinLines(kept),
    kept: seen.size,
    removed,
    missing: wanted.size - seen.size,
  }
}
