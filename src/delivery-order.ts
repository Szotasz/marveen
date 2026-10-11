// Card ad771121: the delivery order of pending inter-agent rows -- high priority first, then FIFO
// (created_at, with the id breaking a same-second tie). One definition for the re-sorts in db.ts and
// for the router; a pure module, so a test that mocks db.js still gets the real comparison.
//
// Card ad771121, review point 1 (#1808): a priority may only reorder PEER traffic. The in-process
// system rows and the owner's own messages (the dashboard compose, the channel coordinator's
// Telegram handoff, the voice channel) are stored as normal -- most of them never pass the POST
// route that reads `priority`, and the coordinator inserts its rows directly -- so on the stored
// value alone a peer's high row jumped ahead of a pending system notice or an owner message to the
// same recipient. Their rank is therefore read from the SENDER, at read time, wherever the order is
// decided (the SQL below and compareDeliveryOrder): they rank with high, FIFO among the high rows.
// The stored `priority` column keeps meaning what the sender asked for and was granted, so the
// per-pair high budget (countHighForPairSince) still counts only granted peer highs.
//
// With #1835 (the urgent lane), the stated precedence is: an urgent row or an authenticated STOP
// first (rank 2), then high (rank 1: a granted high, or a system/owner row), then the rest (rank 0).
// Rank 2 is `urgent = 1 OR stop_authorized = 1`: both flags are set only by an in-process writer or
// (urgent) a device key the install lists, so a sender cannot claim it. The router's busy-pane
// path additionally requires the STOP form for a stop_authorized row (isUrgentDelivery); the order
// here does not need to. An urgent row never spends the per-pair high budget (the route stores it
// with priority 0, and countHighForPairSince skips urgent rows).
import { OWNER_NAME } from './config.js'

// The channel coordinator's and the voice channel's sender ids. Kept as literals here (not
// imported from channel-coordinator/ingest.ts, which opens its own DB handle) and pinned equal to
// those constants by message-priority.test.ts.
export const COORDINATOR_SENDER_ID = 'telegram-coordinator'
export const VOICE_CHANNEL_SENDER_ID = 'hanna'

/** The stored from_agent ids whose rows rank with high whatever their stored priority: the
 *  in-process 'system' writer and the owner's own channels. Exact match on the stored id. */
export function rankedSenders(): readonly string[] {
  const owner = (OWNER_NAME ?? '').trim()
  return [...new Set(['system', COORDINATOR_SENDER_ID, VOICE_CHANNEL_SENDER_ID, ...(owner ? [owner] : [])])]
}

export interface DeliveryOrderKey {
  id: number
  created_at: number
  priority?: number | null
  from_agent?: string | null
  urgent?: number | null
  stop_authorized?: number | null
}

/** 2 = urgent or an authenticated STOP row, 1 = delivered ahead of normal rows (a granted high, or a
 *  ranked sender), 0 = normal. */
export function deliveryRank(m: Pick<DeliveryOrderKey, 'priority' | 'from_agent' | 'urgent' | 'stop_authorized'>, senders: readonly string[] = rankedSenders()): 0 | 1 | 2 {
  if (m.urgent === 1 || m.stop_authorized === 1) return 2
  if ((m.priority ?? 0) > 0) return 1
  return m.from_agent != null && senders.includes(m.from_agent) ? 1 : 0
}

/** The same rank as SQL, for ORDER BY: returns the expression and its bound parameters. */
export function deliveryRankSql(senders: readonly string[] = rankedSenders()): { sql: string; params: string[] } {
  return {
    sql: `(CASE WHEN urgent = 1 OR stop_authorized = 1 THEN 2 WHEN priority > 0 OR from_agent IN (${senders.map(() => '?').join(', ')}) THEN 1 ELSE 0 END)`,
    params: [...senders],
  }
}

export function compareDeliveryOrder(a: DeliveryOrderKey, b: DeliveryOrderKey): number {
  const senders = rankedSenders()
  return (deliveryRank(b, senders) - deliveryRank(a, senders)) || (a.created_at - b.created_at) || (a.id - b.id)
}
