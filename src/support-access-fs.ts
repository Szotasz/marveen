// Support access: the three file operations, on top of the one shared lock.
//
// Each of them is the pure function from support-access-line.ts run inside
// rewriteAuthorizedKeysLocked, so a support writer and a Bridge writer can
// never interleave, and the ENROLL813 guard (no test run touches the real
// ~/.ssh) covers these writers too.
//
// NO WRITER HERE TAKES A LINE. A grant and a reconcile get the grant's inputs
// (pinned keys and sources, the consent record) and build the lines with the
// one builder, so what reaches the file is the closed option list and nothing
// a caller composed.
//
// The directory is a PARAMETER. Which directory production uses, and whether a
// MARVEEN_SSH_DIR override is acceptable, is the caller's question; this layer
// only ever writes where it is told.
//
// ASYMMETRY ON PURPOSE: adding access is refused through a symbolic link, be
// it the authorized_keys file or the .ssh directory (access must not land in a
// place the owner did not look at); removing access is never refused for that
// reason. A refused removal would leave the key in the file, which is the one
// outcome a removal must not have. A removal through a linked FILE replaces
// the link and leaves the link's old target as it was; the result carries a
// warning that says so.
//
// EVERY OTHER BYTE STAYS: the file is read and written one byte per character
// (preserveBytes), so a line of another owner comes back byte for byte even
// when the file is not valid UTF-8. The support lines themselves are ASCII.
//
// TWO FILES, ONE OF THEM NEVER WRITTEN. The stock sshd setting on Debian and
// Ubuntu reads keys from `authorized_keys` AND from `authorized_keys2`. A
// support line is only ever written into the first. In the second the set of
// expected lines is ALWAYS empty: every operation here, the grant too, takes
// every support line out of it, because a copy of a pinned key there would
// survive a removal that looked at the first file only. This does not depend
// on what the sshd probe says: when sshd cannot be asked, both files are
// still cleaned. A missing second file is not an error.
//
// HOW THE TWO FILES MAY RELATE (Dani's review of #2768, S1, and 78313). An
// old, common setup makes authorized_keys2 a symbolic link to authorized_keys.
// Cleaning it as a file of its own would replace the link with a regular file:
// a frozen copy of the owner's lines, so a key the owner later takes out of
// authorized_keys would still open through the copy. A GRANT (it adds access)
// refuses, before it writes, every layout it cannot keep right; a REMOVAL
// (revoke, reconcile) never fails on a layout, because taking access out must
// not depend on anything:
//   - a link to authorized_keys, or to nothing: skipped by every operation;
//     the first file's rewrite replaces the path the link points at, so the
//     link stays right;
//   - a link to another file: a grant refuses; a removal does not write the
//     target and goes on when the target holds no support line, and fails
//     loudly when it does (the owner has to see that and remove it by hand);
//   - a hard link (one inode under both names): a grant refuses; a removal
//     cleans authorized_keys first (its rename splits the hard link) and then
//     the now separate authorized_keys2, and says that the two were split. A
//     plain skip would not do: the old inode, with every line it had, stays
//     under the name authorized_keys2.
import { lstatSync, readFileSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import {
  rewriteAuthorizedKeysLocked,
  type AuthorizedKeysFileName,
  type LockedRewriteOptions,
} from './remote-enroll-fs.js'
import {
  SupportLineError,
  buildSupportGrantLines,
  countSupportLines,
  mergeSupportLines,
  reconcileSupportLines,
  removeSupportLines,
  type SupportGrantInput,
  type SupportLineProblem,
} from './support-access-line.js'

type LockTuning = Pick<LockedRewriteOptions, 'lockRetries' | 'lockRetryDelayMs' | 'staleLockMs' | 'sleep'>

export interface SupportFsBase extends LockTuning {
  sshDir: string
  /** Blobs of the pinned support keys: any line holding one of them is a support line. */
  pinnedBlobs: ReadonlySet<string>
}

/** The file no support line is ever written into, and every operation cleans. */
const SECOND_FILE: AuthorizedKeysFileName = 'authorized_keys2'

/** Raised, before anything is written, when authorized_keys2 is a link elsewhere or a hard link of authorized_keys. */
export class SupportKeysLayoutError extends Error {
  readonly code = 'SUPPORT_KEYS_LAYOUT'
  constructor(message: string) {
    super(message)
    this.name = 'SupportKeysLayoutError'
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export type KeysFileLayout = 'separate' | 'link-to-first' | 'link-to-nothing' | 'link-elsewhere' | 'hard-link'

/** How authorized_keys2 relates to authorized_keys, as it is right now. */
export function keysFileLayout(sshDir: string): KeysFileLayout {
  const second = lstatOrNull(join(sshDir, SECOND_FILE))
  if (second === null) return 'separate'
  const first = lstatOrNull(join(sshDir, 'authorized_keys'))
  const sameAsFirst = (st: Stats): boolean => first !== null && first.isFile() && st.dev === first.dev && st.ino === first.ino
  if (second.isSymbolicLink()) {
    const target = statOrNull(join(sshDir, SECOND_FILE))
    if (target === null) return 'link-to-nothing'
    return sameAsFirst(target) ? 'link-to-first' : 'link-elsewhere'
  }
  return second.isFile() && sameAsFirst(second) ? 'hard-link' : 'separate'
}

/** A grant adds access: it refuses, before anything is written, a layout it could not keep right. */
function assertLayoutForGrant(sshDir: string): void {
  const layout = keysFileLayout(sshDir)
  const second = join(sshDir, SECOND_FILE)
  if (layout === 'link-elsewhere') throw new SupportKeysLayoutError(`${second} is a symbolic link to another file than authorized_keys; nothing was written`)
  if (layout === 'hard-link') throw new SupportKeysLayoutError(`${second} is a hard link of authorized_keys; nothing was written`)
}

/** The warning a removal gives when it found authorized_keys2 hard-linked before and split it. */
function splitWarning(sshDir: string, before: KeysFileLayout): string[] {
  if (before !== 'hard-link' || keysFileLayout(sshDir) === 'hard-link') return []
  return [
    `${join(sshDir, 'authorized_keys')} and ${join(sshDir, SECOND_FILE)} were one file under two names; taking the ` +
      'support lines out split them into two files. Both hold the other lines as they were, but an edit of one no ' +
      'longer shows in the other',
  ]
}

/**
 * Take every support line out of one of the two files. Reports how many went;
 * throws when the content it would leave still holds one.
 */
async function removeEverySupportLine(
  base: SupportFsBase,
  fileName: AuthorizedKeysFileName,
  operation: string,
): Promise<{ authorizedKeysPath: string; removed: number; warnings: string[] }> {
  const { sshDir, pinnedBlobs, ...lock } = base
  if (fileName === SECOND_FILE) {
    const secondPath = join(sshDir, SECOND_FILE)
    const layout = keysFileLayout(sshDir)
    if (layout === 'link-to-first' || layout === 'link-to-nothing') {
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [`${secondPath} is a link to authorized_keys (or to nothing); it was cleaned through that file`] }
    }
    if (layout === 'hard-link') {
      // Still one inode: authorized_keys was not rewritten (it held no support line), so neither name holds one.
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [] }
    }
    if (layout === 'link-elsewhere') {
      // The target is not ours to rewrite. Nothing to do when it holds no support line; otherwise fail loudly.
      let held = 0
      try {
        held = countSupportLines(readFileSync(secondPath, 'latin1'), pinnedBlobs)
      } catch {
        throw new SupportKeysLayoutError(`${secondPath} is a symbolic link to a file that cannot be read; it was not written`)
      }
      if (held > 0) {
        throw new SupportKeysLayoutError(
          `${secondPath} is a symbolic link to another file that holds ${held} support line(s); it was not written. ` +
            'Remove the line(s) from that file by hand',
        )
      }
      return { authorizedKeysPath: secondPath, removed: 0, warnings: [`${secondPath} is a symbolic link to another file; it holds no support line and was not written`] }
    }
  }
  const out = await rewriteAuthorizedKeysLocked({ sshDir, fileName, operation, preserveBytes: true, ...lock }, (existing) => {
    const { content, removed } = removeSupportLines(existing, pinnedBlobs)
    // The count uses the same recogniser the removal used, so it can only
    // catch a remover that stopped early. The proof that the lines are gone
    // from the FILE is the read-back inside rewriteAuthorizedKeysLocked.
    const left = countSupportLines(content, pinnedBlobs)
    if (left !== 0) {
      throw new SupportLinesRemainError(`${left} support line(s) would remain in ${fileName} after the removal`)
    }
    return { content: removed === 0 ? null : content, result: removed }
  })
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result, warnings: out.warnings }
}

/** Raised when a removal ran and support lines are still in the file. */
export class SupportLinesRemainError extends Error {
  readonly code = 'SUPPORT_LINES_REMAIN'
  constructor(message: string) {
    super(message)
    this.name = 'SupportLinesRemainError'
  }
}

export interface GrantSupportLinesResult {
  authorizedKeysPath: string
  /** Earlier support lines that the grant replaced. */
  replaced: number
  /** Support lines taken out of authorized_keys2 on the way (nothing ever writes one there). */
  removedFromSecond: number
  warnings: string[]
}

/**
 * Build a grant's lines and write them, replacing every earlier support line.
 * Refuses a symlinked authorized_keys. Every key of the grant must be one of
 * `pinnedBlobs`: a key the removal side does not know as pinned gets no line.
 * Throws a SupportLineError, before the file is opened, for a grant the
 * builder refuses. authorized_keys2 is cleaned FIRST: if that cannot be done
 * nothing is added (an addition may be refused), and after a grant the lines
 * on the machine are the grant's and no others.
 */
export async function grantSupportLines(
  opts: SupportFsBase & { grant: SupportGrantInput },
): Promise<GrantSupportLinesResult> {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts
  if (!grant.keys.every((key) => pinnedBlobs.has(key.pub))) {
    throw new SupportLineError('pins_invalid', 'a key of the grant is not one of the pinned keys')
  }
  const lines = buildSupportGrantLines(grant)
  assertLayoutForGrant(sshDir)
  const second = await removeEverySupportLine({ sshDir, pinnedBlobs, ...lock }, SECOND_FILE, 'remove support access lines from')
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'write support access lines into', createDir: true, refuseSymlink: true, preserveBytes: true, ...lock },
    (existing) => {
      const merged = mergeSupportLines(existing, lines, pinnedBlobs)
      return { content: merged.content, result: merged.replaced }
    },
  )
  return {
    authorizedKeysPath: out.authorizedKeysPath,
    replaced: out.result,
    removedFromSecond: second.removed,
    warnings: [...second.warnings, ...out.warnings],
  }
}

export interface RevokeSupportLinesResult {
  authorizedKeysPath: string
  /** Support lines removed, both files together. */
  removed: number
  /** Of those, the ones that were in authorized_keys2. */
  removedFromSecond: number
  /** For instance: the path was a symbolic link, and the link's old target still holds the lines. */
  warnings: string[]
}

/**
 * Remove every support line, from both files. Idempotent: a missing file or
 * no line reports removed 0. Reports success only when neither file holds a
 * support line any more; otherwise it throws, and the caller must not tell
 * the owner "revoked". BOTH files are attempted even when the first one
 * fails: a removal that stopped at the first error would leave lines in the
 * other file that it could have taken out. The first error is then thrown.
 */
export async function revokeSupportLines(opts: SupportFsBase): Promise<RevokeSupportLinesResult> {
  const operation = 'remove support access lines from'
  // The FIRST file goes first: for a hard link, its rename splits the two names, and the second (now separate)
  // is cleaned after it. No layout stops a removal.
  const layoutBefore = keysFileLayout(opts.sshDir)
  const failures: unknown[] = []
  const done: Array<{ authorizedKeysPath: string; removed: number; warnings: string[] } | null> = []
  for (const fileName of ['authorized_keys', SECOND_FILE] as const) {
    try {
      done.push(await removeEverySupportLine(opts, fileName, operation))
    } catch (err) {
      failures.push(err)
      done.push(null)
    }
  }
  const [first, second] = done
  if (first === null || second === null) throw failures[0]
  return {
    authorizedKeysPath: first.authorizedKeysPath,
    removed: first.removed + second.removed,
    removedFromSecond: second.removed,
    warnings: [...first.warnings, ...second.warnings, ...splitWarning(opts.sshDir, layoutBefore)],
  }
}

/** Why a reconcile expected no line: the builder's own refusal, or a grant that is not even the typed shape. */
export type SupportReconcileProblem = SupportLineProblem | 'grant_malformed'

export interface ReconcileSupportLinesResult {
  authorizedKeysPath: string
  kept: number
  /** Support lines removed, both files together. */
  removed: number
  /** Of those, the ones that were in authorized_keys2: there no line is expected, whatever the grant says. */
  removedFromSecond: number
  missing: number
  /** Of the removed lines of authorized_keys, those that were an expected line with a CR LF line end and no other
   * change (see ReconcileSupportResult.lineEndOnly). */
  lineEndOnly: number
  /** Set when the live grant could not be built into lines: then no line was expected, and every support line went.
   * A refusal of the builder carries the builder's code; anything else (a record that is not the typed shape) is
   * `grant_malformed`. */
  unbuildable: SupportReconcileProblem | null
  warnings: string[]
}

/**
 * Remove every support line that is not, byte for byte, a line of the live
 * grant. Never adds a line. `grant` is the live grant's inputs, or null when
 * there is none (then every support line goes). The expected lines are built
 * here, by the one builder. A grant that cannot be built expects NO line, so
 * every support line goes and `unbuildable` says why: a reconcile is a removal
 * too, and must not be stopped by a grant that can no longer be built.
 *
 * ANY failure of the build counts, not only the builder's own refusal. The
 * live grant comes from a stored record, and a record of an older version, or
 * one that was cut short, is not the typed shape: a missing `keys` makes the
 * builder throw a TypeError, not a SupportLineError. That is the very case in
 * which the stale lines most need to go, so it is reported as
 * `grant_malformed` and the removal runs. (grantSupportLines keeps throwing:
 * an addition may be refused.) Errors of the file layer, a held lock for
 * instance, are not caught here.
 */
export async function reconcileSupportLinesOnDisk(
  opts: SupportFsBase & { grant: SupportGrantInput | null },
): Promise<ReconcileSupportLinesResult> {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts
  let expected: string[] = []
  let unbuildable: SupportReconcileProblem | null = null
  if (grant !== null) {
    try {
      expected = buildSupportGrantLines(grant)
    } catch (err) {
      unbuildable = err instanceof SupportLineError ? err.code : 'grant_malformed'
    }
  }
  const operation = 'reconcile support access lines in'
  const layoutBefore = keysFileLayout(sshDir)
  // BOTH files are attempted, as in a revoke: an error on one must not leave
  // the other one unlooked at. The first error is thrown afterwards.
  const failures: unknown[] = []
  let first: Awaited<ReturnType<typeof reconcileFirstFile>> | null = null
  let second: Awaited<ReturnType<typeof removeEverySupportLine>> | null = null
  try {
    first = await reconcileFirstFile({ sshDir, pinnedBlobs, ...lock }, expected, operation)
  } catch (err) {
    failures.push(err)
  }
  try {
    second = await removeEverySupportLine({ sshDir, pinnedBlobs, ...lock }, SECOND_FILE, operation)
  } catch (err) {
    failures.push(err)
  }
  if (first === null || second === null) throw failures[0]
  return {
    authorizedKeysPath: first.authorizedKeysPath,
    kept: first.result.kept,
    removed: first.result.removed + second.removed,
    removedFromSecond: second.removed,
    missing: first.result.missing,
    lineEndOnly: first.result.lineEndOnly,
    unbuildable,
    warnings: [...first.warnings, ...second.warnings, ...splitWarning(sshDir, layoutBefore)],
  }
}

/** The reconcile of authorized_keys itself: keep the expected lines, remove every other support line. */
function reconcileFirstFile(base: SupportFsBase, expected: readonly string[], operation: string) {
  const { sshDir, pinnedBlobs, ...lock } = base
  return rewriteAuthorizedKeysLocked({ sshDir, operation, preserveBytes: true, ...lock }, (existing) => {
    const r = reconcileSupportLines(existing, expected, pinnedBlobs)
    return {
      content: r.removed === 0 ? null : r.content,
      result: { kept: r.kept, removed: r.removed, missing: r.missing, lineEndOnly: r.lineEndOnly },
    }
  })
}
