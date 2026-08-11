import { describe, it, expect } from 'vitest'
import {
  normalizeContextGuardConfig,
  contextLimitForModel,
  calibrateLimit,
  CALIBRATION_OVERSHOOT_TOLERANCE,
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  READY_TIMEOUT_MS,
  SATURATION_CONFIRM_SWEEPS,
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
    paneBusy: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    // Idle-flush probes default to unmeasurable, so every pre-existing case
    // below describes an agent the idle tier cannot act on. That keeps this
    // helper's change from silently arming a new tier under the old tests.
    contextTokens: null,
    idleMs: null,
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
  it('recognizes the 1M suffix and the measured 1M families, defaults 200k', () => {
    expect(contextLimitForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    // Host-measured 1M families (2026-07-27: fable-5 hit 976k, opus-4-8
    // 985k-999k, opus-5 979k live) -- the blanket-200k guess restarted
    // working agents at ~21% real usage.
    expect(contextLimitForModel('claude-fable-5')).toBe(1_000_000)
    expect(contextLimitForModel('fable-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-mythos-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-4-8')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-4-6')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-5[1m]')).toBe(1_000_000)
    // Sonnet stays 200k: never observed above 198k on this host. Haiku 200k
    // by spec; unknown models stay conservative (calibration steps them up).
    expect(contextLimitForModel('claude-sonnet-5')).toBe(200_000)
    expect(contextLimitForModel('claude-haiku-4-5')).toBe(200_000)
    expect(contextLimitForModel('claude-opus-4-5')).toBe(200_000)
    expect(contextLimitForModel('deepseek-v4-pro')).toBe(200_000)
    expect(contextLimitForModel(null)).toBe(200_000)
  })

  it('defaults the handoff timeout to 20 minutes (6 was shorter than a working turn)', () => {
    expect(DEFAULT_CONTEXT_GUARD.handoffTimeoutMinutes).toBe(20)
  })

  it('steps the limit up when the observation disproves the base', () => {
    expect(calibrateLimit(150_000, 200_000)).toBe(200_000)
    expect(calibrateLimit(489_000, 200_000)).toBe(500_000) // tars 2026-07-09
    expect(calibrateLimit(900_000, 200_000)).toBe(1_000_000)
    expect(calibrateLimit(300_000, 1_000_000)).toBe(1_000_000)
  })

  // A full 200k window is OBSERVED slightly above 200k: the measured quantity is
  // input+cache_read+cache_creation of the last request, which overshoots the
  // nominal window. Measured 2026-07-26 across 11 saturated sessions (main agent
  // + heimdall), the largest overshoot was 213175/200000 = 1.066x. A tolerance
  // that does not cover that turns a saturated session into a "43% full" one.
  it('does NOT step up for a merely-overshooting full window (regression)', () => {
    // The exact production case: the pane showed "100% context used" while the
    // guard logged pct: 43, because the denominator had jumped to 500k.
    expect(calibrateLimit(213_175, 200_000)).toBe(200_000)
    // The whole measured saturation range must stay on the 200k denominator.
    for (const observed of [194_226, 198_544, 204_082, 207_942, 208_132, 213_175]) {
      expect(calibrateLimit(observed, 200_000)).toBe(200_000)
    }
  })

  it('keeps a saturated session ABOVE the act/hard thresholds', () => {
    // The property that actually matters: whatever the calibration decides, a
    // session at genuine exhaustion must not read below the acting thresholds.
    for (const observed of [180_000, 194_000, 204_082, 213_175]) {
      const pct = observed / calibrateLimit(observed, 200_000)
      expect(pct).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_GUARD.actPct)
    }
    expect(213_175 / calibrateLimit(213_175, 200_000))
      .toBeGreaterThanOrEqual(DEFAULT_CONTEXT_GUARD.hardPct)
  })

  it('still steps up when the observation is too big to be an overshoot', () => {
    // Counter-example, or the fix would reinstate the nonsense pct > 1 restart
    // storm the calibration was built for: tars ran at 489k on a model we would
    // have guessed 200k for -- 2.4x the base, not a 7% accounting overshoot.
    expect(calibrateLimit(489_000, 200_000)).toBe(500_000)
    expect(489_000 / calibrateLimit(489_000, 200_000)).toBeLessThanOrEqual(1)
    expect(calibrateLimit(300_000, 200_000)).toBe(500_000)
    // A genuine 1M window at 85% must not be forced down onto 500k.
    expect(calibrateLimit(850_000, 1_000_000)).toBe(1_000_000)
    expect(calibrateLimit(850_000, 200_000)).toBe(1_000_000)
  })

  it('pins the step-up boundary (documents the residual, does not hide it)', () => {
    // The tolerance is a deliberate trade, so its exact edge is pinned here.
    // Below the edge we keep the smaller denominator -- which means a window
    // that really IS a tier we did not guess reads as over-full until it grows
    // past the edge. That is the accepted cost: over-full is loud and
    // self-correcting, an inflated denominator is silent (see the regression
    // case above). No fleet model is configured onto a 500k window today.
    const edge = 200_000 * CALIBRATION_OVERSHOOT_TOLERANCE
    expect(calibrateLimit(edge, 200_000)).toBe(200_000)
    expect(calibrateLimit(edge + 1, 200_000)).toBe(500_000)
    // The edge must sit above every measured full-window overshoot ...
    expect(edge).toBeGreaterThan(213_175)
    // ... and stay well below the 200k/500k geometric midpoint, so a step-up is
    // never a coin flip between two tiers.
    expect(edge).toBeLessThan(Math.sqrt(200_000 * 500_000))
  })

  it('leaves the top tier to report pct > 1 (no tier above to step to)', () => {
    // Above the largest known tier there is nothing to calibrate to, so the
    // overshoot must surface as pct > 1 and let hardPct fire.
    expect(calibrateLimit(1_200_000, 1_000_000)).toBe(1_000_000)
    expect(1_200_000 / calibrateLimit(1_200_000, 1_000_000)).toBeGreaterThan(1)
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

  it('defers the idle-phase hard-tier restart while the agent is mid-turn', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.99, paneBusy: true, paneIdle: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
    expect(d.nextState.phase).toBe('idle')
  })

  it('skips straight to restart at hardPct', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.98 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('resets to initial state when fully disarmed (guard + net off)', () => {
    const disarmed = { ...CFG, enabled: false, saturationRestart: false }
    const stale: GuardState = { phase: 'await-handoff', handoffMtimeAtRequest: 1, deadlineMs: 2, cooldownUntilMs: 0, saturatedStreak: 0 }
    const d = decideGuard(stale, inputs({ pct: 0.99, paneSaturated: true }), disarmed)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })

  it('stands down a stale await-handoff into cooldown when the guard is disabled mid-sequence', () => {
    const netOnly = { ...CFG, enabled: false }
    const stale: GuardState = { phase: 'await-handoff', handoffMtimeAtRequest: 1, deadlineMs: 2, cooldownUntilMs: 0, saturatedStreak: 0 }
    const d = decideGuard(stale, inputs({ pct: 0.99 }), netOnly)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })
})

describe('saturation net (samu 2026-07-18 stall)', () => {
  // A saturated pane refuses prompt dispatch, so Claude Code's next-turn
  // auto-compact can never run: only an external fresh restart recovers it.
  const netOnly: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD } // enabled:false, saturationRestart:true

  it('is armed by default and survives garbage config', () => {
    expect(DEFAULT_CONTEXT_GUARD.saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig(null).saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig({ saturationRestart: 0 }).saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig({ saturationRestart: false }).saturationRestart).toBe(false)
  })

  it('restarts a saturated pane after the confirmation sweep, even with the proactive guard off and pct null', () => {
    let state = INITIAL_GUARD_STATE
    for (let sweep = 1; sweep < SATURATION_CONFIRM_SWEEPS; sweep++) {
      const d = decideGuard(state, inputs({ paneSaturated: true }), netOnly)
      expect(d.action).toBe('none')
      expect(d.nextState.saturatedStreak).toBe(sweep)
      state = d.nextState
    }
    const final = decideGuard(state, inputs({ paneSaturated: true }), netOnly)
    expect(final.action).toBe('restart')
    expect(final.reason).toContain('saturated')
    expect(final.nextState.phase).toBe('await-ready')
  })

  it('clears the streak when the pane recovers before confirmation', () => {
    const first = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true }), netOnly)
    expect(first.nextState.saturatedStreak).toBe(1)
    const second = decideGuard(first.nextState, inputs({ paneSaturated: false }), netOnly)
    expect(second.action).toBe('none')
    expect(second.nextState.saturatedStreak).toBe(0)
  })

  it('outranks the proactive tiers when both would fire (no handoff request into a dead pane)', () => {
    const state: GuardState = { ...INITIAL_GUARD_STATE, saturatedStreak: SATURATION_CONFIRM_SWEEPS - 1 }
    const d = decideGuard(state, inputs({ pct: 0.91, paneSaturated: true }), CFG)
    expect(d.action).toBe('restart')
  })

  it('restarts without debounce when saturation appears during await-handoff', () => {
    const awaiting: GuardState = {
      phase: 'await-handoff',
      handoffMtimeAtRequest: 100,
      deadlineMs: NOW + 60_000,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
    }
    const d = decideGuard(awaiting, inputs({ paneSaturated: true, paneIdle: false }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('saturated')
  })

  it('does nothing for a saturated pane when the net is explicitly disarmed', () => {
    const disarmed = { ...DEFAULT_CONTEXT_GUARD, saturationRestart: false }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true }), disarmed)
    expect(d.action).toBe('none')
  })

  it('respects cooldown after a net restart (no restart loop)', () => {
    const cooling: GuardState = {
      phase: 'cooldown',
      handoffMtimeAtRequest: null,
      deadlineMs: 0,
      cooldownUntilMs: NOW + 60_000,
      saturatedStreak: 0,
    }
    const d = decideGuard(cooling, inputs({ paneSaturated: true }), netOnly)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })

  it('does not touch a stopped agent', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true, running: false }), netOnly)
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
    saturatedStreak: 0,
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

  // 2026-07-27: the guard force-restarted samu MID-TURN twice ("pane still
  // busy" at 08:38, restart at 08:43), killing dispatched instructions with
  // the session. A restart must never cut a live turn: while the pane shows
  // a POSITIVE busy signal, both the hard tier and the timeout defer -- the
  // deadline stays in the past, so the first not-busy sweep restarts.
  it('defers the hard-threshold restart while the agent is mid-turn', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, paneBusy: true }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('defers the timeout restart while the agent is mid-turn, fires once the turn ends', () => {
    const busy = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000, paneBusy: true }), CFG)
    expect(busy.action).toBe('none')
    expect(busy.nextState.phase).toBe('await-handoff')
    // next sweep, turn over: the already-elapsed deadline fires immediately
    const idle = decideGuard(busy.nextState, inputs({ nowMs: NOW + 90_000, paneBusy: false }), CFG)
    expect(idle.action).toBe('restart')
  })

  it('saturation outranks the mid-turn deferral (a saturated pane cannot finish its turn)', () => {
    const d = decideGuard(awaiting, inputs({ paneSaturated: true, paneBusy: true }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('saturated')
  })

  it('a wedged pane (neither idle nor busy) is still restarted on timeout', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000, paneIdle: false, paneBusy: false }), CFG)
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
    saturatedStreak: 0,
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
    saturatedStreak: 0,
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

// Idle-flush tier: hand off a session that is expensive to keep re-reading but
// has stopped doing anything. Distinct from the wedge tiers in what it is FOR
// (cost, not a stalled session) and therefore in what it must never do -- the
// cost of a wrong "yes" is an agent losing the thread it was holding, so every
// condition here fails closed.
describe('decideGuard -- idle-flush tier', () => {
  // The idle tier alone: `enabled` false proves it does not lean on the
  // proactive tiers, which is how an operator who only wants the cost tier
  // would configure it.
  const IDLE_CFG: ContextGuardConfig = {
    ...DEFAULT_CONTEXT_GUARD,
    enabled: false,
    idleFlushEnabled: true,
    idleFlushTokens: 400_000,
    idleMinutes: 20,
  }
  const QUIET = 21 * 60_000     // past idleMinutes
  const HEAVY = 600_000         // past idleFlushTokens

  it('never acts while switched off, even with every condition met', () => {
    const armed = inputs({ contextTokens: HEAVY, idleMs: QUIET, paneIdle: true })
    const off: ContextGuardConfig = { ...IDLE_CFG, idleFlushEnabled: false }
    const d = decideGuard(INITIAL_GUARD_STATE, armed, off)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('idle')
    // The switch is the only difference between silence and action here.
    expect(decideGuard(INITIAL_GUARD_STATE, armed, IDLE_CFG).action).toBe('request-handoff')
  })

  it('requests a handoff when heavy, quiet and idle', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ contextTokens: HEAVY, idleMs: QUIET, paneIdle: true }), IDLE_CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.nextState.phase).toBe('await-handoff')
    // The reason has to carry both measurements: an operator reading the log
    // needs to see WHY this session was picked, not just that it was.
    expect(d.reason).toContain('600k')
    expect(d.reason).toContain('21m')
  })

  // The next two are stated as DIFFERENCES, not as bare "action is none".
  // A test that only asserts inaction passes just as well when the tier does
  // not exist at all, so it can never show that the pane condition is the
  // thing doing the blocking. Each pins the acting case beside it.
  it('does not act on a busy pane, however heavy and quiet the transcript looks', () => {
    // The case the transcript clock cannot see on its own: one long tool call
    // appends nothing for its whole duration, so idleMs says "quiet" while the
    // agent is mid-work.
    const busy = inputs({ contextTokens: HEAVY, idleMs: QUIET, paneIdle: false, paneBusy: true })
    const d = decideGuard(INITIAL_GUARD_STATE, busy, IDLE_CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('idle')
    // ... and the pane is the only reason: flip it and the same session flushes
    expect(decideGuard(INITIAL_GUARD_STATE, { ...busy, paneIdle: true, paneBusy: false }, IDLE_CFG).action)
      .toBe('request-handoff')
  })

  it('does not act on a pane that is neither idle nor busy (error banner, modal)', () => {
    // paneIdle, not !paneBusy: a parked pane may still hold state a human can
    // recover. Wedged panes are the saturation net's business, not this tier's.
    const parked = inputs({ contextTokens: HEAVY, idleMs: QUIET, paneIdle: false, paneBusy: false })
    expect(decideGuard(INITIAL_GUARD_STATE, parked, IDLE_CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, { ...parked, paneIdle: true }, IDLE_CFG).action)
      .toBe('request-handoff')
  })

  it('does not act before the quiet period has elapsed', () => {
    const d = decideGuard(
      INITIAL_GUARD_STATE,
      inputs({ contextTokens: HEAVY, idleMs: 19 * 60_000, paneIdle: true }),
      IDLE_CFG,
    )
    expect(d.action).toBe('none')
    // and it says how far off it was, so a tier that never fires is diagnosable
    expect(d.reason).toContain('19m')
    expect(d.reason).toContain('20m')
  })

  it('does not act below the token threshold', () => {
    const under = inputs({ contextTokens: 399_999, idleMs: QUIET, paneIdle: true })
    expect(decideGuard(INITIAL_GUARD_STATE, under, IDLE_CFG).action).toBe('none')
    // one token over is the whole difference
    expect(decideGuard(INITIAL_GUARD_STATE, { ...under, contextTokens: 400_000 }, IDLE_CFG).action)
      .toBe('request-handoff')
  })

  it('fails closed when either measurement is unavailable', () => {
    const ok = inputs({ contextTokens: HEAVY, idleMs: QUIET, paneIdle: true })
    expect(decideGuard(INITIAL_GUARD_STATE, { ...ok, contextTokens: null }, IDLE_CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, { ...ok, idleMs: null }, IDLE_CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, ok, IDLE_CFG).action).toBe('request-handoff')
  })

  it('does not act on an agent that is not running', () => {
    const stopped = inputs({ running: false, contextTokens: HEAVY, idleMs: QUIET, paneIdle: true })
    expect(decideGuard(INITIAL_GUARD_STATE, stopped, IDLE_CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, { ...stopped, running: true }, IDLE_CFG).action)
      .toBe('request-handoff')
  })

  it('yields to the wedge tiers when both would fire', () => {
    // A session that is both nearly full and quiet must be rescued on the
    // urgent grounds. Same action here, but the reason has to name the tier
    // that owns the decision, because the two differ in what they do next.
    const both: ContextGuardConfig = { ...IDLE_CFG, enabled: true }
    const d = decideGuard(
      INITIAL_GUARD_STATE,
      inputs({ pct: 0.95, contextTokens: HEAVY, idleMs: QUIET, paneIdle: true }),
      both,
    )
    expect(d.action).toBe('request-handoff')
    expect(d.reason).toContain('act threshold')
    expect(d.reason).not.toContain('idle-flush')
  })

  it('lets the hard tier restart rather than flushing first', () => {
    const both: ContextGuardConfig = { ...IDLE_CFG, enabled: true }
    const d = decideGuard(
      INITIAL_GUARD_STATE,
      inputs({ pct: 0.99, contextTokens: HEAVY, idleMs: QUIET, paneIdle: true }),
      both,
    )
    expect(d.action).toBe('restart')
  })

  it('sees the handoff sequence through even with the proactive tiers off', () => {
    // await-handoff used to stand down whenever `enabled` was false. With the
    // idle tier able to START a handoff on its own, that would abandon its own
    // sequence on the very next sweep and leave the session untouched forever.
    const awaiting: GuardState = {
      phase: 'await-handoff',
      handoffMtimeAtRequest: null,
      deadlineMs: NOW + 60_000,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
    }
    const d = decideGuard(awaiting, inputs({ handoffMtime: NOW, paneIdle: true }), IDLE_CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('stands down when BOTH tiers and the saturation net are off', () => {
    const allOff: ContextGuardConfig = { ...IDLE_CFG, enabled: false, idleFlushEnabled: false, saturationRestart: false }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ contextTokens: HEAVY, idleMs: QUIET }), allOff)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('disabled')
  })
})

describe('normalizeContextGuardConfig -- idle-flush fields', () => {
  it('defaults the tier OFF, so an existing store entry cannot switch it on', () => {
    // Every agent in store/context-guard.json predates these fields. Reading
    // one of those must not arm a tier that ends conversations.
    const cfg = normalizeContextGuardConfig({ enabled: true, saturationRestart: true, actPct: 0.9 })
    expect(cfg.idleFlushEnabled).toBe(false)
    expect(cfg.idleFlushTokens).toBe(400_000)
    expect(cfg.idleMinutes).toBe(20)
  })

  it('only an explicit true arms it', () => {
    expect(normalizeContextGuardConfig({ idleFlushEnabled: 'yes' }).idleFlushEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ idleFlushEnabled: 1 }).idleFlushEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ idleFlushEnabled: true }).idleFlushEnabled).toBe(true)
  })

  it('rejects a token threshold small enough to be a typo', () => {
    // 500 instead of 400_000 would flush a session that had barely started.
    expect(normalizeContextGuardConfig({ idleFlushTokens: 500 }).idleFlushTokens).toBe(400_000)
    expect(normalizeContextGuardConfig({ idleFlushTokens: -1 }).idleFlushTokens).toBe(400_000)
    expect(normalizeContextGuardConfig({ idleFlushTokens: 300_000 }).idleFlushTokens).toBe(300_000)
  })

  it('rejects a non-positive quiet period', () => {
    // 0 minutes would make "quiet" true on every sweep.
    expect(normalizeContextGuardConfig({ idleMinutes: 0 }).idleMinutes).toBe(20)
    expect(normalizeContextGuardConfig({ idleMinutes: -5 }).idleMinutes).toBe(20)
    expect(normalizeContextGuardConfig({ idleMinutes: 45 }).idleMinutes).toBe(45)
  })
})
