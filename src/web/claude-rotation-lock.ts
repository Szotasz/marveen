// PLANROTATEDEADLOCK1115 P3: one in-process lock for a plan rotation, shared by the backend tick and
// POST /api/claude-plans/rotate, so the two never interleave (a tick deciding while a manual rotation restarts the
// main agent, or two rotations racing). Callers queue in order; a failing call does not break the chain.
let tail: Promise<unknown> = Promise.resolve()
let holders = 0

export function withRotationLock<T>(fn: () => Promise<T>): Promise<T> {
  holders++
  const run = tail.then(fn, fn).finally(() => { holders-- })
  tail = run.catch(() => undefined)
  return run
}

/** True while a rotation (tick or route) holds or waits for the lock. */
export function rotationLockBusy(): boolean {
  return holders > 0
}

/**
 * PLANROTATEDEADLOCK1115 P5: the minimum gap between two MAIN-agent rotations (each one restarts the main session).
 *
 * Why 30 minutes: the check runs every CLAUDE_ROTATION_CHECK_EVERY_MIN (default 10), and a header-less 429 counts as
 * exhausted only on the second probe in a row (the C-rule), so the earliest follow-up rotation the decision asks for
 * is two ticks (20 minutes) after the previous one, or one tick when the idle refresh (CLAUDE_PLAN_USAGE_REFRESH, on
 * by default) already marked the new plan. In a wave where every plan answers a header-less 429 that is what happens
 * (Dani N1; measured on the whole chain in claude-rotation-guard-wave.test.ts: with 3 or more plans a main restart
 * every 10 to 20 minutes for the whole wave). 30 minutes is the smallest round gap with a full tick of margin over
 * the two-tick flip, so that flip is always refused, and it is short enough that a plan that really runs out soon
 * after a switch waits at most about half an hour (the stale-check alert threshold) for the next one. It is
 * wall-clock time, not a tick count, so a shorter tick setting cannot make the restarts more frequent than once per
 * 30 minutes; with a longer one (15 or more) two ticks already exceed it.
 * Also closes the window PR2 left open: the old main-agent task and the backend deciding in the same minute.
 */
export const MAIN_ROTATION_MIN_GAP_MS = 30 * 60_000

/** How long ago the last main-agent rotation was when it is too recent for another one, else null. */
export function mainRotationTooSoon(lastRotationAt: number | undefined, nowMs: number): number | null {
  if (lastRotationAt === undefined) return null
  const ago = nowMs - lastRotationAt
  return ago >= 0 && ago < MAIN_ROTATION_MIN_GAP_MS ? ago : null
}
