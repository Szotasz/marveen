import { logger } from '../logger.js'
import { capturePane } from './agent-process.js'
import { workerContexts, isWorkerSessionAlive } from './agent-worker.js'

// Worker-session liveness instrument (WORKERBOOT1).
//
// The two interactive worker sessions are pre-started once at boot and then
// never looked at again: scripts/watchdog.sh only covers "<agent>-channels",
// channel-monitor.ts does not know about workers, and workerSessionExists() is
// used solely for start-time idempotency and the in-request poll. So when a
// worker dies, NOTHING notices, nothing logs it, and the operator only finds
// out by running `tmux ls` and seeing it absent.
//
// Measured on a live host 2026-07-30: both sessions were created at 11:42
// (two "launched interactive worker session" lines, which only run AFTER a
// successful tmux new-session), and by 18:00 neither existed -- with zero log
// lines about them in between.
//
// This module does NOT try to fix or explain the death. That is deliberate:
// with no record of when or how they die, any fix would be a guess. It only
// answers "when did it go, how long did it live, and what was on the pane last"
// -- which is what narrows the cause. A death within seconds points at the
// launch line; a death after hours points somewhere else entirely.
//
// The pane cannot be read post mortem (the session is gone), so each poll keeps
// the last pane seen while the worker was still alive, and the death log
// reports that snapshot.

export interface WorkerLivenessState {
  /** When we first saw this session alive; the base for the lifetime figure. */
  firstSeenAtMs: number | null
  /** The most recent poll at which the session still existed. */
  lastSeenAliveAtMs: number | null
  /** Last pane captured while alive -- the only post-mortem evidence available. */
  lastPane: string | null
  /**
   * True when the FIRST sighting happened on the monitor's first sweep, i.e.
   * the session already existed before this process did. Its real age is then
   * unknown and any lifetime we report is a LOWER BOUND.
   */
  firstSeenOnFirstSweep: boolean
}

export interface WorkerLivenessObservation {
  alive: boolean
  /** Pane content when alive; null when the capture failed or the session is gone. */
  pane: string | null
  nowMs: number
  /**
   * Whether this is the monitor's first sweep. A dashboard restart (deploy,
   * promote, watchdog) empties the state while the tmux session survives --
   * startWorkerSession() is idempotent -- so without this the first sweep would
   * record "first seen now" for a session that may already be hours old, and a
   * later death would report a truncated lifetime. That points the reader at
   * the launch line when the cause is elsewhere, which is the exact mistake
   * this instrument exists to prevent.
   */
  isFirstSweep: boolean
}

export interface WorkerLivenessDecision {
  /** True exactly once per death: on the alive -> absent transition. */
  logDeath: boolean
  /** How long the session lived, from first sighting to last sighting. */
  lifetimeMs: number | null
  /** The pane as last observed while alive. */
  lastPane: string | null
  /**
   * True when lifetimeMs is a LOWER BOUND, not the real age: the session
   * predates this monitor process. Reported rather than guessed -- the missing
   * knowledge is flagged, not hidden.
   */
  lifetimeTruncated: boolean
  next: WorkerLivenessState
}

export const NO_WORKER_LIVENESS_STATE: WorkerLivenessState = {
  firstSeenAtMs: null,
  lastSeenAliveAtMs: null,
  lastPane: null,
  firstSeenOnFirstSweep: false,
}

/** Keep the death log bounded: the tail is where a crash message would be. */
export const DEATH_PANE_LINES = 15

export function tailLines(pane: string | null, n = DEATH_PANE_LINES): string | null {
  if (pane == null) return null
  const lines = pane.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return null
  return lines.slice(-n).join('\n')
}

/**
 * Pure liveness decision. Logs a death exactly once, on the transition from
 * "seen alive" to "absent", and then resets -- so a worker that stays gone does
 * not re-log on every poll, and a later restart starts a fresh lifetime.
 *
 * A session we have NEVER seen alive is not a death: that is the WEB_ONLY case,
 * a poll that raced the boot pre-start, or a host where the worker never
 * started at all. Reporting those as deaths would make the signal useless.
 */
export function decideWorkerLiveness(
  obs: WorkerLivenessObservation,
  prev: WorkerLivenessState,
): WorkerLivenessDecision {
  if (obs.alive) {
    const isNewSighting = prev.firstSeenAtMs == null
    return {
      logDeath: false,
      lifetimeMs: null,
      lastPane: null,
      lifetimeTruncated: false,
      next: {
        firstSeenAtMs: prev.firstSeenAtMs ?? obs.nowMs,
        lastSeenAliveAtMs: obs.nowMs,
        firstSeenOnFirstSweep: isNewSighting ? obs.isFirstSweep : prev.firstSeenOnFirstSweep,
        // Keep the previous snapshot when this capture failed, so a transient
        // capture error does not blank the only evidence we will have.
        lastPane: obs.pane ?? prev.lastPane,
      },
    }
  }

  // Absent, and we never saw it alive: nothing happened worth reporting.
  if (prev.lastSeenAliveAtMs == null) {
    return { logDeath: false, lifetimeMs: null, lastPane: null, lifetimeTruncated: false, next: NO_WORKER_LIVENESS_STATE }
  }

  // Absent after having been alive: the one transition worth a log line.
  const lifetimeMs =
    prev.firstSeenAtMs != null ? prev.lastSeenAliveAtMs - prev.firstSeenAtMs : null
  return {
    logDeath: true,
    lifetimeMs,
    lastPane: tailLines(prev.lastPane),
    lifetimeTruncated: prev.firstSeenOnFirstSweep,
    next: NO_WORKER_LIVENESS_STATE,
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────
// Thin on purpose: the decision above is pure and unit-tested, this only wires
// it to tmux and the logger. Dependencies are injected so the sweep is testable
// without a tmux server.

export interface WorkerLivenessDeps {
  sessions: () => Array<{ session: string }>
  isAlive: (session: string) => boolean
  capture: (session: string) => string | null
  onDeath: (info: { session: string; lifetimeMs: number | null; lastPane: string | null; lifetimeTruncated: boolean }) => void
  now: () => number
}

export function sweepWorkerLiveness(
  deps: WorkerLivenessDeps,
  states: Map<string, WorkerLivenessState>,
  isFirstSweep = false,
): void {
  for (const { session } of deps.sessions()) {
    const alive = deps.isAlive(session)
    const decision = decideWorkerLiveness(
      { alive, pane: alive ? deps.capture(session) : null, nowMs: deps.now(), isFirstSweep },
      states.get(session) ?? NO_WORKER_LIVENESS_STATE,
    )
    states.set(session, decision.next)
    if (decision.logDeath) {
      deps.onDeath({
        session,
        lifetimeMs: decision.lifetimeMs,
        lastPane: decision.lastPane,
        lifetimeTruncated: decision.lifetimeTruncated,
      })
    }
  }
}

/** Poll cadence: fine enough to bracket a death, cheap enough to ignore. */
export const LIVENESS_POLL_MS = 60_000

/**
 * Wire the sweep to tmux and the logger. Returns the interval handle so the
 * caller can clear it, matching the other monitors in this codebase.
 */
export function startWorkerLivenessMonitor(): NodeJS.Timeout {
  const states = new Map<string, WorkerLivenessState>()
  const deps: WorkerLivenessDeps = {
    sessions: () => workerContexts().map((c) => ({ session: c.session })),
    isAlive: (session) => isWorkerSessionAlive(session),
    capture: (session) => capturePane(session),
    now: () => Date.now(),
    onDeath: ({ session, lifetimeMs, lastPane, lifetimeTruncated }) => {
      logger.warn(
        {
          session,
          lifetimeMs,
          lifetimeMin: lifetimeMs == null ? null : Math.round(lifetimeMs / 60_000),
          // The session predated this monitor process, so the figure above is a
          // LOWER BOUND. Said out loud rather than estimated: a truncated
          // lifetime reads like a fast death and would point at the launch line.
          lifetimeTruncated,
          lastPane,
        },
        lifetimeTruncated
          ? 'worker-liveness: worker session disappeared (lifetime is a LOWER BOUND: the session predated this monitor, e.g. a dashboard restart)'
          : 'worker-liveness: worker session disappeared (it was started, then died -- nothing restarts it until the next request)',
      )
    },
  }
  let first = true
  const tick = (): void => {
    try {
      sweepWorkerLiveness(deps, states, first)
    } catch (err) {
      logger.warn({ err }, 'worker-liveness: sweep failed (continuing)')
    } finally {
      first = false
    }
  }
  return setInterval(tick, LIVENESS_POLL_MS)
}
