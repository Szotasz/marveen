// The context-guard's DAILY-HANDOFF tier.
//
// The gap it closes: a nightly fresh restart drops whatever context the session
// was holding, because nothing on the auto-restart path writes a HANDOFF.md --
// while a context-driven guard restart always does. The fix is a fourth trigger
// on the EXISTING guard rather than a handoff flag on the auto-restart config
// -- one owner for HANDOFF.md, one state machine, one timeout.
//
// Two failure branches are exercised on purpose, because the handoff path is
// mostly error handling and error handling is where the bugs outlive everyone:
//   - the handoff never arrives (must still restart, and say it went without one)
//   - the tier is the ONLY one armed (must not be short-circuited as "disabled")
import { describe, it, expect } from 'vitest'
import {
  decideGuard,
  normalizeContextGuardConfig,
  dailyHandoffArmed,
  dailyHandoffDue,
  dailyHandoffStep,
  dailyHandoffSweep,
  DAILY_HANDOFF_REASON_PREFIX,
  IDLE_FLUSH_REASON_PREFIX,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  type ContextGuardConfig,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'
import { dailyHandoffPrompt } from '../web/context-guard-runner.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

const NOW = new Date('2026-09-10T09:00:00').getTime()
const MIDNIGHT = new Date('2026-09-10T00:00:00').getTime()

/** Only the daily tier armed: the configuration this feature actually ships in. */
const DAILY_ONLY: ContextGuardConfig = {
  ...DEFAULT_CONTEXT_GUARD,
  enabled: false,
  saturationRestart: false,
  idleFlushEnabled: false,
  dailyHandoffEnabled: true,
  dailyHandoffTime: '04:00',
}

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
    contextTokens: null,
    idleMs: null,
    dailyHandoffDue: false,
    ...overrides,
  }
}

describe('dailyHandoffArmed -- the single predicate both sides read', () => {
  it('is armed only when enabled AND the time parses', () => {
    expect(dailyHandoffArmed(DAILY_ONLY)).toBe(true)
    expect(dailyHandoffArmed({ ...DAILY_ONLY, dailyHandoffEnabled: false })).toBe(false)
  })

  // The trap this predicate exists for: the auto-restart runner stands aside
  // for an ARMED tier. If "enabled with no time" counted as armed, the nightly
  // restart would be deleted outright and silently -- strictly worse than the
  // state this whole change fixes.
  it('is NOT armed when enabled with no usable time', () => {
    expect(dailyHandoffArmed({ ...DAILY_ONLY, dailyHandoffTime: null })).toBe(false)
    expect(dailyHandoffArmed({ ...DAILY_ONLY, dailyHandoffTime: '25:99' })).toBe(false)
    expect(dailyHandoffArmed({ ...DAILY_ONLY, dailyHandoffTime: 'reggel' })).toBe(false)
  })
})

describe('dailyHandoffDue -- same due-semantics as the nightly restart', () => {
  it('is not due before the slot, and due after it', () => {
    const beforeSlot = new Date('2026-09-10T03:00:00').getTime()
    expect(dailyHandoffDue(DAILY_ONLY, MIDNIGHT, null, beforeSlot)).toBe(false)
    expect(dailyHandoffDue(DAILY_ONLY, MIDNIGHT, null, NOW)).toBe(true)
  })

  it('does not fire twice for the same slot', () => {
    const served = new Date('2026-09-10T04:00:30').getTime()
    expect(dailyHandoffDue(DAILY_ONLY, MIDNIGHT, served, NOW)).toBe(false)
  })

  it('is due again the next day', () => {
    const servedYesterday = new Date('2026-09-09T04:00:30').getTime()
    expect(dailyHandoffDue(DAILY_ONLY, MIDNIGHT, servedYesterday, NOW)).toBe(true)
  })

  it('is never due when the tier is not armed', () => {
    expect(dailyHandoffDue({ ...DAILY_ONLY, dailyHandoffTime: null }, MIDNIGHT, null, NOW)).toBe(false)
    expect(dailyHandoffDue({ ...DAILY_ONLY, dailyHandoffEnabled: false }, MIDNIGHT, null, NOW)).toBe(false)
  })
})

describe('dailyHandoffStep -- the served record is seeded while ARMED', () => {
  // The measured case (a live fleet, 2026-09-29): the dashboard process first
  // saw the agents at ~02:05 with the tier OFF, the tier was armed at 12:53 for
  // 03:00, and four agents were handed off at 12:56 -- a slot already passed
  // today counted as missed. Every time below is on one local day.
  const at = (h: number, m: number, dayOffset = 0) =>
    MIDNIGHT + dayOffset * 86_400_000 + (h * 60 + m) * 60_000
  const OFF: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffEnabled: false, dailyHandoffTime: '03:00' }
  const ON: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffTime: '03:00' }

  it('a disarmed tier keeps no record, so nothing stale survives to the arming', () => {
    expect(dailyHandoffStep(OFF, undefined, MIDNIGHT, at(2, 5))).toEqual({ due: false, record: undefined })
    // ...and one seeded earlier is forgotten, not kept.
    expect(dailyHandoffStep(OFF, at(2, 5), MIDNIGHT, at(12, 0))).toEqual({ due: false, record: undefined })
  })

  it('armed after today\'s slot: seeds at the arming, does NOT fire today, fires tomorrow', () => {
    let record = dailyHandoffStep(OFF, undefined, MIDNIGHT, at(2, 5)).record   // first sight, tier off
    let step = dailyHandoffStep(ON, record, MIDNIGHT, at(12, 53))              // armed
    expect(step.due).toBe(false)
    record = step.record
    step = dailyHandoffStep(ON, record, MIDNIGHT, at(12, 56))                  // the sweep that fired
    expect(step.due).toBe(false)
    const tomorrow = MIDNIGHT + 86_400_000
    expect(dailyHandoffStep(ON, step.record, tomorrow, at(2, 59, 1)).due).toBe(false)
    expect(dailyHandoffStep(ON, step.record, tomorrow, at(3, 0, 1)).due).toBe(true)
  })

  it('armed before today\'s slot: fires AT the slot, not before', () => {
    let record = dailyHandoffStep(OFF, undefined, MIDNIGHT, at(0, 1)).record
    const armed = dailyHandoffStep(ON, record, MIDNIGHT, at(0, 15))
    expect(armed.due).toBe(false)
    record = armed.record
    expect(dailyHandoffStep(ON, record, MIDNIGHT, at(2, 59)).due).toBe(false)
    expect(dailyHandoffStep(ON, record, MIDNIGHT, at(3, 0)).due).toBe(true)
  })

  it('an already-armed agent keeps its record and is due at the slot as before', () => {
    const step = dailyHandoffStep(ON, at(3, 0, -1), MIDNIGHT, at(3, 1))
    expect(step).toEqual({ due: true, record: at(3, 0, -1) })
  })
})

describe('dailyHandoffSweep -- one sweep, in the order the runner applies it', () => {
  const at = (h: number, m: number) => MIDNIGHT + (h * 60 + m) * 60_000
  const OFF: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffEnabled: false, dailyHandoffTime: '03:00' }
  const ON: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffTime: '03:00' }

  it('a disarmed tier forgets the record even when the agent is NOT eligible (never idle)', () => {
    // The case the order exists for: forgetting must not wait behind the idle gate,
    // or a never-idle agent keeps its old armed record and re-arming fires at once.
    expect(dailyHandoffSweep(OFF, at(2, 5), false, MIDNIGHT, at(12, 0))).toEqual({ due: false, record: undefined })
    expect(dailyHandoffSweep(OFF, at(2, 5), true, MIDNIGHT, at(12, 0))).toEqual({ due: false, record: undefined })
  })

  it('armed but not eligible: the record is kept as it is, neither seeded nor forgotten', () => {
    expect(dailyHandoffSweep(ON, at(1, 0), false, MIDNIGHT, at(12, 0))).toEqual({ due: false, record: at(1, 0) })
    expect(dailyHandoffSweep(ON, undefined, false, MIDNIGHT, at(12, 0))).toEqual({ due: false, record: undefined })
  })

  it('armed and eligible: first sight seeds without firing; a record from before the slot fires after it', () => {
    expect(dailyHandoffSweep(ON, undefined, true, MIDNIGHT, at(12, 53))).toEqual({ due: false, record: at(12, 53) })
    expect(dailyHandoffSweep(ON, at(1, 0), true, MIDNIGHT, at(3, 0))).toEqual({ due: true, record: at(1, 0) })
  })

  it('the misfire end to end: armed after the slot, an agent busy while disarmed does not fire on arming', () => {
    let record = dailyHandoffSweep(ON, undefined, true, MIDNIGHT, at(0, 30)).record   // seeded, armed
    record = dailyHandoffSweep(OFF, record, false, MIDNIGHT, at(2, 0)).record         // disarmed while busy
    const armed = dailyHandoffSweep(ON, record, true, MIDNIGHT, at(12, 53))           // armed after 03:00
    expect(armed.due).toBe(false)
  })
})

describe('normalizeContextGuardConfig -- the daily fields', () => {
  it('defaults to off with no time, and only an explicit true enables', () => {
    const c = normalizeContextGuardConfig({})
    expect(c.dailyHandoffEnabled).toBe(false)
    expect(c.dailyHandoffTime).toBe(null)
    expect(normalizeContextGuardConfig({ dailyHandoffEnabled: 'true' }).dailyHandoffEnabled).toBe(false)
  })

  it('keeps a valid HH:MM and nulls anything else', () => {
    expect(normalizeContextGuardConfig({ dailyHandoffTime: ' 04:00 ' }).dailyHandoffTime).toBe('04:00')
    expect(normalizeContextGuardConfig({ dailyHandoffTime: '4 ora' }).dailyHandoffTime).toBe(null)
    expect(normalizeContextGuardConfig({ dailyHandoffTime: 400 }).dailyHandoffTime).toBe(null)
  })
})

describe('decideGuard -- the daily tier', () => {
  it('requests a handoff when the slot is due, and enters await-handoff with a deadline', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true }), DAILY_ONLY)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(true)
    expect(d.nextState.phase).toBe('await-handoff')
    expect(d.nextState.deadlineMs).toBe(NOW + DAILY_ONLY.handoffTimeoutMinutes * 60_000)
  })

  it('does nothing when the slot is not due', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs(), DAILY_ONLY).action).toBe('none')
  })

  // Deliberately NOT gated on paneIdle, unlike the idle-flush tier: this one
  // has a slot to keep. await-handoff is what refuses to cut a live turn.
  it('still requests the handoff from a busy agent', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, paneIdle: false, paneBusy: true }), DAILY_ONLY)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(true)
  })

  it('ranks BELOW the wedge tiers: a session at the hard threshold restarts on that reason', () => {
    const cfg = { ...DAILY_ONLY, enabled: true }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true, pct: 0.99 }), cfg)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('hard threshold')
  })

  it('ranks BELOW the idle-flush tier: a heavy quiet session flushes on that reason', () => {
    const cfg = { ...DAILY_ONLY, idleFlushEnabled: true }
    const d = decideGuard(
      INITIAL_GUARD_STATE,
      inputs({ dailyHandoffDue: true, contextTokens: 500_000, idleMs: 30 * 60_000 }),
      cfg,
    )
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(IDLE_FLUSH_REASON_PREFIX)).toBe(true)
  })

  // Failure branch 1: the tier is the only one armed. Before the fix the
  // "everything disabled" short-circuit swallowed it and the tier could never
  // fire at all.
  it('is not swallowed by the all-disabled short-circuit when it is the only tier armed', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ dailyHandoffDue: true }), DAILY_ONLY)
    expect(d.reason).not.toBe('disabled')
    expect(d.action).toBe('request-handoff')
  })
})

describe('decideGuard -- the daily tier mid-sequence (failure branches)', () => {
  const awaiting: GuardState = {
    phase: 'await-handoff',
    handoffMtimeAtRequest: null,
    deadlineMs: NOW + 60_000,
    cooldownUntilMs: 0,
    saturatedStreak: 0,
    staleRefreshCount: 0,
    handoffStaleMinutes: null,
  }

  // Failure branch 2, and the one that made this tier need its own line in the
  // stand-down guard: a daily-only agent must not be stood down on the very
  // next sweep after its handoff was requested.
  it('does not stand down during await-handoff when only the daily tier is armed', () => {
    const d = decideGuard(awaiting, inputs(), DAILY_ONLY)
    expect(d.reason).not.toBe('guard disabled during await-handoff')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  // Failure branch 3: the agent never writes the handoff. The restart must
  // STILL happen -- a nightly restart that waits forever is worse than one
  // that loses context -- and the reason must say it went without one.
  it('force-restarts when the handoff never arrives, and says so', () => {
    const past: GuardState = { ...awaiting, deadlineMs: NOW - 1 }
    const d = decideGuard(past, inputs({ handoffMtime: null }), DAILY_ONLY)
    expect(d.action).toBe('restart')
    expect(d.reason).toBe('handoff timeout -- force restart')
  })

  it('but never cuts a live turn: a busy pane defers the timeout restart', () => {
    const past: GuardState = { ...awaiting, deadlineMs: NOW - 1 }
    const d = decideGuard(past, inputs({ paneIdle: false, paneBusy: true }), DAILY_ONLY)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring restart')
  })

  // Existence is not freshness: the handoff must post-date the request. A
  // HANDOFF.md left on disk by an earlier session, weeks old, must not satisfy
  // the wait.
  it('an OLD handoff on disk does not satisfy the wait', () => {
    const withStamp: GuardState = { ...awaiting, handoffMtimeAtRequest: NOW - 1_000 }
    const d = decideGuard(withStamp, inputs({ handoffMtime: NOW - 5_000 }), DAILY_ONLY)
    expect(d.action).toBe('none')
    expect(d.reason).toBe('waiting for handoff')
  })

  it('a handoff written AFTER the request restarts the agent', () => {
    const withStamp: GuardState = { ...awaiting, handoffMtimeAtRequest: NOW - 5_000 }
    const d = decideGuard(withStamp, inputs({ handoffMtime: NOW - 1_000 }), DAILY_ONLY)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })
})

describe('dailyHandoffPrompt', () => {
  it('states a scheduled restart, names the time and the path, and claims no emergency', () => {
    const p = dailyHandoffPrompt('04:00', '/tmp/agent/HANDOFF.md')
    expect(p).toContain('04:00')
    expect(p).toContain('/tmp/agent/HANDOFF.md')
    expect(p).toContain('nem vészhelyzet')
    // The act-tier wording would be a lie here: this session is nowhere near
    // its context limit, and telling it otherwise provokes exactly the
    // panicked mid-task abandonment the separate wording exists to avoid.
    expect(p).not.toContain('kritikus')
  })
})

// The three wiring facts that live in runner code -- fs, tmux and a 60s sweep
// away from any unit test. Asserted structurally, the same way the auto-restart
// suite asserts the absence of a handoff read: there is no runtime path here to
// observe, and "the pure predicate is correct" says nothing about whether the
// runner calls it. Each of these was verified by mutation.
describe('runner wiring', () => {
  it('the nightly auto-restart stands aside for an ARMED daily tier, before computing its own due slot', () => {
    const code = src('src/web/auto-restart-runner.ts')
    expect(code).toContain('dailyHandoffArmed(readContextGuardConfig(name))')
    // Order matters: standing aside after the due computation would still let
    // this runner restart the agent on the same tick the guard asks for a
    // handoff -- exactly the double-restart the delegation exists to prevent.
    //
    // Anchor on the CALL SITE, not on the bare identifier: the import line at
    // the top of the file precedes everything, so `indexOf('dailyHandoffArmed(')`
    // passed no matter where the check actually sat (measured -- this
    // assertion was blind to a mutation that moved the block below the due
    // computation until the anchor was narrowed).
    expect(code.indexOf('dailyHandoffArmed(readContextGuardConfig(name))'))
      .toBeLessThan(code.indexOf('const dueAt = computeDueAt('))
  })

  it('the guard marks the daily slot served, so a failed prompt cannot re-fire it every sweep', () => {
    const code = src('src/web/context-guard-runner.ts')
    // The two lines must be ADJACENT, not merely both present: the same
    // `lastDailyHandoff.set(name, nowMs)` call also implements seed-on-first-
    // sight further up, so a `toContain` on it alone stayed green when the
    // mark-served line was deleted (measured).
    expect(code).toContain(
      'if (decision.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)) {\n' +
      '    lastDailyHandoff.set(name, nowMs)\n' +
      '  }',
    )
  })

  it('the runner applies BOTH halves of dailyHandoffSweep, gated on running and idle', () => {
    const code = src('src/web/context-guard-runner.ts')
    // The decision is unit-tested below; what only the runner can get wrong is the
    // eligibility it passes and applying an `undefined` record as a delete.
    expect(code).toContain("dailyHandoffSweep(\n        cfg, lastDailyHandoff.get(name), running && state.phase === 'idle', localMidnightMs(nowMs), nowMs,")
    expect(code).toContain('if (sweep.record === undefined) lastDailyHandoff.delete(name)')
    expect(code).toContain('else lastDailyHandoff.set(name, sweep.record)')
  })

  it('the daily reason selects the scheduled wording, not the act tier percentage prompt', () => {
    const code = src('src/web/context-guard-runner.ts')
    expect(code).toContain('dailyHandoffPrompt(cfg.dailyHandoffTime')
  })

  // The runner keeps its OWN copy of the "fully disarmed" condition, ahead of
  // decideGuard. The daily tier was missing from it: an agent with the
  // saturation net off and the daily tier on was dropped before the state
  // machine ever ran, silently. Found by reading the early returns, not by a
  // failing test -- which is why this assertion exists now.
  it('the runner does not treat a daily-only agent as fully disarmed', () => {
    const code = src('src/web/context-guard-runner.ts')
    expect(code).toContain(
      'if (!cfg.enabled && !cfg.saturationRestart && !cfg.idleFlushEnabled && !cfg.dailyHandoffEnabled) {',
    )
  })
})
