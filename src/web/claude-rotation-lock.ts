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
