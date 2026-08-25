import { describe, it, expect } from 'vitest'
import {
  shouldSendAlert,
  toPendingRetryView,
  classifyTelegramSendError,
  classifySendError,
  ALERT_THRESHOLD_MS,
} from '../pending-retries.js'

describe('shouldSendAlert', () => {
  const firstAttempt = 1_000_000
  const threshold = 60 * 60 * 1000 // 1 hour

  it('returns false when no time has passed', () => {
    expect(shouldSendAlert(firstAttempt, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false while the waiting window is below the threshold', () => {
    expect(shouldSendAlert(firstAttempt + threshold / 2, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false exactly at the threshold (strict >)', () => {
    expect(shouldSendAlert(firstAttempt + threshold, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns true once the waiting window exceeds the threshold', () => {
    expect(shouldSendAlert(firstAttempt + threshold + 1, firstAttempt, null, threshold)).toBe(true)
  })

  it('returns false if an alert was already sent', () => {
    expect(
      shouldSendAlert(firstAttempt + 10 * threshold, firstAttempt, firstAttempt + threshold + 1, threshold),
    ).toBe(false)
  })

  it('uses the default threshold (1 hour) when not supplied', () => {
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_MS + 1, firstAttempt, null)).toBe(true)
    expect(shouldSendAlert(firstAttempt + ALERT_THRESHOLD_MS - 1, firstAttempt, null)).toBe(false)
  })

  it('returns false if firstAttempt is zero / non-positive (corrupt row)', () => {
    expect(shouldSendAlert(Date.now(), 0, null, threshold)).toBe(false)
    expect(shouldSendAlert(Date.now(), -1, null, threshold)).toBe(false)
  })

  it('returns false if now < firstAttempt (clock skew or bad input)', () => {
    expect(shouldSendAlert(firstAttempt - 1000, firstAttempt, null, threshold)).toBe(false)
  })

  it('returns false on non-finite inputs', () => {
    expect(shouldSendAlert(NaN, firstAttempt, null, threshold)).toBe(false)
    expect(shouldSendAlert(firstAttempt + threshold + 1, NaN, null, threshold)).toBe(false)
  })
})

describe('toPendingRetryView', () => {
  const baseRow = {
    id: 42,
    task_name: 'morning-summary',
    agent_name: 'main',
    first_attempt: 1_000_000,
    last_attempt: 1_000_500,
    attempt_count: 5,
    last_reason: 'busy',
    alert_sent_at: null as number | null,
  }

  it('maps snake_case DB fields to camelCase UI view', () => {
    const view = toPendingRetryView(baseRow, 1_001_000)
    expect(view).toMatchObject({
      id: 42,
      taskName: 'morning-summary',
      agentName: 'main',
      firstAttempt: 1_000_000,
      lastAttempt: 1_000_500,
      attemptCount: 5,
      lastReason: 'busy',
      alertSentAt: null,
    })
  })

  it('derives ageMs as now - firstAttempt, clamped at zero', () => {
    expect(toPendingRetryView(baseRow, 1_000_000 + 12345).ageMs).toBe(12345)
    // Negative age (clock skew): clamp to 0
    expect(toPendingRetryView(baseRow, 999_000).ageMs).toBe(0)
  })

  it('sets alertDue=true once past the threshold and no alert yet', () => {
    const view = toPendingRetryView(baseRow, 1_000_000 + ALERT_THRESHOLD_MS + 1)
    expect(view.alertDue).toBe(true)
  })

  it('sets alertDue=false if an alert was already sent', () => {
    const view = toPendingRetryView(
      { ...baseRow, alert_sent_at: 1_000_000 + ALERT_THRESHOLD_MS + 100 },
      1_000_000 + 2 * ALERT_THRESHOLD_MS,
    )
    expect(view.alertDue).toBe(false)
  })

  it('honors a custom threshold', () => {
    const view = toPendingRetryView(baseRow, 1_000_100, 50)
    expect(view.alertDue).toBe(true)
    const viewUnder = toPendingRetryView(baseRow, 1_000_100, 200)
    expect(viewUnder.alertDue).toBe(false)
  })
})

describe('classifyTelegramSendError', () => {
  it('treats a bare network error (no HTTP status) as transient', () => {
    expect(classifyTelegramSendError('fetch failed')).toBe('transient')
    expect(classifyTelegramSendError('TypeError: fetch failed')).toBe('transient')
  })

  it('treats 429 (rate limited) as transient', () => {
    expect(classifyTelegramSendError('Telegram API 429: Too Many Requests')).toBe('transient')
  })

  it('treats 5xx as transient', () => {
    expect(classifyTelegramSendError('Telegram API 500: Internal Server Error')).toBe('transient')
    expect(classifyTelegramSendError('Telegram API 502: Bad Gateway')).toBe('transient')
  })

  it('treats 400 (bad chat_id) as permanent', () => {
    expect(classifyTelegramSendError('Telegram API 400: Bad Request: chat not found')).toBe('permanent')
  })

  it('treats 401/403/404 (bad or blocked token) as permanent', () => {
    expect(classifyTelegramSendError('Telegram API 401: Unauthorized')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 403: Forbidden: bot was blocked by the user')).toBe('permanent')
    expect(classifyTelegramSendError('Telegram API 404: Not Found')).toBe('permanent')
  })
})

// SLACKAWARE: the scheduler alerts now go over whatever channel the main agent
// is bound to, so the classifier must recognise Slack's two error shapes too.
// classifyTelegramSendError is a backward-compatible alias of classifySendError.
describe('classifySendError (Slack shapes)', () => {
  it('is the same function as the legacy classifyTelegramSendError alias', () => {
    expect(classifySendError).toBe(classifyTelegramSendError)
  })

  it('treats Slack HTTP 429/5xx as transient, other 4xx as permanent', () => {
    expect(classifySendError('Slack API HTTP 429')).toBe('transient')
    expect(classifySendError('Slack API HTTP 503')).toBe('transient')
    expect(classifySendError('Slack API HTTP 400')).toBe('permanent')
    expect(classifySendError('Slack API HTTP 403')).toBe('permanent')
  })

  it('treats Slack rate-limit / server error codes as transient', () => {
    expect(classifySendError('Slack API error: ratelimited')).toBe('transient')
    expect(classifySendError('Slack API error: rate_limited')).toBe('transient')
    expect(classifySendError('Slack API error: internal_error')).toBe('transient')
    expect(classifySendError('Slack API error: service_unavailable')).toBe('transient')
  })

  it('treats Slack config error codes as permanent (no 60s spin)', () => {
    expect(classifySendError('Slack API error: channel_not_found')).toBe('permanent')
    expect(classifySendError('Slack API error: not_in_channel')).toBe('permanent')
    expect(classifySendError('Slack API error: invalid_auth')).toBe('permanent')
    expect(classifySendError('Slack API error: token_revoked')).toBe('permanent')
    expect(classifySendError('Slack API error: is_archived')).toBe('permanent')
  })

  it('treats a bare Slack network failure (no status/code) as transient', () => {
    expect(classifySendError('fetch failed')).toBe('transient')
  })
})

// Discord is a valid CHANNEL_PROVIDER for the alert path too (channelDeliveryName,
// resolveSchedulerAlertToken). discordProvider.sendMessage throws
// "Discord API <status>: <body>"; without its own branch every 4xx fell
// through the "no recognized prefix" default as transient and respun each tick.
describe('classifySendError (Discord shapes)', () => {
  it('treats Discord HTTP 429/5xx as transient, other 4xx as permanent', () => {
    expect(classifySendError('Discord API 429: rate limited')).toBe('transient')
    expect(classifySendError('Discord API 502: bad gateway')).toBe('transient')
    expect(classifySendError('Discord API 401: {"message":"401: Unauthorized"}')).toBe('permanent')
    expect(classifySendError('Discord API 403: {"message":"Missing Access"}')).toBe('permanent')
    expect(classifySendError('Discord API 404: {"message":"Unknown Channel"}')).toBe('permanent')
  })

  it('does not confuse a status-looking number inside the body with the status', () => {
    // The status is the number right after the prefix; the body may carry
    // its own codes (Discord echoes "401: Unauthorized" in the JSON).
    expect(classifySendError('Discord API 503: {"code":40001}')).toBe('transient')
  })
})
