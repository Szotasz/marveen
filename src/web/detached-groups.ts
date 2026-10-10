import { logger } from '../logger.js'

// DETACHEDSHUTDOWN1007: the process groups the dashboard starts DETACHED (a
// command task since #1772, a pre-check since #1759) are outside the
// dashboard's own process group on purpose, so a timeout can end everything a
// script started. The flip side: when the dashboard itself stops, nothing ends
// them. Measured 2026-10-07 with a stand-in parent: after SIGTERM and exit, the
// detached bash and the sleep it had started both kept running (ppid 1), and
// with the parent gone their own timeout timers were gone too.
//
// This registry holds the groups that are running right now; the dashboard's
// shutdown (src/index.ts) ends them all. A group leaves the registry as soon
// as it is known to be finished, because a stale entry is dangerous: a pid is
// reused, and kill(-pid) on a stale one would hit a stranger's group.
const groups = new Map<number, string>()

/** Track a detached group (its leader's pid); the returned function untracks it. */
export function trackDetachedGroup(pid: number | undefined, label: string): () => void {
  if (pid == null) return () => {}
  groups.set(pid, label)
  let done = false
  return () => {
    if (done) return
    done = true
    if (groups.get(pid) === label) groups.delete(pid)
  }
}

/** The groups tracked right now (tests and diagnostics). */
export function runningDetachedGroups(): Array<{ pid: number; label: string }> {
  return [...groups].map(([pid, label]) => ({ pid, label }))
}

/**
 * End every tracked group with SIGKILL and clear the registry. Called from the
 * dashboard's shutdown; returns how many groups were signalled. ESRCH (already
 * gone) is the goal and stays quiet; any other error is logged.
 */
export function endAllDetachedGroups(reason: string): number {
  let signalled = 0
  for (const [pid, label] of groups) {
    try {
      process.kill(-pid, 'SIGKILL')
      signalled++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn({ pid, label, reason, error: (err as Error).message }, 'shutdown: could not end a detached process group')
      }
    }
  }
  groups.clear()
  if (signalled > 0) logger.info({ count: signalled, reason }, 'shutdown: ended the running detached process groups')
  return signalled
}
