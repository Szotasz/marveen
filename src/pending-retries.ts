// Pure-logic helpers for the persistent scheduled-task retry queue.
//
// The scheduler used to keep busy-skipped tasks in an in-memory Map and
// abandon them after 15-60 minutes, silently. That failure mode is fatal
// for business-critical schedules (a morning summary that never arrives
// is only noticed hours later). The replacement policy is:
//
//   1. Every busy retry is upserted into `pending_task_retries` (persists
//      across dashboard restarts, so nothing is dropped).
//   2. On every tick, the scheduler tries to fire every pending row. On
//      success, the row is deleted; on continued busy, attempt_count ++.
//   3. If a row has been waiting longer than `ALERT_THRESHOLD_MS` and
//      `alert_sent_at` is null, the alerting layer stamps the row BEFORE
//      sending the Telegram message (so concurrent ticks do not
//      double-alert) and clears the stamp if the send fails (so the next
//      tick can retry). Net guarantee: one stamp per delivery attempt,
//      at-least-once delivery until success. The scheduled task itself
//      keeps retrying forever -- we do NOT abandon.
//
// This module contains the decision logic only; the I/O (DB + Telegram)
// lives in src/web.ts alongside the rest of the scheduler, but is wrapped
// behind small pure functions here so the "should we alert" decision can
// be unit-tested without a DB and without an HTTP mock.

/**
 * How long a busy-skipped scheduled task can wait before we escalate the
 * operator via Telegram. The retry itself continues forever: this is the
 * alerting threshold, not an abandon threshold.
 */
export const ALERT_THRESHOLD_MS = 60 * 60 * 1000

/**
 * Decide whether the alerting layer should fire a Telegram notification
 * for a pending retry row.
 *
 * Returns true only when:
 *   - the row has been waiting longer than `thresholdMs`, AND
 *   - no alert is currently stamped (`alertSentAt` is null).
 *
 * Callers are responsible for stamping `alert_sent_at` before the Telegram
 * send (race guard against concurrent ticks) and clearing it on delivery
 * failure so the next tick can retry.
 */
export function shouldSendAlert(
  now: number,
  firstAttempt: number,
  alertSentAt: number | null,
  thresholdMs: number = ALERT_THRESHOLD_MS,
): boolean {
  if (alertSentAt != null) return false
  if (!Number.isFinite(firstAttempt) || firstAttempt <= 0) return false
  if (!Number.isFinite(now) || now < firstAttempt) return false
  return now - firstAttempt > thresholdMs
}

/**
 * Shape of a pending retry used by the UI + the alert layer. A small
 * subset of the DB row, decoupled from the DB type so tests don't need
 * better-sqlite3.
 */
export interface PendingRetryView {
  id: number
  taskName: string
  agentName: string
  firstAttempt: number
  lastAttempt: number
  attemptCount: number
  lastReason: string | null
  alertSentAt: number | null
  ageMs: number
  alertDue: boolean
}

/**
 * Project a raw DB row into the UI view, including the derived `ageMs`
 * (for display) and `alertDue` (= shouldSendAlert). Keeping the derivation
 * here means the UI never has to carry the alert policy.
 */
export function toPendingRetryView(
  row: {
    id: number
    task_name: string
    agent_name: string
    first_attempt: number
    last_attempt: number
    attempt_count: number
    last_reason: string | null
    alert_sent_at: number | null
  },
  now: number,
  thresholdMs: number = ALERT_THRESHOLD_MS,
): PendingRetryView {
  return {
    id: row.id,
    taskName: row.task_name,
    agentName: row.agent_name,
    firstAttempt: row.first_attempt,
    lastAttempt: row.last_attempt,
    attemptCount: row.attempt_count,
    lastReason: row.last_reason,
    alertSentAt: row.alert_sent_at,
    ageMs: Math.max(0, now - row.first_attempt),
    alertDue: shouldSendAlert(now, row.first_attempt, row.alert_sent_at, thresholdMs),
  }
}
