import { describe, it, expect } from 'vitest'
import {
  normalizeContextGuardConfig,
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  MAX_GUARD_MINUTES,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'

// Every minutes field ends up in a millisecond deadline (nowMs + m * 60_000).
// Number.isFinite(1e308) is true, but 1e308 * 60_000 is Infinity, and an
// infinite deadline is never reached by `nowMs >= deadlineMs`: the phase would
// never time out and the guard would sit in it for good, with nothing in the
// log. The normalizer caps the value, so the deadline stays a real number.

const NOW = 1_000_000_000
// The largest millisecond timestamp a JS Date can hold.
const MAX_DATE_MS = 8.64e15

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    dailyHandoffDue: false,
    contextTokens: null,
    idleMs: null,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}

const HUGE = { enabled: true, cooldownMinutes: 1e308, handoffTimeoutMinutes: 1e308, idleMinutes: 1e308 }

describe('context-guard minutes cap', () => {
  it('caps a finite but overflowing minutes value in every minutes field', () => {
    const cfg = normalizeContextGuardConfig(HUGE)
    expect(cfg.cooldownMinutes).toBe(MAX_GUARD_MINUTES)
    expect(cfg.handoffTimeoutMinutes).toBe(MAX_GUARD_MINUTES)
    expect(cfg.idleMinutes).toBe(MAX_GUARD_MINUTES)
  })

  it('leaves ordinary values alone', () => {
    const cfg = normalizeContextGuardConfig({ cooldownMinutes: 15, handoffTimeoutMinutes: 0.5, idleMinutes: 20 })
    expect(cfg.cooldownMinutes).toBe(15)
    expect(cfg.handoffTimeoutMinutes).toBe(0.5)
    expect(cfg.idleMinutes).toBe(20)
    expect(normalizeContextGuardConfig({ handoffTimeoutMinutes: MAX_GUARD_MINUTES }).handoffTimeoutMinutes).toBe(MAX_GUARD_MINUTES)
  })

  it('keeps a date plus two capped durations a safe integer', () => {
    expect(Number.isSafeInteger(MAX_DATE_MS + 2 * MAX_GUARD_MINUTES * 60_000)).toBe(true)
    // and the cap is far beyond any real setting (more than a thousand years)
    expect(MAX_GUARD_MINUTES).toBeGreaterThan(1000 * 365 * 24 * 60)
  })

  it('a handoff request gets a finite deadline', () => {
    const cfg = normalizeContextGuardConfig(HUGE)
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: cfg.actPct }), cfg)
    expect(d.action).toBe('request-handoff')
    expect(Number.isSafeInteger(d.nextState.deadlineMs)).toBe(true)
  })

  it('the cooldown after a resume gets a finite end', () => {
    const cfg = normalizeContextGuardConfig(HUGE)
    const awaitingReady: GuardState = {
      phase: 'await-ready',
      handoffMtimeAtRequest: null,
      deadlineMs: NOW + 60_000,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
      staleRefreshCount: 0,
      handoffStaleMinutes: null,
    }
    const d = decideGuard(awaitingReady, inputs({ sessionReady: true }), cfg)
    expect(d.action).toBe('inject-resume')
    expect(Number.isSafeInteger(d.nextState.cooldownUntilMs)).toBe(true)
  })

  it('the default config is unaffected', () => {
    expect(normalizeContextGuardConfig({})).toEqual(DEFAULT_CONTEXT_GUARD)
  })
})
