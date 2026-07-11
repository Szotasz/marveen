import { describe, it, expect } from 'vitest'
import {
  normalizeContextGuardConfig,
  contextLimitForModel,
  calibrateLimit,
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  READY_TIMEOUT_MS,
  type ContextGuardConfig,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'

// The guard is default-off (opt-in); these behavioural cases exercise an
// explicitly-enabled guard.
const CFG: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
const NOW = 1_000_000_000

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    sessionReady: false,
    handoffMtime: null,
    ...overrides,
  }
}

describe('normalizeContextGuardConfig', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeContextGuardConfig(null)).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(normalizeContextGuardConfig('nope')).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(normalizeContextGuardConfig({ actPct: 'high' })).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('is default-off (opt-in): only an explicit true enables', () => {
    expect(normalizeContextGuardConfig({}).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: 0 }).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: true }).enabled).toBe(true)
  })

  it('clamps hardPct to at least actPct', () => {
    const cfg = normalizeContextGuardConfig({ actPct: 0.9, hardPct: 0.5 })
    expect(cfg.hardPct).toBe(0.9)
  })

  it('rejects out-of-range pcts and tiny limits', () => {
    expect(normalizeContextGuardConfig({ actPct: 1.5 }).actPct).toBe(0.9)
    expect(normalizeContextGuardConfig({ actPct: 0 }).actPct).toBe(0.9)
    expect(normalizeContextGuardConfig({ limitTokens: 500 }).limitTokens).toBeNull()
    expect(normalizeContextGuardConfig({ limitTokens: 500_000 }).limitTokens).toBe(500_000)
  })
})

describe('contextLimitForModel / calibrateLimit', () => {
  it('recognizes the 1M suffix, defaults 200k', () => {
    expect(contextLimitForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextLimitForModel('claude-fable-5')).toBe(200_000)
    expect(contextLimitForModel(null)).toBe(200_000)
  })

  it('steps the limit up when the observation disproves the base', () => {
    expect(calibrateLimit(150_000, 200_000)).toBe(200_000)
    expect(calibrateLimit(489_000, 200_000)).toBe(500_000) // tars 2026-07-09
    expect(calibrateLimit(900_000, 200_000)).toBe(1_000_000)
    expect(calibrateLimit(300_000, 1_000_000)).toBe(1_000_000)
  })
})

describe('decideGuard: idle', () => {
  it('does nothing below threshold / when unmeasurable / not running', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.5 }), CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: null }), CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.99, running: false }), CFG).action).toBe('none')
  })

  it('requests a handoff at actPct and records the deadline + prior mtime', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.91, handoffMtime: 123 }), CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.nextState.phase).toBe('await-handoff')
    expect(d.nextState.handoffMtimeAtRequest).toBe(123)
    expect(d.nextState.deadlineMs).toBe(NOW + CFG.handoffTimeoutMinutes * 60_000)
  })

  it('skips straight to restart at hardPct', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.98 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('resets to initial state when disabled', () => {
    const disabled = { ...CFG, enabled: false }
    const stale: GuardState = { phase: 'await-handoff', handoffMtimeAtRequest: 1, deadlineMs: 2, cooldownUntilMs: 0 }
    const d = decideGuard(stale, inputs({ pct: 0.99 }), disabled)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })
})

describe('decideGuard: await-handoff', () => {
  const awaiting: GuardState = {
    phase: 'await-handoff',
    handoffMtimeAtRequest: 100,
    deadlineMs: NOW + 60_000,
    cooldownUntilMs: 0,
  }

  it('restarts once the handoff is written and the pane is idle', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 200, paneIdle: true }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
    expect(d.nextState.deadlineMs).toBe(NOW + READY_TIMEOUT_MS)
  })

  it('waits while the agent is still writing (busy pane)', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 200, paneIdle: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('treats a first-ever handoff file as written (prior mtime null)', () => {
    const state = { ...awaiting, handoffMtimeAtRequest: null }
    const d = decideGuard(state, inputs({ handoffMtime: 5, paneIdle: true }), CFG)
    expect(d.action).toBe('restart')
  })

  it('ignores a stale handoff file (mtime not advanced)', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 100, paneIdle: true }), CFG)
    expect(d.action).toBe('none')
  })

  it('force-restarts on deadline even without a handoff', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('timeout')
  })

  it('force-restarts at hardPct even without a handoff', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, paneIdle: false }), CFG)
    expect(d.action).toBe('restart')
  })

  it('stands down into cooldown if the agent was restarted externally', () => {
    const d = decideGuard(awaiting, inputs({ running: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
    expect(d.nextState.cooldownUntilMs).toBe(NOW + CFG.cooldownMinutes * 60_000)
  })
})

describe('decideGuard: await-ready', () => {
  const awaitingReady: GuardState = {
    phase: 'await-ready',
    handoffMtimeAtRequest: null,
    deadlineMs: NOW + 60_000,
    cooldownUntilMs: 0,
  }

  it('injects the resume prompt when the session is ready, then cools down', () => {
    const d = decideGuard(awaitingReady, inputs({ sessionReady: true }), CFG)
    expect(d.action).toBe('inject-resume')
    expect(d.nextState.phase).toBe('cooldown')
    expect(d.nextState.cooldownUntilMs).toBe(NOW + CFG.cooldownMinutes * 60_000)
  })

  it('waits while the session boots', () => {
    const d = decideGuard(awaitingReady, inputs({ running: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('gives up into cooldown on ready-timeout', () => {
    const d = decideGuard(awaitingReady, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })
})

describe('decideGuard: cooldown', () => {
  const cooling: GuardState = {
    phase: 'cooldown',
    handoffMtimeAtRequest: null,
    deadlineMs: 0,
    cooldownUntilMs: NOW + 60_000,
  }

  it('suppresses everything during cooldown, even a huge pct', () => {
    const d = decideGuard(cooling, inputs({ pct: 1.2 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })

  it('re-arms after cooldown', () => {
    const d = decideGuard(cooling, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })
})
