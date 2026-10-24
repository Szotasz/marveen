// The server's own rewrites of a task, kept in step with the registry.
//
// The registry (schedule-registry.ts) trusts a task only while its files hash to
// the value the server last registered. Two server-side writers change task
// files outside the schedule routes:
//   * disableOnceTask (card 7d2b49b4): switches a once task off after its first
//     successful run (schedule-runner settleOnceAfterRun, command-task);
//   * the Claude-plan rotation heartbeat: created at startup and
//     enabled/disabled by the Settings toggle.
// Without re-registering, the first one would leave a fired once task with a
// stale hash (every later toggle/PUT gets 409 "changed outside the dashboard
// API"), and the second one would write a task the runner never fires.
//
// rewriteRegisteredTask is the rule for a server rewrite of an EXISTING task:
// re-register only if the task was trusted (registered, hash match) right before
// the server's own write. A task that was already untrusted (a plant, a hand
// edit) stays untrusted -- the server's write must not launder it. The write
// itself behaves exactly as before: its errors reach the caller unchanged, and a
// registry failure is logged, never thrown over a write that already happened.
// Known, accepted window: a same-user file plant landing BETWEEN the trust check
// and the server's write would be registered with it. Planting there already
// takes a same-user writer racing a millisecond window; the registry's stated
// scope (schedule-registry.ts) is file-only plants, not a racing local process.
//
// Kept out of schedule-registry.ts on purpose: a dozen suites mock that module
// with a fixed export list, and a new export there would turn every caller into
// a "no export defined on the mock" crash inside those suites.

import { logger } from '../logger.js'
import { readScheduledTask } from './scheduled-tasks-io.js'
import { registerScheduledTask, verifyScheduledTask } from './schedule-registry.js'

export function rewriteRegisteredTask(dirName: string, source: string, write: () => boolean): boolean {
  let wasTrusted = false
  try {
    const before = readScheduledTask(dirName)
    wasTrusted = !!before && verifyScheduledTask(before).ok
  } catch (err) {
    logger.warn({ err, task: dirName }, 'schedule-registry: trust check before a server rewrite failed; the task will not be re-registered')
  }
  const changed = write()
  if (!changed) return false
  if (!wasTrusted) {
    logger.warn(
      { task: dirName, source },
      'schedule-registry: server rewrote a task that was NOT registered (or whose files had changed) before the write; ' +
        'left unregistered, so the runner still will not fire it. Review the files and re-register through the dashboard/API or the CLI.',
    )
    return true
  }
  try {
    if (registerScheduledTask(dirName, source) === null) {
      logger.warn({ task: dirName, source }, 'schedule-registry: re-registration after a server rewrite read no task hash; the task stays unregistered')
    }
  } catch (err) {
    logger.warn({ err, task: dirName, source }, 'schedule-registry: re-registration after a server rewrite failed; the task stays unregistered')
  }
  return true
}

// A task the server just CREATED from its own code (no directory existed): the
// content is server-authored, so it is registered like a repo-default seed.
export function registerServerCreatedTask(dirName: string, source: string): void {
  try {
    if (registerScheduledTask(dirName, source) === null) {
      logger.warn({ task: dirName, source }, 'schedule-registry: a server-created task has no readable hash; the runner will not fire it until it is registered')
    }
  } catch (err) {
    logger.warn({ err, task: dirName, source }, 'schedule-registry: registering a server-created task failed; the runner will not fire it until it is registered')
  }
}
