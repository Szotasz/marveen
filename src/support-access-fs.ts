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
import { rewriteAuthorizedKeysLocked, type LockedRewriteOptions } from './remote-enroll-fs.js'
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
  warnings: string[]
}

/**
 * Build a grant's lines and write them, replacing every earlier support line.
 * Refuses a symlinked authorized_keys. Every key of the grant must be one of
 * `pinnedBlobs`: a key the removal side does not know as pinned gets no line.
 * Throws a SupportLineError, before the file is opened, for a grant the
 * builder refuses.
 */
export async function grantSupportLines(
  opts: SupportFsBase & { grant: SupportGrantInput },
): Promise<GrantSupportLinesResult> {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts
  if (!grant.keys.every((key) => pinnedBlobs.has(key.pub))) {
    throw new SupportLineError('pins_invalid', 'a key of the grant is not one of the pinned keys')
  }
  const lines = buildSupportGrantLines(grant)
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'write support access lines into', createDir: true, refuseSymlink: true, preserveBytes: true, ...lock },
    (existing) => {
      const merged = mergeSupportLines(existing, lines, pinnedBlobs)
      return { content: merged.content, result: merged.replaced }
    },
  )
  return { authorizedKeysPath: out.authorizedKeysPath, replaced: out.result, warnings: out.warnings }
}

export interface RevokeSupportLinesResult {
  authorizedKeysPath: string
  removed: number
  /** For instance: the path was a symbolic link, and the link's old target still holds the lines. */
  warnings: string[]
}

/**
 * Remove every support line. Idempotent: a missing file or no line reports
 * removed 0. Reports success only when the file holds no support line any
 * more; otherwise it throws, and the caller must not tell the owner "revoked".
 */
export async function revokeSupportLines(opts: SupportFsBase): Promise<RevokeSupportLinesResult> {
  const { sshDir, pinnedBlobs, ...lock } = opts
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'remove support access lines from', preserveBytes: true, ...lock },
    (existing) => {
      const { content, removed } = removeSupportLines(existing, pinnedBlobs)
      // The count uses the same recogniser the removal used, so it can only
      // catch a remover that stopped early. The proof that the lines are gone
      // from the FILE is the read-back inside rewriteAuthorizedKeysLocked.
      const left = countSupportLines(content, pinnedBlobs)
      if (left !== 0) {
        throw new SupportLinesRemainError(`${left} support line(s) would remain after the removal`)
      }
      return { content: removed === 0 ? null : content, result: removed }
    },
  )
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result, warnings: out.warnings }
}

export interface ReconcileSupportLinesResult {
  authorizedKeysPath: string
  kept: number
  removed: number
  missing: number
  /** Set when the live grant could not be built into lines: then no line was expected, and every support line went. */
  unbuildable: SupportLineProblem | null
  warnings: string[]
}

/**
 * Remove every support line that is not, byte for byte, a line of the live
 * grant. Never adds a line. `grant` is the live grant's inputs, or null when
 * there is none (then every support line goes). The expected lines are built
 * here, by the one builder. A grant the builder refuses expects NO line, so
 * every support line goes and `unbuildable` says why: a reconcile is a removal
 * too, and must not be stopped by a grant that can no longer be built.
 */
export async function reconcileSupportLinesOnDisk(
  opts: SupportFsBase & { grant: SupportGrantInput | null },
): Promise<ReconcileSupportLinesResult> {
  const { sshDir, pinnedBlobs, grant, ...lock } = opts
  let expected: string[] = []
  let unbuildable: SupportLineProblem | null = null
  if (grant !== null) {
    try {
      expected = buildSupportGrantLines(grant)
    } catch (err) {
      if (!(err instanceof SupportLineError)) throw err
      unbuildable = err.code
    }
  }
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'reconcile support access lines in', preserveBytes: true, ...lock },
    (existing) => {
      const r = reconcileSupportLines(existing, expected, pinnedBlobs)
      return {
        content: r.removed === 0 ? null : r.content,
        result: { kept: r.kept, removed: r.removed, missing: r.missing },
      }
    },
  )
  return { authorizedKeysPath: out.authorizedKeysPath, ...out.result, unbuildable, warnings: out.warnings }
}
