// CostOps -- eco mode's third state: local-first.
//
// The first two states are "normal" and "eco" (the fleet moves to a cheap
// model). This is the one the local router made possible: when the cap is
// breached, scheduled work that a local model can actually do goes to the
// router instead of being paid for in the cloud, and only the rest is left to
// the operator's judgement.
//
// Two things this module deliberately does NOT do.
//
// It does not suspend anything. The plan describes local-first as replacing
// suspension -- but measured on 2026-08-07, nothing in the fleet suspends a
// schedule on a cap breach today. There is no behaviour here to replace yet,
// so this states which tasks COULD run locally and leaves the switching to
// whoever wires the execution path.
//
// And it does not guess a task's class. A schedule declares its own class in
// task-config.json; an unlabelled task stays in the cloud. Guessing from the
// prompt text would put a cost decision on a heuristic nobody measured.

import { TASK_CLASSES } from '../llm-router/routing.js'

/** The classes a caller may put in task-config.json -- the router's own list. */
export const ROUTABLE_TASK_CLASSES = Object.keys(TASK_CLASSES)

/**
 * Classes the router will actually serve locally.
 *
 * `agent-loop` is in the router's table only so it can be refused loudly, so
 * it is not a local capability and must never be planned as one.
 */
export const LOCALLY_CAPABLE_CLASSES = ROUTABLE_TASK_CLASSES.filter((c) => c !== 'agent-loop')

export function isRoutableTaskClass(value: unknown): value is string {
  return typeof value === 'string' && ROUTABLE_TASK_CLASSES.includes(value)
}

export interface LabelledTask {
  name: string
  enabled: boolean
  /** Declared in task-config.json; absent means "not classified". */
  taskClass?: string
  type?: 'task' | 'heartbeat' | 'command'
}

export type LocalFirstVerdict = 'local' | 'cloud' | 'exempt' | 'no-llm'

export interface LocalFirstDecision {
  name: string
  verdict: LocalFirstVerdict
  /** Why, in words -- a plan nobody can read is a plan nobody will check. */
  reason: string
}

/**
 * Tasks whose prompts are never sent anywhere by the scheduler.
 *
 * The memory heartbeat stays on the host session by an earlier decision: it
 * depends on the host's own context, so a fresh local context would answer a
 * different question. Kept as a named exemption rather than a silent skip.
 */
export const LOCAL_FIRST_EXEMPT = new Set(['memoria-heartbeat', 'memory-heartbeat'])

/**
 * Which scheduled tasks would move to the local router under local-first.
 *
 * Pure and total: every task gets a verdict and a reason, including the ones
 * that stay where they are. A plan that lists only the movers cannot be
 * checked against the fleet.
 */
export function planLocalFirst(tasks: LabelledTask[]): LocalFirstDecision[] {
  return tasks.map((task) => {
    if (!task.enabled) {
      return { name: task.name, verdict: 'cloud', reason: 'disabled; nothing to route' }
    }
    if (task.type === 'command') {
      return { name: task.name, verdict: 'no-llm', reason: 'raw shell command; no model is involved' }
    }
    if (LOCAL_FIRST_EXEMPT.has(task.name)) {
      return { name: task.name, verdict: 'exempt', reason: 'depends on the host session context' }
    }
    if (!task.taskClass) {
      return { name: task.name, verdict: 'cloud', reason: 'no task class declared in task-config.json' }
    }
    if (!LOCALLY_CAPABLE_CLASSES.includes(task.taskClass)) {
      return {
        name: task.name,
        verdict: 'cloud',
        reason: `class "${task.taskClass}" is not served locally`,
      }
    }
    return { name: task.name, verdict: 'local', reason: `class "${task.taskClass}" routes to a local model` }
  })
}

/** A one-line summary for the alert text; counts, not adjectives. */
export function summariseLocalFirst(decisions: LocalFirstDecision[]): string {
  const count = (v: LocalFirstVerdict) => decisions.filter((d) => d.verdict === v).length
  return (
    `${count('local')} scheduled task(s) can run on the local router, ` +
    `${count('cloud')} still need the cloud, ` +
    `${count('exempt')} exempt, ${count('no-llm')} use no model.`
  )
}
