// Support access: the narrow token on disk.
//
// The token can only ASK the licensing service whether support access to this
// machine is switched on; it cannot switch anything on. It still never appears
// in a log line, an error message, a diagnostic or an API answer: every error
// raised here carries a code and a fixed sentence, never the value.
//
// One file, one line, mode 0600. The bound dispatcher (a POSIX shell script
// that must work while the dashboard is down) reads the same file, so the
// format is the plainest possible: the token and a newline.
//
// The directory is a PARAMETER; this layer never decides where the token lives.
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const SUPPORT_TOKEN_FILE = 'support-access.token'
const TOKEN_MODE = 0o600
/** The token and its newline are 48 bytes; a file larger than this is not read at all. */
const TOKEN_READ_CAP = 64

/**
 * `mst_` and exactly 43 URL-safe characters (the frozen v1 shape of the
 * licensing service). The value travels in an HTTP header and through a shell
 * script's standard input, so nothing else may be in it.
 */
export const SUPPORT_TOKEN_SHAPE = /^mst_[A-Za-z0-9_-]{43}$/

export function isSupportToken(value: unknown): value is string {
  return typeof value === 'string' && SUPPORT_TOKEN_SHAPE.test(value)
}

export type SupportTokenProblem = 'token_shape' | 'token_dir_unsafe' | 'token_path_unsafe' | 'token_readback' | 'token_remains'

const SENTENCES: Record<SupportTokenProblem, string> = {
  token_shape: 'the value is not a support token',
  token_dir_unsafe: 'the token directory is missing, is not a directory of this user, or is writable by others',
  token_path_unsafe: 'the token path exists and is not a regular file',
  token_readback: 'the token file does not hold what was written',
  token_remains: 'the token file is still there after the removal',
}

/** Carries a code and a fixed sentence. NEVER the token, and never a path that could hold one. */
export class SupportTokenError extends Error {
  readonly code: SupportTokenProblem
  constructor(code: SupportTokenProblem) {
    super(SENTENCES[code])
    this.name = 'SupportTokenError'
    this.code = code
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

/** The effective uid of this process, or null on a platform without one. */
function effectiveUid(): number | null {
  return typeof process.geteuid === 'function' ? process.geteuid() : null
}

/**
 * The directory must be a real directory (lstat: a symbolic link in its place
 * is refused), owned by this user, and not writable by group or others.
 */
function dirState(dir: string): 'ok' | 'missing' | 'unsafe' {
  const st = lstatOrNull(dir)
  if (st === null) return 'missing'
  const uid = effectiveUid()
  if (!st.isDirectory() || (st.mode & 0o022) !== 0 || (uid !== null && st.uid !== uid)) return 'unsafe'
  return 'ok'
}

function assertSafeDir(dir: string): void {
  if (dirState(dir) !== 'ok') throw new SupportTokenError('token_dir_unsafe')
}

/**
 * Write the token: a temporary file created 0600 in the same directory, its
 * mode set again ON THE DESCRIPTOR before it is closed, synced, then renamed
 * over the target, then read back. The token is never in a file that is
 * readable by anyone else, not even for a moment. A write that fails before the
 * rename leaves the previous file (or no file) in place; a read-back that does
 * not give exactly this token removes the file, so then there is no token at
 * all, not the previous one either.
 */
export function writeSupportToken(dir: string, token: string): void {
  if (!isSupportToken(token)) throw new SupportTokenError('token_shape')
  assertSafeDir(dir)
  const target = join(dir, SUPPORT_TOKEN_FILE)
  const existing = lstatOrNull(target)
  if (existing !== null && !existing.isFile()) throw new SupportTokenError('token_path_unsafe')
  const tmp = join(dir, '.' + SUPPORT_TOKEN_FILE + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp')
  const fd = openSync(tmp, 'wx', TOKEN_MODE)
  try {
    try {
      // The umask can trim the create mode (never widen it); the owner must be able to read the file back.
      fchmodSync(fd, TOKEN_MODE)
      writeSync(fd, token + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* the temporary file is already gone */
    }
    throw err
  }
  const back = readSupportToken(dir)
  if (back.kind !== 'ok' || back.token !== token) {
    removeSupportToken(dir)
    throw new SupportTokenError('token_readback')
  }
}

export type SupportTokenRead =
  | { readonly kind: 'ok'; readonly token: string }
  | { readonly kind: 'missing' }
  /** There is something at the path, and it is not usable as a token. It is NOT used. */
  | { readonly kind: 'invalid'; readonly reason: 'dir' | 'not_a_file' | 'owner' | 'mode' | 'size' | 'shape' }

/**
 * Read the token. Anything unexpected is `invalid`, and an invalid token is no
 * token: a directory that is not safe (the same rule as for a write), a
 * symbolic link, a file of another user, a file that others can read, a file
 * larger than a token, a second line, a value of another shape.
 *
 * The file is opened ONCE, without following a link (and without waiting on a
 * pipe), and every check is made on that descriptor (Dani's review of #2765,
 * S2): what is checked is what is read.
 */
export function readSupportToken(dir: string): SupportTokenRead {
  const state = dirState(dir)
  if (state === 'missing') return { kind: 'missing' }
  if (state === 'unsafe') return { kind: 'invalid', reason: 'dir' }
  const target = join(dir, SUPPORT_TOKEN_FILE)
  let fd: number
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    // ELOOP: a symbolic link at the path. Anything else that cannot be opened is no token either.
    return { kind: 'invalid', reason: 'not_a_file' }
  }
  let content: string
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { kind: 'invalid', reason: 'not_a_file' }
    const uid = effectiveUid()
    if (uid !== null && st.uid !== uid) return { kind: 'invalid', reason: 'owner' }
    if ((st.mode & 0o077) !== 0) return { kind: 'invalid', reason: 'mode' }
    // One byte more than the cap is asked for: getting it means the file is too large, whatever its size said.
    const buf = Buffer.alloc(TOKEN_READ_CAP + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > TOKEN_READ_CAP) return { kind: 'invalid', reason: 'size' }
    content = buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
  const token = content.endsWith('\n') ? content.slice(0, -1) : content
  if (!isSupportToken(token)) return { kind: 'invalid', reason: 'shape' }
  return { kind: 'ok', token }
}

/**
 * Remove the token. Idempotent. Whatever stands at the path goes (a regular
 * file or a symbolic link; the link itself, never its target). Reports success
 * only when nothing is left at the path.
 */
export function removeSupportToken(dir: string): { removed: boolean } {
  const target = join(dir, SUPPORT_TOKEN_FILE)
  if (lstatOrNull(target) === null) return { removed: false }
  try {
    unlinkSync(target)
  } catch {
    /* whether it is gone is decided by looking, on the next line */
  }
  if (lstatOrNull(target) !== null) throw new SupportTokenError('token_remains')
  return { removed: true }
}
