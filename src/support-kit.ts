// Support access: the KIT, the handful of files that live OUTSIDE the install
// tree so that support access does not depend on the tree being whole.
//
//   <support folder>/            token, spool, run folder, the kit lock
//   <support folder>/kit/        the swapped subfolder: the files of ONE release
//                                (launcher, dispatcher, the routine's file) and
//                                the manifest that names them
//
// The line in authorized_keys binds the dispatcher INSIDE the swapped
// subfolder, at a fixed path. The state next to it (token, spool) is never
// touched by a swap.
//
// HOW THE KIT IS REPLACED. A folder cannot be renamed onto a folder that is
// not empty (measured on macOS and Linux: ENOTEMPTY), and the fixed path must
// not be a link (the launcher stops on one). So a replacement is TWO renames
// under the kit lock: the old folder is set aside, the new one takes its
// place, the old one is deleted. Between the two renames nothing stands at the
// fixed path: a login that arrives then finds no dispatcher and is refused,
// and the launcher stops with "kit missing". That is intended. If the process
// dies between the two renames, the next write finishes the job: it removes
// what was left and writes the kit again.
//
// WHERE THE HASHES COME FROM. Every file is written from the tree, but its
// sha256 is a value STORED IN THE REPO next to the file. The writer measures
// the tree's file against that value before anything is written (a file that
// was already damaged in the tree must not be certified by hashing it), and
// measures the copy again after it is written. The manifest carries the same
// stored values.
//
// WHAT THIS DOES NOT PROTECT AGAINST: someone who writes as the install user
// can rewrite the manifest together with the files. The checks here catch a
// damaged, half-written or mixed kit, not that.
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const KIT_SUBFOLDER = 'kit'
export const KIT_MANIFEST_NAME = 'manifest'
export const KIT_LOCK_NAME = 'kit.lock'
const KIT_MANIFEST_HEADER = 'marveen-support-kit 1'

export type KitProblem =
  | 'kit_input_invalid'
  | 'kit_source_mismatch'
  | 'kit_locked'
  | 'kit_missing'
  | 'kit_link'
  | 'kit_not_a_folder'
  | 'kit_foreign_owner'
  | 'kit_manifest_unreadable'
  | 'kit_file_missing'
  | 'kit_mismatch'

/** Raised when the kit cannot be written, or is not what its manifest says. */
export class KitError extends Error {
  readonly code: KitProblem
  constructor(code: KitProblem, message: string) {
    super(message)
    this.name = 'KitError'
    this.code = code
  }
}

export interface KitManifest {
  /** File name to sha256 (lower case hex), for every file of the kit but the manifest itself. */
  readonly files: Readonly<Record<string, string>>
  /** The install tree this kit was written from. */
  readonly installRoot: string
  /** The node that runs the service: the launcher starts the routine with it. */
  readonly nodePath: string
  /** The commit of the release the files are from. */
  readonly release: string
}

const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const RELEASE = /^[0-9a-f]{7,40}$/
// The same alphabet the line builder accepts for the dispatcher path: a kit
// that could not be bound in a line is not written.
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/
const LEFTOVER = /^\.kit-(?:new|old)-[0-9a-f]{16}$/

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifestProblem(m: KitManifest): string | null {
  const names = Object.keys(m.files)
  if (names.length === 0) return 'the kit has no file'
  for (const name of names) {
    if (!FILE_NAME.test(name) || name === KIT_MANIFEST_NAME) return 'a file name is not a plain lower case name'
    if (!SHA256_HEX.test(m.files[name])) return 'a hash is not 64 lower case hex digits'
  }
  if (!SAFE_ABSOLUTE_PATH.test(m.installRoot)) return 'the install root is not a plain absolute path'
  if (!SAFE_ABSOLUTE_PATH.test(m.nodePath)) return 'the node path is not a plain absolute path'
  if (!RELEASE.test(m.release)) return 'the release is not a commit id'
  return null
}

/**
 * The manifest as text: one fact per line, a key and its value separated by
 * one space, so the dispatcher and the launcher (POSIX sh) can read it without
 * any tool. The files come in name order, so the same kit always gives the
 * same text. Throws for a manifest that could not be read back.
 */
export function formatKitManifest(m: KitManifest): string {
  const problem = manifestProblem(m)
  if (problem !== null) throw new KitError('kit_input_invalid', problem)
  const lines = [KIT_MANIFEST_HEADER]
  for (const name of Object.keys(m.files).sort()) lines.push('file ' + name + ' ' + m.files[name])
  lines.push('install-root ' + m.installRoot, 'node ' + m.nodePath, 'release ' + m.release)
  return lines.join('\n') + '\n'
}

/**
 * Read a manifest, or null for anything that is not exactly the format: a
 * missing or repeated line, an unknown key, a second space, a blank line, a
 * carriage return, text after the last line. A manifest is not something to
 * be lenient with: what it says decides which file is run.
 */
export function parseKitManifest(text: string): KitManifest | null {
  if (!text.endsWith('\n')) return null
  const lines = text.slice(0, -1).split('\n')
  if (lines[0] !== KIT_MANIFEST_HEADER) return null
  const files: Record<string, string> = {}
  const single = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const parts = line.split(' ')
    if (parts[0] === 'file' && parts.length === 3) {
      if (Object.prototype.hasOwnProperty.call(files, parts[1])) return null
      files[parts[1]] = parts[2]
    } else if ((parts[0] === 'install-root' || parts[0] === 'node' || parts[0] === 'release') && parts.length === 2) {
      if (single.has(parts[0])) return null
      single.set(parts[0], parts[1])
    } else return null
  }
  const manifest = {
    files,
    installRoot: single.get('install-root') ?? '',
    nodePath: single.get('node') ?? '',
    release: single.get('release') ?? '',
  }
  if (manifestProblem(manifest) !== null) return null
  // Only the one canonical text is a manifest (the files in name order, the three facts last).
  return formatKitManifest(manifest) === text ? manifest : null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** The uid this process runs as, or null where there is no such thing. */
function ownUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

type Finding = { problem: KitProblem; detail: string } | null

/** A folder of the kit must be a real folder (no link) that belongs to the user. */
function folderFinding(path: string, uid: number | null): Finding {
  const st = lstatOrNull(path)
  if (st === null) return { problem: 'kit_missing', detail: path + ' does not exist' }
  if (st.isSymbolicLink()) return { problem: 'kit_link', detail: path + ' is a symbolic link' }
  if (!st.isDirectory()) return { problem: 'kit_not_a_folder', detail: path + ' is not a folder' }
  if (uid !== null && st.uid !== uid) return { problem: 'kit_foreign_owner', detail: path + ' belongs to another user' }
  return null
}

/** A file of the kit must be a regular file (no link) that belongs to the user. */
function fileFinding(path: string, uid: number | null): Finding {
  const st = lstatOrNull(path)
  if (st === null) return { problem: 'kit_file_missing', detail: path + ' does not exist' }
  if (st.isSymbolicLink()) return { problem: 'kit_link', detail: path + ' is a symbolic link' }
  if (!st.isFile()) return { problem: 'kit_mismatch', detail: path + ' is not a regular file' }
  if (uid !== null && st.uid !== uid) return { problem: 'kit_foreign_owner', detail: path + ' belongs to another user' }
  return null
}

export type KitVerdict =
  | { readonly ok: true; readonly kitDir: string; readonly manifest: KitManifest }
  | { readonly ok: false; readonly problem: KitProblem; readonly detail: string }

/**
 * Is the kit on this machine what its manifest says? Checked every time it is
 * asked, never remembered: the support folder and the swapped subfolder are
 * real folders of this user, the manifest reads, and every file it names is a
 * regular file of this user with exactly the manifest's hash. A file in the
 * folder that the manifest does not name is ignored: nothing ever runs it.
 * `uid` is for tests; the default is the uid of this process.
 */
export function verifyKit(opts: { supportDir: string; uid?: number | null }): KitVerdict {
  const supportDir = resolve(opts.supportDir)
  const uid = opts.uid === undefined ? ownUid() : opts.uid
  const kitDir = join(supportDir, KIT_SUBFOLDER)
  const refuse = (finding: NonNullable<Finding>): KitVerdict => ({ ok: false, ...finding })
  for (const folder of [supportDir, kitDir]) {
    const finding = folderFinding(folder, uid)
    if (finding !== null) return refuse(finding)
  }
  const manifestPath = join(kitDir, KIT_MANIFEST_NAME)
  const manifestFinding = fileFinding(manifestPath, uid)
  if (manifestFinding !== null) {
    return refuse(manifestFinding.problem === 'kit_file_missing' ? { problem: 'kit_manifest_unreadable', detail: manifestFinding.detail } : manifestFinding)
  }
  const manifest = parseKitManifest(readFileSync(manifestPath, 'latin1'))
  if (manifest === null) return refuse({ problem: 'kit_manifest_unreadable', detail: manifestPath + ' is not a manifest' })
  for (const name of Object.keys(manifest.files).sort()) {
    const path = join(kitDir, name)
    const finding = fileFinding(path, uid)
    if (finding !== null) return refuse(finding)
    if (sha256Hex(readFileSync(path)) !== manifest.files[name]) {
      return refuse({ problem: 'kit_mismatch', detail: path + ' is not the file the manifest names' })
    }
  }
  return { ok: true, kitDir, manifest }
}

export interface KitLockTuning {
  lockRetries?: number
  lockRetryDelayMs?: number
  staleLockMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Run `work` while holding the kit lock of a support folder. The writer holds
 * it for a whole replacement, and the reconcile holds it while it looks at the
 * kit and acts on what it saw, so a reconcile never sees the gap between the
 * two renames. `work` must be synchronous for the same reason the keys file
 * transform must be: a lock older than `staleLockMs` is taken to be left over
 * by a dead process and is removed.
 */
export async function withKitLock<T>(supportDir: string, tuning: KitLockTuning, work: () => T): Promise<T> {
  const { lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15000, sleep = defaultSleep } = tuning
  const lockPath = join(resolve(supportDir), KIT_LOCK_NAME)
  let fd: number | null = null
  for (let attempt = 0; attempt < lockRetries && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > staleLockMs
      } catch {
        continue // the lock went away between the two calls: try again at once
      }
      if (stale) {
        try {
          unlinkSync(lockPath)
        } catch {
          /* someone else removed it */
        }
        continue
      }
      await sleep(lockRetryDelayMs)
    }
  }
  if (fd === null) {
    throw new KitError('kit_locked', `could not take ${lockPath} after ${lockRetries} attempts; another kit write or a reconcile is running`)
  }
  try {
    const out = work()
    if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
      throw new KitError('kit_input_invalid', 'the work under the kit lock returned a promise; nothing slow may run while the lock is held')
    }
    return out
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
  }
}

export interface KitFileSource {
  /** The name in the kit: a plain lower case name, not `manifest`. */
  readonly name: string
  /** The bytes of the tree's file. */
  readonly content: Uint8Array
  /** The sha256 STORED IN THE REPO for this file. Never computed from `content` by the caller. */
  readonly sha256: string
  /** True for a file the user starts directly (the launcher): 0700. Everything else is 0600. */
  readonly executable: boolean
}

export interface WriteKitOptions extends KitLockTuning {
  supportDir: string
  files: readonly KitFileSource[]
  installRoot: string
  nodePath: string
  release: string
}

export interface WriteKitResult {
  kitDir: string
  /** True when a kit stood at the fixed path and was replaced. */
  replaced: boolean
  /** Folders an earlier, interrupted write had left behind; removed by this one. */
  cleaned: string[]
}

function writeNewFile(path: string, content: Uint8Array, mode: number): void {
  const fd = openSync(path, 'wx', mode)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncFolder(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* not every file system lets a folder be synced; the renames themselves are what matters */
  }
}

/**
 * Write the kit of one release and put it at the fixed path.
 *
 * Refused before anything is written: a name, hash, path or release that is
 * not plain; a file of the tree that does not have the hash stored for it in
 * the repo; a support folder or a kit path that is a link, is not a folder or
 * belongs to another user. Under the kit lock: what an interrupted write left
 * behind is removed, the files and the manifest are written into a new folder
 * next to the kit (same file system, 0700) and read back against the stored
 * hashes, then the old kit is set aside, the new one takes its place and the
 * old one is deleted. The result is verified once more before the lock is
 * given up.
 */
export async function writeKit(opts: WriteKitOptions): Promise<WriteKitResult> {
  const { files, installRoot, nodePath, release, ...tuning } = opts
  const supportDir = resolve(opts.supportDir)
  if (!SAFE_ABSOLUTE_PATH.test(supportDir)) {
    throw new KitError('kit_input_invalid', 'the support folder is not a plain absolute path')
  }
  const hashes: Record<string, string> = {}
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(hashes, file.name)) throw new KitError('kit_input_invalid', 'a file name is given twice')
    hashes[file.name] = file.sha256
  }
  const manifest: KitManifest = { files: hashes, installRoot, nodePath, release }
  const manifestText = formatKitManifest(manifest) // throws kit_input_invalid
  for (const file of files) {
    if (sha256Hex(file.content) !== file.sha256) {
      throw new KitError('kit_source_mismatch', `${file.name} in the install tree is not the file of this release (its hash is not the stored one); nothing was written`)
    }
  }

  const uid = ownUid()
  if (lstatOrNull(supportDir) === null) mkdirSync(supportDir, { recursive: true, mode: 0o700 })
  const parentFinding = folderFinding(supportDir, uid)
  if (parentFinding !== null) throw new KitError(parentFinding.problem, parentFinding.detail + '; the kit is not written there')
  const kitDir = join(supportDir, KIT_SUBFOLDER)

  return withKitLock(supportDir, tuning, () => {
    // What an interrupted write left behind. A link under such a name is removed as a link, never followed.
    const cleaned: string[] = []
    for (const name of readdirSync(supportDir).sort()) {
      if (!LEFTOVER.test(name)) continue
      rmSync(join(supportDir, name), { recursive: true, force: true })
      cleaned.push(name)
    }
    const existing = lstatOrNull(kitDir)
    if (existing !== null) {
      const finding = folderFinding(kitDir, uid)
      if (finding !== null) throw new KitError(finding.problem, finding.detail + '; the kit is not written over it')
    }

    const suffix = randomBytes(8).toString('hex')
    const staging = join(supportDir, '.kit-new-' + suffix)
    const aside = join(supportDir, '.kit-old-' + suffix)
    mkdirSync(staging, { mode: 0o700 })
    try {
      for (const file of files) writeNewFile(join(staging, file.name), file.content, file.executable ? 0o700 : 0o600)
      writeNewFile(join(staging, KIT_MANIFEST_NAME), Buffer.from(manifestText, 'latin1'), 0o600)
      for (const file of files) {
        if (sha256Hex(readFileSync(join(staging, file.name))) !== file.sha256) {
          throw new KitError('kit_mismatch', `${file.name} does not hold what was just written`)
        }
      }
      syncFolder(staging)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err
    }

    // THE TWO RENAMES. Between them nothing stands at the fixed path.
    if (existing !== null) {
      try {
        renameSync(kitDir, aside)
      } catch (err) {
        // Nothing was swapped yet: the standing kit is whole, so leave nothing else behind.
        rmSync(staging, { recursive: true, force: true })
        throw err
      }
    }
    // If THIS rename fails, the fixed path stays empty and both folders stay
    // where they are: the next write removes them. The old kit is not put
    // back, a kit that could not be replaced is treated as a missing one.
    renameSync(staging, kitDir)
    syncFolder(supportDir)
    if (existing !== null) rmSync(aside, { recursive: true, force: true })

    const verdict = verifyKit({ supportDir })
    if (!verdict.ok) throw new KitError(verdict.problem, 'the kit that was just written does not verify: ' + verdict.detail)
    return { kitDir, replaced: existing !== null, cleaned }
  })
}
