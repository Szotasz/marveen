// A write the session was too busy for, retried once the turn ends.
//
// ELSOKOR922 Phase 7 A-smoke, owner request 2026-09-22: `/model sonnet keep`
// answered "a session foglalt (pane-busy)" and that was the end of it -- the
// owner had to notice and resend. A write is cheap to repeat and the owner
// already asked for it, so it is queued instead, and run at the next quiet
// moment.
//
// NOT a poll: the Stop hook (marveen-commands.py --stop) reports the end of
// every main-session turn, and the runner arms ONE attempt after the switch
// quiet window. The gate's own sweep is the restart-survivor fallback.
//
// Bounds, so a forgotten command never surprises the owner minutes later:
// ONE pending write at a time (a newer one replaces it), a 10-minute deadline,
// and every outcome -- ran, expired, still busy at the deadline -- is reported
// on the main bot.

import { readFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { dispatchCommand } from './commands.js'
import { notifyChannel } from '../notify.js'

export const PENDING_WRITE_FILE = join(STORE_DIR, 'main-command-pending.json')
export const PENDING_WRITE_TTL_MS = 10 * 60_000

export interface PendingWrite {
  text: string
  ownerId: number
  queuedAt: number
  /** epoch ms: after this the command is dropped, not run. */
  deadline: number
}

export function readPendingWrite(file = PENDING_WRITE_FILE): PendingWrite | null {
  try {
    const p = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PendingWrite>
    if (typeof p.text !== 'string' || typeof p.deadline !== 'number' || !Number.isFinite(p.deadline)) return null
    return {
      text: p.text,
      ownerId: typeof p.ownerId === 'number' ? p.ownerId : 0,
      queuedAt: typeof p.queuedAt === 'number' ? p.queuedAt : 0,
      deadline: p.deadline,
    }
  } catch { return null }
}

export function clearPendingWrite(file = PENDING_WRITE_FILE): void {
  try { unlinkSync(file) } catch { /* already gone */ }
}

// The deadline of the write currently being retried. The runner clears the
// file before dispatching (so a crash mid-run cannot run it twice), so without
// this the write's own re-queue would start a fresh 10 minutes every time --
// a permanently busy session would retry forever.
let retryingDeadline: number | null = null

/** Queue (or replace) the pending write. Returns the deadline it will wait to. */
export function queuePendingWrite(text: string, ownerId: number, nowMs: number, file = PENDING_WRITE_FILE): number {
  const existing = readPendingWrite(file)
  const deadline = retryingDeadline
    ?? (existing && existing.text === text ? existing.deadline : nowMs + PENDING_WRITE_TTL_MS)
  try {
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, JSON.stringify({ text, ownerId, queuedAt: nowMs, deadline }) + '\n')
    logger.info({ text, deadline: new Date(deadline).toISOString(), retry: retryingDeadline !== null },
      'pending-write: queued (session busy)')
  } catch (err) {
    logger.warn({ err, file }, 'pending-write: not queued')
  }
  return deadline
}

export type PendingOutcome = 'none' | 'expired' | 'ran' | 'still-busy'

export interface PendingDeps {
  notify: (text: string) => Promise<unknown>
  dispatch: typeof dispatchCommand
  file: string
}

export const livePendingDeps: PendingDeps = {
  notify: notifyChannel,
  dispatch: dispatchCommand,
  file: PENDING_WRITE_FILE,
}

/**
 * Run the queued write, if any. The command's own quiet checks decide again:
 * a still-busy refusal re-queues (same deadline) and stays silent -- the owner
 * already got one "busy" reply -- while a run, or the deadline passing, is
 * reported.
 */
export async function runPendingWrite(nowMs: number, deps: PendingDeps = livePendingDeps): Promise<PendingOutcome> {
  const pending = readPendingWrite(deps.file)
  if (!pending) return 'none'
  const waitedMs = Math.max(0, nowMs - pending.queuedAt)
  if (nowMs > pending.deadline) {
    clearPendingWrite(deps.file)
    logger.warn({ text: pending.text, waitedMs }, 'pending-write: deadline passed, dropped')
    await deps.notify(`Nem futott le: ${pending.text} -- a session ${Math.round(PENDING_WRITE_TTL_MS / 60_000)} percig foglalt maradt. Küldd el újra, ha még kell.`)
    return 'expired'
  }
  // Cleared BEFORE the run: the command re-queues itself when it is refused
  // again, so a crash mid-run cannot leave a command that runs twice.
  clearPendingWrite(deps.file)
  const replies: string[] = []
  retryingDeadline = pending.deadline
  try {
    await deps.dispatch(pending.text, {
      reply: async (t: string) => { replies.push(t) },
      ownerId: pending.ownerId,
      now: nowMs,
    })
  } finally {
    retryingDeadline = null
  }
  if (readPendingWrite(deps.file)) {
    logger.info({ text: pending.text, waitedMs }, 'pending-write: still busy, waiting for the next turn end')
    return 'still-busy'   // the run re-queued it
  }
  logger.info({ text: pending.text, waitedMs, replies: replies.length },
    'pending-write: ran after the session went quiet')
  await deps.notify(`${pending.text} (a foglalt session után, ${Math.round(waitedMs / 1000)} mp várakozás): ${replies.join('\n')}`)
  return 'ran'
}
