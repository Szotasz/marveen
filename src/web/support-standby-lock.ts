// One support-standby change at a time in this dashboard process (Dani's review of #2786, R1): the enable route,
// the disable route, the security teardown and the reconcile each run inside this lock, so the daily reconcile can
// never land in the middle of an enable (it would see the half-written token and record as a broken state, take
// them down, and the owner's code would be spent for nothing).
//
// Stated limit: this is a lock of THIS PROCESS. The rescue launcher runs the routine as its own process; an enable
// from there and a reconcile here are not serialised by it (the reconcile's half state then takes the standby down,
// failing closed).
let chain: Promise<unknown> = Promise.resolve()

export function withSupportStandbyLock<T>(step: () => Promise<T>): Promise<T> {
  const run = chain.then(step, step)
  chain = run.catch(() => undefined)
  return run
}
