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
 * Classify a channel send failure as transient (worth retrying) or
 * permanent (a config / client error that will fail identically every
 * tick). Provider-agnostic entry point: the scheduler alert path sends over
 * whatever channel the main agent is bound to (Telegram or Slack), so this
 * dispatches on the provider prefix to a per-provider classifier below.
 *
 * Telegram (channel-provider telegramProvider / sendTelegramMessage) throws
 * `Error("Telegram API <status>: ...")` on a non-2xx response. Slack
 * (slackProvider.sendMessage) throws `Error("Slack API HTTP <status>")` on a
 * transport-level non-2xx and `Error("Slack API error: <code>")` when the
 * API returns `ok:false`. A bare network error (TypeError "fetch failed")
 * carries no status on either provider.
 *
 *   - transient: network failure (no status), HTTP 429 (rate limited),
 *     any 5xx, or a Slack `ratelimited`/`internal_error`-class code. The
 *     next tick should retry, so the caller clears the per-attempt stamp.
 *   - permanent: HTTP 4xx other than 429 (400 bad chat_id, 401/404 bad
 *     token, 403 blocked), or a Slack config code (channel_not_found,
 *     invalid_auth, token_revoked, not_in_channel, ...). Retrying every
 *     tick just spams the log with the identical failure, so the caller
 *     KEEPS the stamp until the underlying config is fixed.
 *
 * Pure (takes the error message string) so it is unit-testable without a
 * live endpoint.
 */
export function classifySendError(errMessage: string): 'transient' | 'permanent' {
  if (errMessage.includes('Telegram API')) return classifyTelegramError(errMessage)
  if (errMessage.includes('Slack API')) return classifySlackError(errMessage)
  if (errMessage.includes('Discord API')) return classifyDiscordError(errMessage)
  return 'transient' // no recognized provider prefix -> network-level failure
}

/** Shared HTTP-status policy: 429 and 5xx retry, other 4xx is config. */
function classifyHttpStatus(status: number): 'transient' | 'permanent' {
  if (status === 429 || status >= 500) return 'transient'
  if (status >= 400) return 'permanent'
  return 'transient'
}

/** Telegram: "Telegram API <status>: ...". */
function classifyTelegramError(errMessage: string): 'transient' | 'permanent' {
  const match = /Telegram API (\d{3})\b/.exec(errMessage)
  return match ? classifyHttpStatus(Number(match[1])) : 'transient'
}

/** Discord (discordProvider.sendMessage): "Discord API <status>: <body>".
 *  Same HTTP-status policy -- without this branch a bad channel id / revoked
 *  bot token (4xx) fell through as "transient" and respun every 60s. */
function classifyDiscordError(errMessage: string): 'transient' | 'permanent' {
  const match = /Discord API (\d{3})\b/.exec(errMessage)
  return match ? classifyHttpStatus(Number(match[1])) : 'transient'
}

/**
 * Slack application-level error codes that are worth retrying; everything
 * else (bad channel/token/scope) is a config error that will fail
 * identically next tick.
 */
const SLACK_TRANSIENT_CODES = new Set([
  'ratelimited', 'rate_limited', 'internal_error', 'service_unavailable',
  'fatal_error', 'request_timeout', 'timeout',
])

/**
 * Slack: "Slack API HTTP <status>" (transport-level non-2xx) or
 * "Slack API error: <code>" (API returned ok:false).
 */
function classifySlackError(errMessage: string): 'transient' | 'permanent' {
  const httpStatus = /Slack API HTTP (\d{3})\b/.exec(errMessage)
  if (httpStatus) return classifyHttpStatus(Number(httpStatus[1]))
  const code = /Slack API error:\s*([a-z_]+)/i.exec(errMessage)
  if (code) return SLACK_TRANSIENT_CODES.has(code[1].toLowerCase()) ? 'transient' : 'permanent'
  return 'transient'
}

/**
 * Backward-compatible alias. The classifier is provider-agnostic now
 * (see classifySendError); the old name is kept so existing call sites and
 * tests continue to resolve.
 */
export const classifyTelegramSendError = classifySendError

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
