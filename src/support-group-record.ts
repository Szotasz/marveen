// Support access: the GROUP RECORD of one enabling, on disk next to the token.
//
//   <support folder>/support-access.token   the narrow token (support-access-token.ts)
//   <support folder>/support-access.group   this record
//   <support folder>/kit/                   the swapped kit (support-kit.ts)
//
// The record holds the inputs a support line is built from, except the key
// bytes: a key is named with its fingerprint, and whoever rebuilds the lines
// (the reconcile) takes the key itself from the pins of the release that runs.
// A key that is no longer pinned, or pinned with another fingerprint, then
// cannot be rebuilt, and its line goes. The record also carries the consent
// version and time, which the consent table copies (Samu 78359, Q1).
//
// It is never printed as it is: the status reports what it means, not what it
// says (Geri 78368: the consent and the source addresses can be customer data).
//
// One canonical text, one fact per line, as the kit manifest: only the text
// this module writes is read back as a record.
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'

export const SUPPORT_GROUP_RECORD_FILE = 'support-access.group'
/** Working names of the other state next to the token (Geri 78364): the login spool and the folder of running dispatchers. */
export const SUPPORT_SPOOL_DIR = 'support-access.spool'
export const SUPPORT_RUN_DIR = 'support-access.run'

const HEADER = 'marveen-support-group 1'
const RECORD_MODE = 0o600
export const GROUP_RECORD_MAX_BYTES = 2048

const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const KEY_NAME = /^[a-z0-9]{1,16}$/
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const CIDR = /^[0-9A-Fa-f:.]+\/(?:32|128)$/
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export interface SupportGroupRecord {
  readonly grantId: string
  readonly consentVersion: number
  /** When the owner consented, UTC to the second. */
  readonly consentAt: string
  /** The keys of the group, by name and fingerprint, in name order. */
  readonly keys: readonly { readonly name: string; readonly fingerprint: string }[]
  readonly fromCidrs: readonly string[]
  /** The kit's dispatcher, the path the lines bind. */
  readonly dispatchPath: string
  readonly sshd: { readonly major: number; readonly minor: number }
}

export type GroupRecordProblem = 'group_record_invalid' | 'group_dir_unsafe' | 'group_record_unsafe' | 'group_record_readback'

export class GroupRecordError extends Error {
  readonly code: GroupRecordProblem
  constructor(code: GroupRecordProblem, message: string) {
    super(message)
    this.name = 'GroupRecordError'
    this.code = code
  }
}

function recordProblem(r: SupportGroupRecord): string | null {
  if (!GRANT_ID.test(r.grantId)) return 'the grant id is not a uuid'
  if (!Number.isInteger(r.consentVersion) || r.consentVersion < 1 || r.consentVersion > 9999) return 'the consent version is not a small positive number'
  if (!UTC_SECOND.test(r.consentAt) || Number.isNaN(Date.parse(r.consentAt))) return 'the consent time is not a UTC second'
  if (r.keys.length < 1 || r.keys.length > 2) return 'a group has one or two keys'
  const names = r.keys.map((k) => k.name)
  if (new Set(names).size !== names.length || names.join('\n') !== [...names].sort().join('\n')) return 'the keys are not distinct and in name order'
  if (!r.keys.every((k) => KEY_NAME.test(k.name) && FINGERPRINT.test(k.fingerprint))) return 'a key is not a name and a fingerprint'
  if (r.fromCidrs.length < 1 || r.fromCidrs.length > 2 || !r.fromCidrs.every((c) => CIDR.test(c))) return 'the sources are not one or two host addresses'
  if (!SAFE_ABSOLUTE_PATH.test(r.dispatchPath)) return 'the dispatcher path is not a plain absolute path'
  const { major, minor } = r.sshd
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 1 || major > 99 || minor < 0 || minor > 99) return 'the sshd version is not a version'
  return null
}

/** The record as its one canonical text. Throws for a record that could not be read back. */
export function formatGroupRecord(r: SupportGroupRecord): string {
  const problem = recordProblem(r)
  if (problem !== null) throw new GroupRecordError('group_record_invalid', problem)
  const lines = [HEADER, 'grant-id ' + r.grantId, 'consent ' + r.consentVersion, 'consent-at ' + r.consentAt]
  for (const k of r.keys) lines.push('key ' + k.name + ' ' + k.fingerprint)
  for (const c of r.fromCidrs) lines.push('from ' + c)
  lines.push('dispatch ' + r.dispatchPath, 'sshd ' + r.sshd.major + '.' + r.sshd.minor)
  return lines.join('\n') + '\n'
}

/** The record, or null for any text that is not exactly the canonical form. */
export function parseGroupRecord(text: string): SupportGroupRecord | null {
  if (text.length > GROUP_RECORD_MAX_BYTES || !text.endsWith('\n')) return null
  const lines = text.slice(0, -1).split('\n')
  if (lines[0] !== HEADER) return null
  const single = new Map<string, string>()
  const keys: { name: string; fingerprint: string }[] = []
  const fromCidrs: string[] = []
  for (const line of lines.slice(1)) {
    const parts = line.split(' ')
    if (parts[0] === 'key' && parts.length === 3) keys.push({ name: parts[1], fingerprint: parts[2] })
    else if (parts[0] === 'from' && parts.length === 2) fromCidrs.push(parts[1])
    else if (['grant-id', 'consent', 'consent-at', 'dispatch', 'sshd'].includes(parts[0]) && parts.length === 2) {
      if (single.has(parts[0])) return null
      single.set(parts[0], parts[1])
    } else return null
  }
  const sshd = /^(\d{1,2})\.(\d{1,2})$/.exec(single.get('sshd') ?? '')
  const consent = single.get('consent') ?? ''
  const record: SupportGroupRecord = {
    grantId: single.get('grant-id') ?? '',
    consentVersion: /^[1-9][0-9]{0,3}$/.test(consent) ? Number(consent) : NaN,
    consentAt: single.get('consent-at') ?? '',
    keys,
    fromCidrs,
    dispatchPath: single.get('dispatch') ?? '',
    sshd: { major: sshd === null ? NaN : Number(sshd[1]), minor: sshd === null ? NaN : Number(sshd[2]) },
  }
  if (recordProblem(record) !== null) return null
  return formatGroupRecord(record) === text ? record : null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function effectiveUid(): number | null {
  return typeof process.geteuid === 'function' ? process.geteuid() : null
}

/** The support folder must be a real folder of this user that group and others cannot write (as for the token). */
function dirIsSafe(dir: string): boolean {
  const st = lstatOrNull(dir)
  const uid = effectiveUid()
  return st !== null && st.isDirectory() && (st.mode & 0o022) === 0 && (uid === null || st.uid === uid)
}

export type GroupRecordRead =
  | { readonly kind: 'ok'; readonly record: SupportGroupRecord }
  | { readonly kind: 'missing' }
  /** Something is at the path and it is not a record of ours. It is NOT used. */
  | { readonly kind: 'invalid' }

/** Read the record: one open without following a link, every check on that descriptor, at most the cap. */
export function readGroupRecord(supportDir: string): GroupRecordRead {
  const dir = lstatOrNull(supportDir)
  if (dir === null) return { kind: 'missing' }
  if (!dirIsSafe(supportDir)) return { kind: 'invalid' }
  let fd: number
  try {
    fd = openSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' }
  }
  try {
    const st = fstatSync(fd)
    const uid = effectiveUid()
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) return { kind: 'invalid' }
    const buf = Buffer.alloc(GROUP_RECORD_MAX_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > GROUP_RECORD_MAX_BYTES) return { kind: 'invalid' }
    const record = parseGroupRecord(buf.subarray(0, n).toString('latin1'))
    return record === null ? { kind: 'invalid' } : { kind: 'ok', record }
  } finally {
    closeSync(fd)
  }
}

/**
 * Write the record: a new 0600 file in the same folder (mode set on the
 * descriptor), synced, renamed over the target, read back. A read-back that is
 * not exactly this record removes the file.
 */
export function writeGroupRecord(supportDir: string, record: SupportGroupRecord): void {
  const text = formatGroupRecord(record)
  if (!dirIsSafe(supportDir)) throw new GroupRecordError('group_dir_unsafe', 'the support folder is missing, not a folder of this user, or writable by others')
  const target = join(supportDir, SUPPORT_GROUP_RECORD_FILE)
  const existing = lstatOrNull(target)
  if (existing !== null && !existing.isFile()) throw new GroupRecordError('group_record_unsafe', 'something that is not a regular file stands at the record path')
  const tmp = join(supportDir, '.' + SUPPORT_GROUP_RECORD_FILE + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp')
  const fd = openSync(tmp, 'wx', RECORD_MODE)
  try {
    try {
      fchmodSync(fd, RECORD_MODE)
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
    throw err
  }
  const back = readGroupRecord(supportDir)
  if (back.kind !== 'ok' || formatGroupRecord(back.record) !== text) {
    removeGroupRecord(supportDir)
    throw new GroupRecordError('group_record_readback', 'the record file does not hold what was written')
  }
}

/** Remove the record: whatever stands at the path (a link as a link). Idempotent; true when something was removed. */
export function removeGroupRecord(supportDir: string): boolean {
  const target = join(supportDir, SUPPORT_GROUP_RECORD_FILE)
  if (lstatOrNull(target) === null) return false
  unlinkSync(target)
  if (lstatOrNull(target) !== null) throw new GroupRecordError('group_record_unsafe', 'the record file is still there after the removal')
  return true
}

/**
 * Stop every running dispatcher on this machine (D4): each one watches its own pid file in
 * the run folder (and the token) about five times a second, and stops its subcommand when the
 * file is gone. Only names of digits that are regular files go; a run folder that is a link
 * is left alone (the dispatcher refuses to start with one). Returns how many files went.
 */
export function stopRunningDispatchers(supportDir: string): number {
  const dir = join(supportDir, SUPPORT_RUN_DIR)
  const st = lstatOrNull(dir)
  if (st === null || !st.isDirectory()) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!/^[0-9]{1,10}$/.test(name)) continue
    const target = join(dir, name)
    if (!lstatOrNull(target)?.isFile()) continue
    try {
      unlinkSync(target)
      removed++
    } catch {
      // gone between the listing and the removal: that dispatcher ended by itself
    }
  }
  return removed
}
