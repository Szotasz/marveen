/**
 * Hold scheduled deliveries into the MAIN channels session while it is being
 * respawned in-process, and for a short settle after (#1954).
 *
 * MEASURED, on two installs. 2026-10-11 16:40 on ours, 2026-10-14 02:30 on the
 * reporter's, the same order of events each time:
 *
 *   16:40:02.995  stuck-tool-call-watcher: recovering main channels session
 *   16:40:04.545  Scheduled task fired                    <- into the old pane
 *   16:40:07.720  Marveen session respawned with --continue
 *   16:40:21.775  Set session /rename                     <- appended to the park
 *   16:40:31.978  Scheduled prompt did NOT arrive as typed (head-lost)
 *
 * The scheduler checks readiness on the pane it sees, and in that window the
 * pane is either the old claude about to be replaced or a new one still
 * booting. The shared respawn stamp (lastMainRespawnAt) cannot catch this: the
 * respawn paths write it at the END, after the fire has already gone out. So
 * the respawn paths mark the START here, and clear the mark on every exit.
 *
 * WHAT THIS COVERS, and what it does not. It is in-process state, so it sees
 * only the dashboard's own respawns of the main session: respawnMainSessionFresh
 * (scheduled auto-restart), resumeMarveenSession (--continue recovery, the
 * stuck-tool-call-watcher's path) and respawnMarveenSessionFresh (fresh
 * recovery, also the hard-restart fallback). It does NOT see a respawn done
 * outside this process: scripts/channel-watchdog.sh's RESPAWN_CMD, a
 * channels.sh start (boot, launchctl reload, createMainChannelsSession). Those
 * keep today's behaviour.
 *
 * Two bounds keep a leaked mark from muting the main session's schedule:
 *   - every caller ends the mark in a finally, error paths included;
 *   - the in-flight state expires on its own after MAIN_RESPAWN_MAX_INFLIGHT_MS
 *     even if an end never comes.
 */

/** Longest a respawn may count as in flight. The slowest in-process path is
 *  resumeMarveenSession: two pre-respawn reaps, a respawn-pane bounded at 15 s
 *  and two 2 s modal waits. One minute is well past that. */
export const MAIN_RESPAWN_MAX_INFLIGHT_MS = 60_000

/** How long after a respawn ends deliveries still wait. scheduleIdentitySetup
 *  types the /rename about 13-14 s after the respawn (8 s modal delay + 5 s
 *  render wait; measured 16:40:07.7 -> 16:40:21.8), and can retry for up to
 *  15 s more when the pane's send lane is busy. 45 s clears both. */
export const MAIN_RESPAWN_SETTLE_MS = 45_000

export interface MainRespawnState {
  /** Epoch ms the current respawn started; 0 when none is in flight. */
  inFlightSince: number
  /** Epoch ms the last respawn ended; 0 when none has. */
  endedAt: number
}

export type MainRespawnHold = 'in-flight' | 'settling' | null

/** Pure: should a delivery into the main session wait right now? */
export function decideMainRespawnHold(
  s: MainRespawnState,
  now: number,
  maxInFlightMs: number = MAIN_RESPAWN_MAX_INFLIGHT_MS,
  settleMs: number = MAIN_RESPAWN_SETTLE_MS,
): MainRespawnHold {
  if (s.inFlightSince > 0 && now - s.inFlightSince < maxInFlightMs) return 'in-flight'
  if (s.endedAt > 0 && now - s.endedAt < settleMs) return 'settling'
  return null
}

const state: MainRespawnState = { inFlightSince: 0, endedAt: 0 }

/**
 * Mark the start of an in-process respawn of the main session. Returns the end
 * function, which the caller MUST run in a finally. Calling it twice is safe.
 */
export function beginMainRespawn(now: () => number = Date.now): () => void {
  const startedAt = now()
  state.inFlightSince = startedAt
  let ended = false
  return () => {
    if (ended) return
    ended = true
    // A later begin owns the in-flight mark now; only clear our own.
    if (state.inFlightSince === startedAt) state.inFlightSince = 0
    state.endedAt = Math.max(state.endedAt, now())
  }
}

/** The hold that applies to a delivery into the main session right now. */
export function mainRespawnHold(now: number = Date.now()): MainRespawnHold {
  return decideMainRespawnHold(state, now)
}

/** Test-only: a copy of the current state. */
export function _mainRespawnStateForTest(): MainRespawnState {
  return { ...state }
}

/** Test-only: forget every mark. */
export function _resetMainRespawnHoldForTest(): void {
  state.inFlightSince = 0
  state.endedAt = 0
}
