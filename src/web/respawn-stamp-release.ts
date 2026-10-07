// GAVEUPGRACE917 v2: release the shared respawn stamp when the in-process
// recovery ladder has given up -- but ONLY our own stamp, and only once our
// hard restart has had its settle time.
//
// store/.channel-last-respawn is written by four actors (this monitor,
// channels.sh, scripts/channel-watchdog.sh, the stuck-modal guard). Each
// writer's stamp makes the others DEFER to a respawn that is still settling.
// Once this monitor has logged "giving up auto-recovery", a stamp from its own
// failed hard restart has nothing left to protect and only keeps the
// out-of-process backstop (channel-watchdog.sh, 15-min grace) idle. Clearing
// it removes a suppression; it starts nothing.
//
// Two guards, both from the #1741 review:
//   1. Ownership: the file is removed only while it still holds the exact
//      value this monitor wrote for its hard restart. Any other actor's stamp
//      (a later value) is left alone.
//   2. Settle time: never before RESUME_GRACE_MS has passed since our hard
//      restart, so a restart that is merely still booting is not exposed to a
//      STALE-respawn by the watchdog (the double respawn / 409 the stamp
//      exists to prevent). Too early -> keep, and the caller retries later.

import { readFileSync, renameSync, linkSync, unlinkSync } from 'node:fs'

export interface OwnRespawnStamp {
  /** Exact file content this monitor wrote for its hard restart. */
  value: string
  /** Wall-clock ms of that hard restart. */
  at: number
}

export type StampReleaseDecision = 'release' | 'settling' | 'not-ours' | 'no-stamp'

export function decideRespawnStampRelease(o: {
  fileContent: string | null
  own: OwnRespawnStamp | null
  now: number
  settleMs: number
}): StampReleaseDecision {
  if (o.fileContent === null) return 'no-stamp'
  if (!o.own || o.fileContent.trim() !== o.own.value) return 'not-ours'
  if (o.now - o.own.at < o.settleMs) return 'settling'
  return 'release'
}

function readStamp(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Compare-and-delete. The stamp is first moved aside with an atomic rename,
 * then the moved copy is re-checked: if another actor overwrote the file
 * between our read and the rename, their stamp is restored with link(), which
 * fails rather than clobbers when an even newer stamp has appeared meanwhile
 * (in that case the newest stamp is already in place and wins).
 */
export function releaseOwnRespawnStamp(
  path: string,
  own: OwnRespawnStamp | null,
  now: number,
  settleMs: number,
): StampReleaseDecision {
  const decision = decideRespawnStampRelease({ fileContent: readStamp(path), own, now, settleMs })
  if (decision !== 'release' || !own) return decision
  const aside = `${path}.release-${process.pid}`
  try {
    renameSync(path, aside)
  } catch {
    return 'no-stamp' // vanished between read and rename
  }
  const moved = readStamp(aside)
  if (moved !== null && moved.trim() === own.value) {
    try { unlinkSync(aside) } catch { /* best effort */ }
    return 'release'
  }
  try { linkSync(aside, path) } catch { /* a newer stamp already exists: it wins */ }
  try { unlinkSync(aside) } catch { /* best effort */ }
  return 'not-ours'
}
