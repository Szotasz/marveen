// Card ad771121: delivery priority on POST /api/messages. The order itself lives in the DB queries
// (src/delivery-order.ts); this module only reads the request field and applies the per-pair high budget.
// The sender's view of the queue is the existing `queue` answer (getRecipientQueueState, #1674).
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import { countHighForPairSince } from '../db.js'

export type PriorityLevel = 'normal' | 'high'

/** Parse the optional `priority` field. ABSENT (undefined or null) means "normal": today's FIFO, which
 *  is what every existing caller gets. Only "normal" and "high" are accepted; anything else ("urgent",
 *  "HIGH", a number, an empty string) is an error the route answers with 400, never a silent normal. */
export function parsePriorityField(v: unknown): { ok: true; level: PriorityLevel } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, level: 'normal' }
  if (v === 'normal' || v === 'high') return { ok: true, level: v }
  return { ok: false, error: `invalid priority ${JSON.stringify(v)} -- use "high" or "normal"; absent means "normal" (FIFO)` }
}

// K3 (card decision): one sender gets at most this many HIGH rows accepted per rolling hour FOR ONE
// RECIPIENT; above it the row is accepted as NORMAL (never dropped) and the answer says downgraded: true.
// Keyed by the (sender, recipient) pair, since a priority reorders that recipient's queue: a sender
// that warns twenty recipients at once gets twenty high rows, one per queue.
// One effect reaches past that queue (card ad771121, the window finding, kept on purpose): the router's tick window
// (selectTickWindow) takes the recipients in the order of their first row in delivery order, so when
// more recipients wait than the window holds (MAX_MESSAGES_PER_TICK, 25), a recipient holding a high
// row enters the window first; if it would not have fit by age, the recipient that came last by age stays
// out in its place, for as long as that high row is pending. When the window holds every recipient, every
// recipient is in every window either way.
export const HIGH_PRIORITY_PER_HOUR_DEFAULT = 5

// The same lookup as batch-inject's rollout flags: the process environment first, then the .env file,
// read fresh on each call, so a changed value takes effect without a restart.
function envValue(key: string): string | undefined {
  const fromProcess = process.env[key]
  if (fromProcess !== undefined && fromProcess.trim() !== '') return fromProcess
  return readEnvFile([key])[key]
}

/** MESSAGE_HIGH_PRIORITY_PER_HOUR: a whole number >= 0 (0 downgrades every high). An unparsable value
 *  falls back to the default and says so in the log. */
export function highPriorityBudgetPerHour(raw: string | undefined = envValue('MESSAGE_HIGH_PRIORITY_PER_HOUR')): number {
  if (raw === undefined || raw.trim() === '') return HIGH_PRIORITY_PER_HOUR_DEFAULT
  const n = Number(raw.trim())
  if (Number.isInteger(n) && n >= 0) return n
  logger.warn({ value: raw }, `MESSAGE_HIGH_PRIORITY_PER_HOUR is not a whole number >= 0; using ${HIGH_PRIORITY_PER_HOUR_DEFAULT}`)
  return HIGH_PRIORITY_PER_HOUR_DEFAULT
}

/** The stored priority for a requested level: high only while the pair's accepted highs in the last
 *  hour are under the budget. Synchronous on purpose: the route calls it right before the insert with
 *  no await in between, so two requests of one pair cannot both slip under the budget. */
export function decidePriority(
  level: PriorityLevel,
  from: string,
  to: string,
  nowSec: number,
  budget: number = highPriorityBudgetPerHour(),
): { priority: 0 | 1; downgraded: boolean } {
  if (level !== 'high') return { priority: 0, downgraded: false }
  if (countHighForPairSince(from, to, nowSec - 3600) < budget) return { priority: 1, downgraded: false }
  return { priority: 0, downgraded: true }
}
