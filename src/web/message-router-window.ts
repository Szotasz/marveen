import type { AgentMessage } from '../db.js'

/** The prefix that marks a STOP row (card 795d1f48). */
export const STOP_PREFIX = '[STOP]'

/**
 * Card 71263d15 (C), 795d1f48: a STOP row must reach a BUSY agent now, not at the end
 * of its turn: on 2026-09-17 an owner's stop sat pending for 30 minutes behind a turn
 * that then sent the mail it was meant to stop. Only the main agent and the system may
 * send one; any other sender's "[STOP]" is an ordinary message.
 */
export function isStopMessage(m: Pick<AgentMessage, 'from_agent' | 'content'>, mainAgentId: string): boolean {
  if (m.from_agent !== mainAgentId && m.from_agent !== 'system') return false
  return (m.content ?? '').trimStart().startsWith(STOP_PREFIX)
}

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
 * next row of every recipient, recipients ordered by their oldest pending row,
 * until `max` rows. So every recipient with a pending row is evaluated every
 * tick (up to `max` recipients), a lone recipient still gets up to `max` rows
 * (the serial path delivers exactly as before), and each recipient's rows keep
 * their order, which the batch-mate collection relies on (it looks AFTER the
 * head row).
 *
 * The main agent's rows are left out: it drains its own inbox (pull model) and
 * the tick skips its rows anyway, so in the window they only took a slot.
 *
 * Card 71263d15 (C): STOP rows come first, whatever their recipient's backlog. The
 * round-robin takes each recipient's rows oldest first, so the newest row of a
 * recipient with a deep queue did not reach the window at all, and a STOP is always
 * the newest row.
 */
export function selectTickWindow(
  localPending: readonly AgentMessage[],
  max: number,
  mainAgentId: string,
): AgentMessage[] {
  const stops = localPending
    .filter((m) => m.to_agent !== mainAgentId && isStopMessage(m, mainAgentId))
    .slice(0, max)
  const stopIds = new Set(stops.map((m) => m.id))
  const perRecipient = new Map<string, AgentMessage[]>()
  for (const m of localPending) {
    if (m.to_agent === mainAgentId || stopIds.has(m.id)) continue
    const rows = perRecipient.get(m.to_agent)
    if (rows) rows.push(m)
    else perRecipient.set(m.to_agent, [m])
  }
  // localPending comes oldest-first, so each list keeps that order, and the
  // Map's insertion order is the order of each recipient's oldest row.
  const queues = [...perRecipient.values()]
  const window: AgentMessage[] = [...stops]
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
