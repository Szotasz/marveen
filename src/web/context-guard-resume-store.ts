import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'
import { INITIAL_GUARD_STATE, type GuardState, type HandoffStaleness } from '../context-guard.js'

// The context-guard's "restarted, resume prompt
// still owed" state used to live ONLY in the runner's in-memory guardStates
// map. A dashboard restart between the agent's fresh restart and the next
// sweep wiped it: the new process re-armed every agent at 'idle', the resume
// prompt was never sent, and the fresh session sat at an empty prompt with no
// pointer to its HANDOFF.md (measured 2026-09-24 10:18: a dashboard restart
// 5.7s after an agent start, the agent idle until noticed by hand).
//
// This file persists exactly that one obligation -- nothing else of the guard
// state machine. The other phases are safe to lose (see the guardStates
// comment in context-guard-runner.ts); this one is not, because nothing else
// will ever tell the fresh session to continue.

export const PENDING_RESUME_PATH = join(PROJECT_ROOT, 'store', 'context-guard-pending-resume.json')

/**
 * How long a persisted resume obligation stays deliverable after the restart
 * that created it. Bounded so a dashboard that stays down (or a session that
 * never becomes ready) cannot fire "continue from your handoff" into a session
 * hours or days later, after it has long moved on to other work. 30 minutes
 * covers a dashboard restart plus the runner's 4.5-minute initial delay with a
 * wide margin, and is still short enough that the handoff is recent work.
 */
export const PENDING_RESUME_TTL_MS = 30 * 60_000

export interface PendingResume {
  /** When the fresh restart completed (ms). The TTL is measured from here. */
  restartedAtMs: number
  /** Handoff staleness measured at restart time; the resume prompt says it. */
  handoffStaleMinutes: HandoffStaleness
  /** The decision reason, for the log line only. */
  reason: string
}

export type PendingResumeMap = Record<string, PendingResume>

function isStaleness(v: unknown): v is HandoffStaleness {
  return v === null || v === 'unknown' || (typeof v === 'number' && Number.isFinite(v))
}

/** Parse the file contents defensively: a malformed entry is dropped, never thrown. */
export function parsePendingResumes(raw: unknown): PendingResumeMap {
  const out: PendingResumeMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (typeof e.restartedAtMs !== 'number' || !Number.isFinite(e.restartedAtMs)) continue
    out[name] = {
      restartedAtMs: e.restartedAtMs,
      handoffStaleMinutes: isStaleness(e.handoffStaleMinutes) ? e.handoffStaleMinutes : null,
      reason: typeof e.reason === 'string' ? e.reason : '',
    }
  }
  return out
}

// A missing file is the normal "nothing owed" state and stays silent. Any other
// failure (an unreadable file, corrupt JSON) still answers {} -- the caller must
// keep running -- but says so: those resume obligations are lost, and the next
// write overwrites the file. Every read error used to be swallowed without a trace.
export function readPendingResumes(path: string = PENDING_RESUME_PATH): PendingResumeMap {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ path, code: (err as NodeJS.ErrnoException).code, error: (err as Error).message }, 'context-guard: pending-resume file unreadable, treating it as empty (its resume obligations are lost)')
    }
    return {}
  }
  try {
    return parsePendingResumes(JSON.parse(text))
  } catch (err) {
    logger.warn({ path, error: (err as Error).message }, 'context-guard: pending-resume file is not valid JSON, treating it as empty (its resume obligations are lost)')
    return {}
  }
}

export function writePendingResumes(map: PendingResumeMap, path: string = PENDING_RESUME_PATH): void {
  atomicWriteFileSync(path, JSON.stringify(map, null, 2))
}

/**
 * Pure: split persisted obligations into the ones still deliverable at nowMs
 * (as the await-ready GuardState to re-arm them with) and the expired ones.
 *
 * The restored deadline is the TTL edge, not READY_TIMEOUT_MS from now: the
 * obligation's age is what bounds it, so a flapping dashboard cannot extend it
 * indefinitely by restarting. A restartedAtMs in the future (clock change) is
 * treated as "just now" -- a wrong clock must not make an entry immortal.
 */
export function restorableResumeStates(
  map: PendingResumeMap,
  nowMs: number,
  ttlMs: number = PENDING_RESUME_TTL_MS,
): { live: Map<string, GuardState>; expired: string[] } {
  const live = new Map<string, GuardState>()
  const expired: string[] = []
  for (const [name, entry] of Object.entries(map)) {
    const restartedAt = Math.min(entry.restartedAtMs, nowMs)
    const deadlineMs = restartedAt + ttlMs
    if (nowMs >= deadlineMs) {
      expired.push(name)
      continue
    }
    live.set(name, {
      ...INITIAL_GUARD_STATE,
      phase: 'await-ready',
      deadlineMs,
      handoffStaleMinutes: entry.handoffStaleMinutes,
    })
  }
  return { live, expired }
}
