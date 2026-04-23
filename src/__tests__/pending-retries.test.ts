import { describe, it, expect } from 'vitest'
import {
  shouldSendAlert,
  toPendingRetryView,
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
