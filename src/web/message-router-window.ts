import type { AgentMessage } from '../db.js'

/**
 * Which pending rows one router tick evaluates (card fc5748f5).
 *
 * It used to be `localPending.slice(0, MAX_MESSAGES_PER_TICK)`: the globally
 * oldest rows. When those belonged to busy recipients, every other recipient,
 * idle ones included, was not evaluated at all that tick, and the next tick saw
 * the same window. Measured 2026-09-23 13:4xZ: 86 pending, the oldest from
 * 11:35Z, and an idle agent's rows untouched for over an hour without even a
 * "busy, will retry" line, because the router never looked at them.
 *
 * Now the window is filled round-robin across recipients: each round takes the
 * next row of every recipient, recipients ordered by their first row in the
 * delivery order (card ad771121: a recipient holding a high row first, then the
 * rest by their oldest pending row), until `max` rows. So every recipient with a
 * pending row is evaluated every tick (up to `max` recipients), a lone recipient
 * still gets up to `max` rows (the serial path delivers exactly as before), and
 * each recipient's rows keep their order, which the batch-mate collection relies
 * on (it looks AFTER the head row).
 *
 * Card ad771121, the window finding (kept on purpose): when the window has no room for every
 * recipient (more than `max`), that order decides who is in it at all. A recipient holding a high row enters first; if
 * it would not have fit by age, the recipient that came last by age stays out in
 * its place, for as long as that high row is pending. When there is room for
 * every recipient, every recipient is in every window either way.
 *
 * The main agent's rows are left out: it drains its own inbox (pull model) and
 * the tick skips its rows anyway, so in the window they only took a slot.
 */
export function selectTickWindow(
  localPending: readonly AgentMessage[],
  max: number,
  mainAgentId: string,
): AgentMessage[] {
  const perRecipient = new Map<string, AgentMessage[]>()
  for (const m of localPending) {
    if (m.to_agent === mainAgentId) continue
    const rows = perRecipient.get(m.to_agent)
    if (rows) rows.push(m)
    else perRecipient.set(m.to_agent, [m])
  }
  // localPending comes in delivery order (src/delivery-order.ts: high first,
  // then oldest first), so each list keeps that order, and the Map's insertion
  // order is the order of each recipient's first row in it: the recipients
  // holding a high row, then the rest by their oldest row (card ad771121, the window finding).
  const queues = [...perRecipient.values()]
  const window: AgentMessage[] = []
  for (let round = 0; window.length < max; round++) {
    let took = false
    for (const rows of queues) {
      if (window.length >= max) break
      if (round < rows.length) {
        window.push(rows[round])
        took = true
      }
    }
    if (!took) break
  }
  return window
}
