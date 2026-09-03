// Desktop lock: ONE piece of state behind ONE call, so the fleet's "I am
// driving the screen" convention becomes something a machine can gate on.
//
// Until now the lock was a convention only: the holder broadcast [DESKTOP-LOCK]
// to the other agents and everyone was expected to keep their hands off. That
// works for agents reading their inbox, and not at all for the scheduler, which
// happily fires a GUI round into a session already driving the same screen.
//
// WHY THE BROADCAST IS SENT BY THE SAME CALL THAT SETS THE STATE (and not by
// the caller, next to it): two mechanisms with no shared state are not two
// protections, they are one extra failure path. A holder who broadcasts and
// forgets the state call leaves the gate OPEN while the fleet believes the
// screen is taken; the reverse leaves the gate CLOSED while everyone believes
// it is free -- and neither divergence produces an error message. One call
// cannot drift from itself.
//
// The gate deliberately does NOT stop everything. Only the rounds that need the
// screen wait; email, kanban, memory and the watchdogs keep running. A blanket
// suspension would produce blanket silence, and silence is what nobody
// questions.
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const DESKTOP_LOCK_PATH = join(PROJECT_ROOT, 'store', 'desktop-lock.json')

/** Grace added to the holder's own estimate before the lock is considered
 *  abandoned. Generous on purpose: a GUI round that runs long is normal, a
 *  holder that died is not, and only the second one should open the gate. */
export const TTL_GRACE_MS = 30 * 60_000

/** Used when the holder gave no estimate. The gate records that it fell back
 *  to this, because a missing estimate is itself worth seeing: the protocol
 *  asks for one so peers can plan, and its absence means someone skipped it. */
export const DEFAULT_ESTIMATE_MS = 30 * 60_000

export interface DesktopLock {
  owner: string
  /** epoch ms */
  acquiredAt: number
  /** epoch ms; null when the holder gave no estimate (see estimateProvided) */
  estimatedEndAt: number | null
  /** false => estimatedEndAt was derived from DEFAULT_ESTIMATE_MS */
  estimateProvided: boolean
  /** epoch ms of the most recent extension, if the holder re-locked */
  extendedAt?: number
  /** how many times the holder extended -- an estimate that needed three
   *  extensions is a better planning signal than the original number */
  extensions?: number
  note?: string
}

export function readDesktopLock(path: string = DESKTOP_LOCK_PATH): DesktopLock | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DesktopLock>
    if (!parsed || typeof parsed.owner !== 'string' || !parsed.owner) return null
    if (typeof parsed.acquiredAt !== 'number') return null
    return {
      owner: parsed.owner,
      acquiredAt: parsed.acquiredAt,
      estimatedEndAt: typeof parsed.estimatedEndAt === 'number' ? parsed.estimatedEndAt : null,
      estimateProvided: parsed.estimateProvided === true,
      extendedAt: typeof parsed.extendedAt === 'number' ? parsed.extendedAt : undefined,
      extensions: typeof parsed.extensions === 'number' ? parsed.extensions : undefined,
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
    }
  } catch (err) {
    // An unreadable lock file must not wedge the fleet: treat it as no lock and
    // say so loudly. The alternative (fail closed) would stop every GUI round
    // until a human noticed a JSON typo.
    logger.warn({ err, path }, 'desktop-lock: unreadable lock file, treating as unlocked')
    return null
  }
}

export function writeDesktopLock(lock: DesktopLock, path: string = DESKTOP_LOCK_PATH): void {
  atomicWriteFileSync(path, JSON.stringify(lock, null, 2) + '\n')
}

export function clearDesktopLock(path: string = DESKTOP_LOCK_PATH): void {
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

/** When the lock stops being believed, in epoch ms. */
export function lockExpiresAt(lock: DesktopLock): number {
  const end = lock.estimatedEndAt ?? lock.acquiredAt + DEFAULT_ESTIMATE_MS
  return end + TTL_GRACE_MS
}

export type DesktopGateAction = 'run' | 'skip' | 'run-lock-expired'

export interface DesktopGateDecision {
  action: DesktopGateAction
  /** Human-readable reason, written to the skip record / log verbatim so the
   *  decision is auditable without re-deriving it. */
  reason: string
  lockOwner?: string
  /** epoch ms, present when a live lock is what caused a skip */
  lockedUntil?: number
}

/**
 * Pure gate decision. Kept free of IO so the interesting cases (expiry, own
 * lock, missing estimate) are testable without a filesystem or a clock.
 *
 * `requiresDesktop` comes from the task's own config, never from a hard-coded
 * list of task names here: a hand-maintained list is a blind spot the day
 * someone adds a GUI round and forgets this file.
 *
 * A holder is never gated against ITSELF -- the lock exists to keep OTHERS off
 * the screen, and a holder blocked by its own lock would deadlock its own
 * round.
 */
export function decideDesktopGate(facts: {
  requiresDesktop: boolean
  lock: DesktopLock | null
  now: number
  /** the agent whose round is about to run */
  agent?: string | null
}): DesktopGateDecision {
  const { requiresDesktop, lock, now, agent } = facts
  if (!requiresDesktop) return { action: 'run', reason: 'task does not need the desktop' }
  if (!lock) return { action: 'run', reason: 'no desktop lock held' }

  const expiresAt = lockExpiresAt(lock)
  if (now >= expiresAt) {
    // Expiry is a FINDING, not routine: either the estimate was wrong or the
    // holder died. The caller reports it; we make sure the wording carries
    // which of the two shapes it looks like.
    const overdueMin = Math.round((now - expiresAt) / 60_000)
    return {
      action: 'run-lock-expired',
      reason: `desktop lock held by ${lock.owner} expired ${overdueMin} min ago `
        + `(${lock.estimateProvided ? 'own estimate' : 'DEFAULT estimate -- none was given'} + grace); gate opened`,
      lockOwner: lock.owner,
      lockedUntil: expiresAt,
    }
  }

  if (agent && agent === lock.owner) {
    return { action: 'run', reason: `${agent} holds the desktop lock itself`, lockOwner: lock.owner }
  }

  const remainingMin = Math.max(0, Math.round((expiresAt - now) / 60_000))
  return {
    action: 'skip',
    reason: `desktop locked by ${lock.owner} for up to ${remainingMin} more min`
      + (lock.estimateProvided ? '' : ' (no estimate given, default used)'),
    lockOwner: lock.owner,
    lockedUntil: expiresAt,
  }
}

export const DESKTOP_SKIPS_PATH = join(PROJECT_ROOT, 'store', 'desktop-lock-skips.json')
/** Bound the file: this is an operational trail, not an archive. */
const MAX_SKIP_RECORDS = 200

export interface DesktopSkipRecord {
  task: string
  agent: string
  /** epoch ms */
  at: number
  lockOwner: string | null
  /** epoch ms the lock was believed to hold until */
  lockedUntil: number | null
  reason: string
}

/**
 * Record a skipped round. A dropped tick that leaves no trace is
 * indistinguishable from "there was nothing to do" -- and that is exactly how
 * a missed customer message disappears. The record answers the three questions
 * a later reader has: WHICH round, WHEN, and HOW LONG the screen was taken.
 *
 * Failure to write must not break the schedule tick: losing the trail is bad,
 * losing the run loop is worse.
 */
export function recordDesktopSkip(rec: DesktopSkipRecord, path: string = DESKTOP_SKIPS_PATH): void {
  try {
    let list: DesktopSkipRecord[] = []
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (Array.isArray(parsed)) list = parsed as DesktopSkipRecord[]
    }
    list.push(rec)
    if (list.length > MAX_SKIP_RECORDS) list = list.slice(-MAX_SKIP_RECORDS)
    atomicWriteFileSync(path, JSON.stringify(list, null, 2) + '\n')
  } catch (err) {
    logger.warn({ err, task: rec.task }, 'desktop-lock: could not record skipped round')
  }
}
