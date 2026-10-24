// Card ad771121: the delivery order of pending inter-agent rows -- by class (below), then FIFO
// (created_at, with the id breaking a same-second tie). One definition for the re-sorts in db.ts and
// for the router; a pure module, so a test that mocks db.js still gets the real comparison.
//
// Card ad771121, review point 1 (#1808): a priority may only reorder PEER traffic. The in-process
// system rows and the owner's own messages (the dashboard compose, the channel coordinator's
// Telegram handoff, the voice channel) are stored as normal -- most of them never pass the POST
// route that reads `priority`, and the coordinator inserts its rows directly -- so on the stored
// value alone a peer's high row jumped ahead of a pending system notice or an owner message to the
// same recipient. Their rank is therefore read from the SENDER, at read time, wherever the order is
// decided (the SQL below and compareDeliveryOrder), and it sits above a peer high.
// The stored `priority` column keeps meaning what the sender asked for and was granted, so the
// per-pair high budget (countHighForPairSince) still counts only granted peer highs.
//
// The precedence on one queue (#1808 with #1809 and #1835, as the review stated it), FIFO
// (created_at, then id) inside each class:
//   4  an authenticated STOP row (stop_authorized = 1)
//   3  an urgent row (urgent = 1)
//   2  a row from the system or the owner (rankedSenders), whatever it stored
//   1  a granted peer high (priority > 0)
//   0  the rest
// Ranks 4 and 3 are flags only an in-process writer or (urgent) a device key the install lists can
// set, so a sender cannot claim them; rank 2 is keyed on the stored from_agent. A device key's
// "[STOP]" rides on the urgent flag, not stop_authorized (message-router-window.ts isStopMessage), so
// it ranks 3 here; the router's busy-pane path treats it as a STOP all the same. An urgent row never
// spends the per-pair high budget (the route stores it with priority 0, and countHighForPairSince
// skips urgent rows).
import { OWNER_NAME, VOICE_CHANNEL_ID } from './config.js'

// The channel coordinator's and the voice channel's sender ids. Not imported from
// channel-coordinator/ingest.ts, which opens its own DB handle: the coordinator id is a literal,
// and the voice channel id comes from config.ts (configurable, VOICECHANNELID1022), where ingest.ts
// reads it too; null when the voice lane is off. It is read at CALL time, like OWNER_NAME below:
// db.ts imports this module, and the many tests that mock config.js without the voice id must
// still load db.ts. message-priority.test.ts pins both equal to the ingest.ts constants.
export const COORDINATOR_SENDER_ID = 'telegram-coordinator'
export function voiceChannelSenderId(): string | null {
  return VOICE_CHANNEL_ID
}

/** The stored from_agent ids whose rows rank above a peer high whatever their stored priority: the
 *  in-process 'system' writer and the owner's own channels. Exact match on the stored id. */
export function rankedSenders(): readonly string[] {
  const owner = (OWNER_NAME ?? '').trim()
  const voiceId = voiceChannelSenderId()
  const voice = voiceId === null ? [] : [voiceId]
  return [...new Set(['system', COORDINATOR_SENDER_ID, ...voice, ...(owner ? [owner] : [])])]
}

export interface DeliveryOrderKey {
  id: number
  created_at: number
  priority?: number | null
  from_agent?: string | null
  urgent?: number | null
  stop_authorized?: number | null
}

export type DeliveryRank = 0 | 1 | 2 | 3 | 4

/** The class of a pending row, higher first (see the precedence above): 4 = authenticated STOP,
 *  3 = urgent, 2 = system or owner, 1 = granted peer high, 0 = normal. */
export function deliveryRank(m: Pick<DeliveryOrderKey, 'priority' | 'from_agent' | 'urgent' | 'stop_authorized'>, senders: readonly string[] = rankedSenders()): DeliveryRank {
  if (m.stop_authorized === 1) return 4
  if (m.urgent === 1) return 3
  if (m.from_agent != null && senders.includes(m.from_agent)) return 2
  return (m.priority ?? 0) > 0 ? 1 : 0
}

/** The same rank as SQL, for ORDER BY: returns the expression and its bound parameters. */
export function deliveryRankSql(senders: readonly string[] = rankedSenders()): { sql: string; params: string[] } {
  return {
    sql: `(CASE WHEN stop_authorized = 1 THEN 4 WHEN urgent = 1 THEN 3 WHEN from_agent IN (${senders.map(() => '?').join(', ')}) THEN 2 WHEN priority > 0 THEN 1 ELSE 0 END)`,
    params: [...senders],
  }
}

export function compareDeliveryOrder(a: DeliveryOrderKey, b: DeliveryOrderKey): number {
  const senders = rankedSenders()
  return (deliveryRank(b, senders) - deliveryRank(a, senders)) || (a.created_at - b.created_at) || (a.id - b.id)
}
