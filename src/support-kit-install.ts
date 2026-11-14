// Support access: `install-kit`, writing the kit of THIS release from the
// install tree. The installer and the updater call it as their last step; the
// dashboard never does (a missing or mismatching kit at the dashboard switch is
// a refusal that says an update is needed).
//
// Every file is read from the tree and measured against the sha256 STORED IN
// THE REPO (scripts/support-kit.sha256, read from the same tree) before
// anything is written; writeKit measures again after the write. A tree whose
// hashes file is missing, unreadable or names other files is refused as a
// whole: a half-finished update must not end up as a kit.
import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { KitError, SAFE_NODE_PATH, writeKit, type KitFileSource, type KitLockTuning, type WriteKitResult } from './support-kit.js'
import { KIT_HASHES_FILE, KIT_SOURCES, parseKitHashes } from './support-kit-sources.js'
import { SUPPORT_ROUTINE_MIN_NODE_MAJOR } from './support-standby.js'

/** Where the support folder is, relative to the login user's home (a working name until the M3 measurement). */
export const SUPPORT_DIR_IN_HOME = '.marveen/support'
/** No kit file is larger than this; a larger one is not read. */
export const KIT_SOURCE_MAX_BYTES = 4 * 1024 * 1024
const HASHES_MAX_BYTES = 4096
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/

export interface InstallKitInput extends KitLockTuning {
  /** The install tree: where the stored hashes and the kit's files are read from. */
  readonly installRoot: string
  /** The node that runs the service; the manifest names it for the launcher. Must be an executable file. */
  readonly nodePath: string
  /** The commit of this release. */
  readonly release: string
  /** The support folder (from the login user's home in the user database; never from a variable). */
  readonly supportDir: string
}

/** Read a regular file of the tree, without following a link, up to `max` bytes; null for anything else. */
function readTreeFile(path: string, max: number): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(max + 1)
    let n = 0
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n)
      if (got === 0) break
      n += got
      if (n > max) return null
    }
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/**
 * Write the kit of the release in `installRoot`. Refused before anything is
 * written: a path that is not plain and absolute, an install root that is not
 * a folder, a node path that is not an executable file, a hashes file that is
 * not exactly the stored list, a kit file that is missing, too large, a link,
 * or not the file the stored hash names.
 */
export async function installKit(input: InstallKitInput): Promise<WriteKitResult> {
  const { installRoot, nodePath, release, supportDir, ...tuning } = input
  for (const [what, path] of [['install root', installRoot], ['support folder', supportDir]] as const) {
    if (!SAFE_ABSOLUTE_PATH.test(path)) throw new KitError('kit_input_invalid', 'the ' + what + ' is not a plain absolute path')
  }
  if (!SAFE_NODE_PATH.test(nodePath)) throw new KitError('kit_input_invalid', 'the node path is not a plain absolute path')
  let rootIsFolder = false
  try {
    rootIsFolder = lstatSync(installRoot).isDirectory()
  } catch {
    /* missing is "not a folder" */
  }
  if (!rootIsFolder) throw new KitError('kit_input_invalid', 'the install root is not a folder')
  try {
    // A node installed through a version manager is often reached through a link; what it points at must be a file.
    if (!statSync(nodePath).isFile()) throw new Error('not a file')
    accessSync(nodePath, constants.X_OK)
  } catch {
    throw new KitError('kit_input_invalid', 'the node path is not an executable file')
  }

  const hashesBytes = readTreeFile(join(installRoot, KIT_HASHES_FILE), HASHES_MAX_BYTES)
  const stored = hashesBytes === null ? null : parseKitHashes(hashesBytes.toString('latin1'))
  if (stored === null) {
    throw new KitError('kit_source_mismatch', 'the stored hashes of this release are missing or unreadable; nothing was written')
  }
  const files: KitFileSource[] = []
  for (const source of KIT_SOURCES) {
    const content = readTreeFile(join(installRoot, source.treePath), KIT_SOURCE_MAX_BYTES)
    if (content === null) {
      throw new KitError('kit_source_mismatch', source.name + ' is missing from the install tree or is not a plain file; nothing was written')
    }
    files.push({ name: source.name, content, sha256: stored.get(source.name) as string, executable: source.executable })
  }
  // writeKit measures every file against its stored hash before it writes anything.
  // The node minimum comes from the routine's own constant: one source, written into the manifest for the launcher.
  return writeKit({ supportDir, files, installRoot, nodePath, nodeMin: SUPPORT_ROUTINE_MIN_NODE_MAJOR, release, ...tuning })
}
