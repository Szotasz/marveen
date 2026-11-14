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
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const SUPPORT_TOKEN_FILE = 'support-access.token'
const TOKEN_MODE = 0o600

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
  token_dir_unsafe: 'the token directory is missing, is not a directory, or is writable by others',
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

function assertSafeDir(dir: string): void {
  const st = lstatOrNull(dir)
  // lstat, not stat: a symbolic link in place of the directory is refused too.
  if (st === null || !st.isDirectory() || (st.mode & 0o022) !== 0) throw new SupportTokenError('token_dir_unsafe')
}

/**
 * Write the token: a temporary file created 0600 in the same directory, synced,
 * then renamed over the target, then read back. The token is never in a file
 * that is readable by anyone else, not even for a moment, and a failed write
 * leaves the previous file (or no file) in place.
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
      writeSync(fd, token + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // The umask can trim the create mode (never widen it); the owner must be able to read the file back.
    chmodSync(tmp, TOKEN_MODE)
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
  | { readonly kind: 'invalid'; readonly reason: 'not_a_file' | 'mode' | 'shape' }

/**
 * Read the token. Anything unexpected is `invalid`, and an invalid token is no
 * token: a symbolic link, a file that others can read, a second line, a value
 * of another shape.
 */
export function readSupportToken(dir: string): SupportTokenRead {
  const target = join(dir, SUPPORT_TOKEN_FILE)
  const st = lstatOrNull(target)
  if (st === null) return { kind: 'missing' }
  if (!st.isFile()) return { kind: 'invalid', reason: 'not_a_file' }
  if ((st.mode & 0o077) !== 0) return { kind: 'invalid', reason: 'mode' }
  const content = readFileSync(target, 'utf8')
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
