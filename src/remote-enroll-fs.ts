// Filesystem side of remote access key enrollment.
//
// Kept separate from the pure logic in remote-enroll-core.ts so the read-
// modify-write, permission handling, atomic replace, and lockfile behaviour
// can be tested against a temporary directory instead of the real ~/.ssh.

import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  lstatSync,
  existsSync,
  chmodSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { mergeAuthorizedKeys, removeAuthorizedKey, rewriteServicePorts, type MergeAction } from './remote-enroll-core.js'
import { isTestRun } from './test-run-marker.js'
import { realSshDir, describeTestRunSignal, SshDirGuardError } from './ssh-dir.js'

/**
 * ENROLL813 CHOKEPOINT -- the last line, and the only one every writer shares.
 *
 * All three exported writers below take `sshDir` as a PARAMETER, so whether the
 * real ~/.ssh gets touched is decided by the caller. That is the right shape,
 * but it means a single caller that forgets the seam can mutate the operator's
 * authorized_keys -- and one did: `POST /api/security/bridge-enroll` calls
 * bridgeEnroll() without deps, so the route's default resolver used
 * homedir()/.ssh, and a plain suite run enrolled a REAL key on every pass. The
 * test stayed GREEN throughout, because its only assertion
 * (`not.toMatch(/Invalid host/)`) is satisfied by a SUCCESSFUL enrollment too.
 * 62 keys accumulated across the fleet before anyone looked (cleaned 2026-09-15).
 *
 * The check is deliberately narrow on BOTH axes, so it cannot misfire:
 *   - only under a test runner (VITEST / NODE_ENV=test -- see test-run-marker.ts,
 *     the one definition of that question in this repo), and
 *   - only when the target IS the real ~/.ssh. A scratch directory always passes,
 *     which is every legitimate test.
 * So the guard has no production behaviour to get wrong; what it forbids is the
 * one combination that is always a mistake.
 *
 * Why here and not only in the resolvers: this is the single funnel that both
 * the HTTP routes and the CLI pass through. A guard in a resolver protects the
 * callers that USE that resolver; a guard here protects the file.
 */
function assertSafeSshDir(sshDir: string, operation: string): void {
  if (!isTestRun()) return
  if (!isRealSshDir(sshDir)) return
  throw new SshDirGuardError(
    `ENROLL813: refusing to ${operation} the REAL ${realSshDir()}/${AUTH_KEYS_NAME} ` +
      `from a test run (${describeTestRunSignal()}). Pass a scratch sshDir (the suite ` +
      'sets MARVEEN_SSH_DIR per worker in src/__tests__/setup/default-ssh-dir-seam.ts). ' +
      'This guard exists because a route test silently enrolled real keys for weeks.',
  )
}

/** Path identity, not string equality: ~/.ssh may be reached through a symlink
 * or a non-normalised path. realpath when it exists, resolve() otherwise (a
 * to-be-created scratch dir must not be mistaken for the real one). */
function isRealSshDir(sshDir: string): boolean {
  return canonical(sshDir) === canonical(realSshDir())
}

/** SCOPE, stated on purpose (ENROLL813): this compares the DIRECTORY, not the
 * target file. If some scratch directory's `authorized_keys` were itself a
 * symlink to the operator's real one, the two directories would differ, the
 * guard would pass, and the write would still land in the real file. Not
 * reachable from the suite -- every test directory comes from mkdtemp and
 * nothing creates such a link -- and canonicalising the FILE instead would mean
 * realpath-ing a path that usually does not exist yet on the enroll path. A
 * chosen boundary, not an oversight; widen it here if that ever stops holding. */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const SSH_DIR_MODE = 0o700
const AUTH_KEYS_MODE = 0o600
const AUTH_KEYS_NAME = 'authorized_keys'
const LOCK_NAME = 'authorized_keys.lock'

export interface EnrollOptions {
  /** Absolute path to the .ssh directory (real one is ~/.ssh; tests override). */
  sshDir: string
  /** The exact restricted line to write. */
  restrictedLine: string
  /** Install id used to find a prior enrollment to replace. */
  installId: string
  /** Max lock acquisition attempts. Default 20. */
  lockRetries?: number
  /** Delay between lock attempts in ms. Default 100. */
  lockRetryDelayMs?: number
  /** A lockfile older than this (ms) is treated as stale and removed. Default 15000. */
  staleLockMs?: number
  /** Sleep implementation; injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface EnrollResult {
  action: MergeAction
  authorizedKeysPath: string
  warnings: string[]
}

/** The lock could not be taken: another writer holds it. A caller can tell this
 * apart from an I/O error without reading the message (the message is unchanged). */
export class AuthorizedKeysLockError extends Error {
  readonly code = 'AUTHORIZED_KEYS_LOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizedKeysLockError'
  }
}

/** A guarded rewrite refused to write, or could not prove what it wrote. */
export class AuthorizedKeysRewriteError extends Error {
  readonly code:
    | 'AUTHORIZED_KEYS_SYMLINK'
    | 'AUTHORIZED_KEYS_READBACK'
    | 'AUTHORIZED_KEYS_ASYNC_TRANSFORM'
    | 'AUTHORIZED_KEYS_NOT_BYTES'
  constructor(code: AuthorizedKeysRewriteError['code'], message: string) {
    super(message)
    this.name = 'AuthorizedKeysRewriteError'
    this.code = code
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** True when a mode grants any permission beyond the given owner-only mask. */
function looserThan(mode: number, ownerMask: number): boolean {
  return (mode & 0o777 & ~ownerMask) !== 0
}

function fmtMode(mode: number): string {
  return '0' + (mode & 0o777).toString(8).padStart(3, '0')
}

/**
 * Ensure the .ssh directory exists with 0700. If it already exists with looser
 * permissions, warn but do not change it.
 */
function ensureSshDir(sshDir: string, warnings: string[]): void {
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: SSH_DIR_MODE })
    // mkdir mode is subject to umask; enforce explicitly.
    chmodSync(sshDir, SSH_DIR_MODE)
    return
  }
  const st = statSync(sshDir)
  if (!st.isDirectory()) {
    throw new Error(`${sshDir} exists but is not a directory`)
  }
  if (looserThan(st.mode, SSH_DIR_MODE)) {
    warnings.push(
      `${sshDir} permissions are ${fmtMode(st.mode)} (looser than 0700); leaving as-is`,
    )
  }
}

/**
 * Acquire an exclusive lock via O_EXCL. Retries on contention and removes a
 * stale lockfile whose mtime is older than staleLockMs. Returns the lock file
 * descriptor; the caller must releaseLock() it.
 */
async function acquireLock(
  lockPath: string,
  retries: number,
  delayMs: number,
  staleMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // 'wx' => O_CREAT | O_EXCL: fails if the file already exists.
      const fd = openSync(lockPath, 'wx', AUTH_KEYS_MODE)
      try {
        writeSync(fd, `${process.pid}\n`)
      } catch {
        // Non-fatal: the lock is the file's existence, not its contents.
      }
      return fd
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Contended. If the existing lock is stale, remove it and retry now.
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // Lock vanished between open and stat; retry immediately.
        continue
      }
      await sleep(delayMs)
    }
  }
  throw new AuthorizedKeysLockError(
    `could not acquire ${lockPath} after ${retries} attempts; another enrollment may be running`,
  )
}

function releaseLock(fd: number, lockPath: string): void {
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

/**
 * Enroll (append or replace-by-id) the restricted line into
 * <sshDir>/authorized_keys with an atomic read-modify-write guarded by an
 * O_EXCL lockfile. Never reads back or logs other users' keys; only reports
 * the action taken and any permission warnings.
 */
export async function enrollAuthorizedKey(opts: EnrollOptions): Promise<EnrollResult> {
  const {
    sshDir,
    restrictedLine,
    installId,
    lockRetries = 20,
    lockRetryDelayMs = 100,
    staleLockMs = 15000,
    sleep = defaultSleep,
  } = opts
  assertSafeSshDir(sshDir, 'enroll a key into')
  const warnings: string[] = []
  const authPath = join(sshDir, AUTH_KEYS_NAME)
  const lockPath = join(sshDir, LOCK_NAME)

  ensureSshDir(sshDir, warnings)

  const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep)
  try {
    let existing = ''
    if (existsSync(authPath)) {
      const st = statSync(authPath)
      if (looserThan(st.mode, AUTH_KEYS_MODE)) {
        warnings.push(
          `${authPath} permissions were ${fmtMode(st.mode)} (looser than 0600); the rewritten file is 0600`,
        )
      }
      existing = readFileSync(authPath, 'utf8')
    }

    const { content, action } = mergeAuthorizedKeys(existing, restrictedLine, installId)
    writeAtomic(sshDir, authPath, content)

    return { action, authorizedKeysPath: authPath, warnings }
  } finally {
    releaseLock(fd, lockPath)
  }
}

/** Atomic write: temp file in the same directory (same filesystem), 0600,
 * fsync, then rename over the target. */
function writeAtomic(
  sshDir: string,
  authPath: string,
  content: string,
  encoding: 'utf8' | 'latin1' = 'utf8',
): void {
  const tmpPath = join(sshDir, `.${AUTH_KEYS_NAME}.${process.pid}.${Date.now()}.tmp`)
  const tfd = openSync(tmpPath, 'wx', AUTH_KEYS_MODE)
  try {
    writeSync(tfd, content, null, encoding)
    fsyncSync(tfd)
  } finally {
    closeSync(tfd)
  }
  // Enforce mode explicitly in case umask trimmed the create mode.
  chmodSync(tmpPath, AUTH_KEYS_MODE)
  try {
    renameSync(tmpPath, authPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export interface UpdateServicePortsOptions {
  sshDir: string
  installId: string
  webPort: number
  /** The DESIRED service-port list (already validated by the caller's policy
   * layer -- validateBridgeServicePorts). Declarative: the permitopen set
   * becomes {webPort} + exactly these. */
  ports: number[]
  lockRetries?: number
  lockRetryDelayMs?: number
  staleLockMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface UpdateServicePortsResult {
  found: boolean
  before: number[]
  after: number[]
  authorizedKeysPath: string
}

/**
 * Rewrite the enrolled key's permitopen set (BRIDGEPORT817) under the same
 * lock + atomic-replace discipline as enrollment. found:false means no line
 * carries this installId -- the device is not enrolled (or was revoked).
 */
export async function updateEnrolledServicePorts(
  opts: UpdateServicePortsOptions,
): Promise<UpdateServicePortsResult> {
  const {
    sshDir,
    installId,
    webPort,
    ports,
    lockRetries = 20,
    lockRetryDelayMs = 100,
    staleLockMs = 15000,
    sleep = defaultSleep,
  } = opts
  assertSafeSshDir(sshDir, 'rewrite service ports in')
  const authPath = join(sshDir, AUTH_KEYS_NAME)
  const lockPath = join(sshDir, LOCK_NAME)

  if (!existsSync(authPath)) return { found: false, before: [], after: [], authorizedKeysPath: authPath }

  const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep)
  try {
    if (!existsSync(authPath)) return { found: false, before: [], after: [], authorizedKeysPath: authPath }
    const existing = readFileSync(authPath, 'utf8')
    const result = rewriteServicePorts(existing, installId, webPort, ports)
    if (result.found && result.content !== existing) writeAtomic(sshDir, authPath, result.content)
    return { found: result.found, before: result.before, after: result.after, authorizedKeysPath: authPath }
  } finally {
    releaseLock(fd, lockPath)
  }
}

export interface RemoveEnrolledOptions {
  sshDir: string
  installId: string
  lockRetries?: number
  lockRetryDelayMs?: number
  staleLockMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface RemoveEnrolledResult {
  removed: boolean
  authorizedKeysPath: string
}

/**
 * Remove the marveen-remote:<installId> line from <sshDir>/authorized_keys --
 * the revoke counterpart of enrollAuthorizedKey, under the same lock and
 * atomic-replace discipline. A missing file or missing line reports
 * removed:false (idempotent: revoking twice must not fail).
 */
export async function removeEnrolledKey(opts: RemoveEnrolledOptions): Promise<RemoveEnrolledResult> {
  const {
    sshDir,
    installId,
    lockRetries = 20,
    lockRetryDelayMs = 100,
    staleLockMs = 15000,
    sleep = defaultSleep,
  } = opts
  assertSafeSshDir(sshDir, 'remove a key from')
  const authPath = join(sshDir, AUTH_KEYS_NAME)
  const lockPath = join(sshDir, LOCK_NAME)

  if (!existsSync(authPath)) return { removed: false, authorizedKeysPath: authPath }

  const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep)
  try {
    if (!existsSync(authPath)) return { removed: false, authorizedKeysPath: authPath }
    const existing = readFileSync(authPath, 'utf8')
    const { content, removed } = removeAuthorizedKey(existing, installId)
    if (removed) writeAtomic(sshDir, authPath, content)
    return { removed, authorizedKeysPath: authPath }
  } finally {
    releaseLock(fd, lockPath)
  }
}

export interface LockedRewriteOptions {
  sshDir: string
  /** Words for the ENROLL813 refusal message, e.g. "write a support line into". */
  operation: string
  /** Create the .ssh directory (0700) when it is missing. A removal leaves this off. */
  createDir?: boolean
  /** Refuse when authorized_keys, or the .ssh directory itself, is a symbolic
   * link. For ADDING access only: a removal must never be refused, because a
   * refused removal leaves the key in. */
  refuseSymlink?: boolean
  /** Read and write the file one byte per character, so every byte the
   * transform does not touch comes back as it was, whatever encoding the file
   * is in. Without it the file is read as UTF-8, and a byte that is not valid
   * UTF-8 is replaced. The new content may then hold only characters up to
   * U+00FF; anything else is refused before the write. */
  preserveBytes?: boolean
  lockRetries?: number
  lockRetryDelayMs?: number
  staleLockMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface LockedRewriteOutcome<T> {
  result: T
  /** True when the file content changed and was replaced. */
  wrote: boolean
  authorizedKeysPath: string
  warnings: string[]
}

/**
 * The shared read-transform-write of <sshDir>/authorized_keys for writers that
 * are not the Bridge's own three: the SAME lock file, the same ENROLL813 guard
 * and the same atomic replace, so two kinds of writer can never interleave.
 *
 * `transform` gets the current content ('' when the file does not exist) and
 * returns the new content, or null to leave the file alone. It must be
 * SYNCHRONOUS: the lock is given up after 20 x 100 ms by default and treated as
 * stale after 15 s, so anything slow (measuring sshd, a network call) belongs
 * BEFORE this call, never inside it. A transform that returns a promise is
 * refused before anything is written.
 *
 * After the replace the file is read back and must equal what was written.
 */
export async function rewriteAuthorizedKeysLocked<T>(
  opts: LockedRewriteOptions,
  transform: (existing: string) => { content: string | null; result: T },
): Promise<LockedRewriteOutcome<T>> {
  const {
    operation,
    createDir = false,
    refuseSymlink = false,
    preserveBytes = false,
    lockRetries = 20,
    lockRetryDelayMs = 100,
    staleLockMs = 15000,
    sleep = defaultSleep,
  } = opts
  // ONE spelling of the directory for the link check, the lock and the file.
  // resolve() is lexical: it drops a trailing slash and a `.` segment and does
  // not follow a link. lstat on `<dir>/.ssh/` or `<dir>/.ssh/.` FOLLOWS the
  // link and reports a directory, so without this the refusal below would
  // depend on how the caller happened to write the path.
  const sshDir = resolve(opts.sshDir)
  assertSafeSshDir(sshDir, operation)
  const warnings: string[] = []
  const authPath = join(sshDir, AUTH_KEYS_NAME)
  const lockPath = join(sshDir, LOCK_NAME)
  const encoding = preserveBytes ? 'latin1' : 'utf8'

  // Before the directory is created or locked: nothing may be written through
  // a linked directory by an operation that adds access.
  if (refuseSymlink && lstatOrNull(sshDir)?.isSymbolicLink()) {
    throw new AuthorizedKeysRewriteError(
      'AUTHORIZED_KEYS_SYMLINK',
      `${sshDir} is a symbolic link; refusing to add access through it`,
    )
  }
  if (createDir) ensureSshDir(sshDir, warnings)
  else if (!existsSync(sshDir)) {
    // Nothing to read and nowhere to lock: the file cannot exist either.
    const out = transform('')
    assertSyncTransform(out)
    if (out.content !== null && out.content !== '') {
      throw new Error(`${sshDir} does not exist; refusing to create it for this operation`)
    }
    return { result: out.result, wrote: false, authorizedKeysPath: authPath, warnings }
  }

  const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep)
  try {
    let existing = ''
    const link = lstatOrNull(authPath)
    if (link !== null) {
      if (link.isSymbolicLink() && refuseSymlink) {
        throw new AuthorizedKeysRewriteError(
          'AUTHORIZED_KEYS_SYMLINK',
          `${authPath} is a symbolic link; refusing to add access through it`,
        )
      }
      if (existsSync(authPath)) {
        const st = statSync(authPath)
        if (looserThan(st.mode, AUTH_KEYS_MODE)) {
          warnings.push(
            `${authPath} permissions were ${fmtMode(st.mode)} (looser than 0600); the rewritten file is 0600`,
          )
        }
        existing = readFileSync(authPath, encoding)
      }
    }
    const out = transform(existing)
    assertSyncTransform(out)
    if (out.content === null || out.content === existing) {
      return { result: out.result, wrote: false, authorizedKeysPath: authPath, warnings }
    }
    // Only an ADDITION can trip this: a removal's content is the decoded file
    // minus some lines, and every character of that is already one byte. So
    // this refusal never stands in the way of taking access out.
    if (preserveBytes && /[^\u0000-\u00ff]/.test(out.content)) {
      throw new AuthorizedKeysRewriteError(
        'AUTHORIZED_KEYS_NOT_BYTES',
        `the new content of ${authPath} holds a character that is not one byte; nothing was written`,
      )
    }
    writeAtomic(sshDir, authPath, out.content, encoding)
    if (readFileSync(authPath, encoding) !== out.content) {
      throw new AuthorizedKeysRewriteError(
        'AUTHORIZED_KEYS_READBACK',
        `${authPath} does not hold what was just written`,
      )
    }
    if (link !== null && link.isSymbolicLink()) {
      // The rename replaced the LINK. sshd now reads the new regular file; the
      // file the link pointed at was not opened for writing and is as it was.
      warnings.push(
        `${authPath} was a symbolic link; it is now a regular file. The file the link pointed at was not ` +
          'changed and still holds its old lines: linking it back would bring them back',
      )
    }
    return { result: out.result, wrote: true, authorizedKeysPath: authPath, warnings }
  } finally {
    releaseLock(fd, lockPath)
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function assertSyncTransform(out: unknown): void {
  if (out !== null && typeof out === 'object' && typeof (out as { then?: unknown }).then === 'function') {
    throw new AuthorizedKeysRewriteError(
      'AUTHORIZED_KEYS_ASYNC_TRANSFORM',
      'the transform returned a promise; nothing slow may run while the lock is held',
    )
  }
}
