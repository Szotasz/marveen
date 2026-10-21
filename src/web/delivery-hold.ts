// Delivery hold around a context-guard restart.
//
// THE LOSS THIS CLOSES. When the context-guard restarts an agent it asks for a
// handoff and waits for it (await-handoff), restarts the session, and waits for
// the fresh session to take its resume prompt (await-ready). The message router
// knew nothing of this. In the window between the handoff being written and the
// old pane being killed, an idle old pane reads as ready, and a message pasted
// there dies with it: the row says "delivered", the handoff predates it, and the
// fresh session never sees it. The resume prompt's "re-read your recent queue"
// step can recover some of them after the fact; the hold keeps them in the queue
// instead, and they go to the fresh session once it has its resume prompt.
//
// The guard owns the knowledge (its phases); the router asks. The guard registers
// its probe when it starts. With no guard running there is no restart to hold
// for, and the default answers "not held".
//
// FAIL-OPEN. A probe that throws answers "not held", and the guard's own probe
// ends every hold at the phase's current deadline plus one sweep -- never at a
// time computed from `now` -- so a guard that stops sweeping cannot keep an
// agent's inbox shut.
import { logger } from '../logger.js'

export interface DeliveryHold {
  /** What the guard is doing, for the logs. */
  phase: string
  /** Epoch ms at which the hold lapses. */
  untilMs: number
}

export type DeliveryHoldProbe = (agent: string, nowMs: number) => DeliveryHold | null

let probe: DeliveryHoldProbe | null = null

export function setDeliveryHoldProbe(fn: DeliveryHoldProbe | null): void {
  probe = fn
}

/** The hold on `agent`'s inbound rows at `nowMs`, or null when they may be delivered. */
export function deliveryHoldFor(agent: string, nowMs: number): DeliveryHold | null {
  if (!probe) return null
  try {
    return probe(agent, nowMs)
  } catch (err) {
    logger.warn({ err, agent }, 'delivery hold probe failed -- delivering (fail-open)')
    return null
  }
}
