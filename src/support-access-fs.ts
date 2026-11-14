// Support access: the three file operations, on top of the one shared lock.
//
// Each of them is the pure function from support-access-line.ts run inside
// rewriteAuthorizedKeysLocked, so a support writer and a Bridge writer can
// never interleave, and the ENROLL813 guard (no test run touches the real
// ~/.ssh) covers these writers too.
//
// The directory is a PARAMETER. Which directory production uses, and whether a
// MARVEEN_SSH_DIR override is acceptable, is the caller's question; this layer
// only ever writes where it is told.
//
// ASYMMETRY ON PURPOSE: adding access is refused through a symbolic link;
// removing access is never refused for that reason. A refused removal would
// leave the key in the file, which is the one outcome a removal must not have.
import { rewriteAuthorizedKeysLocked, type LockedRewriteOptions } from './remote-enroll-fs.js'
import {
  countSupportLines,
  mergeSupportLines,
  reconcileSupportLines,
  removeSupportLines,
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

/** Write a grant's lines, replacing every earlier support line. Refuses a symlinked authorized_keys. */
export async function grantSupportLines(
  opts: SupportFsBase & { lines: readonly string[] },
): Promise<GrantSupportLinesResult> {
  const { sshDir, pinnedBlobs, lines, ...lock } = opts
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'write support access lines into', createDir: true, refuseSymlink: true, ...lock },
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
}

/**
 * Remove every support line. Idempotent: a missing file or no line reports
 * removed 0. Reports success only when the file holds no support line any
 * more; otherwise it throws, and the caller must not tell the owner "revoked".
 */
export async function revokeSupportLines(opts: SupportFsBase): Promise<RevokeSupportLinesResult> {
  const { sshDir, pinnedBlobs, ...lock } = opts
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'remove support access lines from', ...lock },
    (existing) => {
      const { content, removed } = removeSupportLines(existing, pinnedBlobs)
      const left = countSupportLines(content, pinnedBlobs)
      if (left !== 0) {
        throw new SupportLinesRemainError(`${left} support line(s) would remain after the removal`)
      }
      return { content: removed === 0 ? null : content, result: removed }
    },
  )
  return { authorizedKeysPath: out.authorizedKeysPath, removed: out.result }
}

export interface ReconcileSupportLinesResult {
  authorizedKeysPath: string
  kept: number
  removed: number
  missing: number
}

/** Remove every support line that is not, byte for byte, one of the expected lines. Never adds a line. */
export async function reconcileSupportLinesOnDisk(
  opts: SupportFsBase & { expected: readonly string[] },
): Promise<ReconcileSupportLinesResult> {
  const { sshDir, pinnedBlobs, expected, ...lock } = opts
  const out = await rewriteAuthorizedKeysLocked(
    { sshDir, operation: 'reconcile support access lines in', ...lock },
    (existing) => {
      const r = reconcileSupportLines(existing, expected, pinnedBlobs)
      return {
        content: r.removed === 0 ? null : r.content,
        result: { kept: r.kept, removed: r.removed, missing: r.missing },
      }
    },
  )
  return { authorizedKeysPath: out.authorizedKeysPath, ...out.result }
}
