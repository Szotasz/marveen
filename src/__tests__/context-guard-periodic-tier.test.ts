// The context-guard's PERIODIC-HANDOFF tier (CTXGUARDTIERS1107).
//
// A wall-clock cadence (periodicHandoffMinutes) with a token floor
// (periodicHandoffMinTokens): a due slot whose session barely grew since the
// tier's last run is skipped, and the clock is pushed a full interval out so
// the quiet agent is not re-checked every sweep. Opt-in, default OFF. Like the
// daily tier it respects the owner's open question; unlike daily it never types
// a handoff directive into a positively busy pane.
import { describe, it, expect } from 'vitest'
import {
  decideGuard,
  normalizeContextGuardConfig,
  periodicHandoffStep,
  periodicHandoffSweep,
  applyPeriodicHandoffSkipSweep,
  periodicHandoffSkipSweep,
  contextGuardWeakenings,
  PERIODIC_HANDOFF_REASON_PREFIX,
  DAILY_HANDOFF_REASON_PREFIX,
  IDLE_FLUSH_REASON_PREFIX,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  type ContextGuardConfig,
  type GuardInputs,
  type GuardState,
  type PeriodicHandoffRecord,
} from '../context-guard.js'
import { periodicHandoffPrompt } from '../web/context-guard-runner.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runnerSrc = (): string => readFileSync(join(ROOT, 'src/web/context-guard-runner.ts'), 'utf-8')

const NOW = 1_790_000_000_000
const MIN = 60_000

/** Only the periodic tier armed. */
const PERIODIC_ONLY: ContextGuardConfig = {
  ...DEFAULT_CONTEXT_GUARD,
  enabled: false,
  saturationRestart: false,
  idleFlushEnabled: false,
  dailyHandoffEnabled: false,
  periodicHandoffEnabled: true,
  periodicHandoffMinutes: 30,
  periodicHandoffMinTokens: 50_000,
}

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    paneBackgroundWork: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    contextTokens: null,
    idleMs: null,
    dailyHandoffDue: false,
    periodicHandoffDue: false,
    taskCloseHandoffDue: false,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}

describe('config -- default off, normalized', () => {
  it('ships disabled, 30 minutes, 50k floor', () => {
    expect(DEFAULT_CONTEXT_GUARD.periodicHandoffEnabled).toBe(false)
    expect(DEFAULT_CONTEXT_GUARD.periodicHandoffMinutes).toBe(30)
    expect(DEFAULT_CONTEXT_GUARD.periodicHandoffMinTokens).toBe(50_000)
    const n = normalizeContextGuardConfig({})
    expect(n.periodicHandoffEnabled).toBe(false)
  })

  it('only a literal true arms it', () => {
    expect(normalizeContextGuardConfig({ periodicHandoffEnabled: 'true' }).periodicHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ periodicHandoffEnabled: 1 }).periodicHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ periodicHandoffEnabled: true }).periodicHandoffEnabled).toBe(true)
  })

  it('accepts a 0 token floor, rejects negative / non-number', () => {
    expect(normalizeContextGuardConfig({ periodicHandoffMinTokens: 0 }).periodicHandoffMinTokens).toBe(0)
    expect(normalizeContextGuardConfig({ periodicHandoffMinTokens: -5 }).periodicHandoffMinTokens).toBe(50_000)
    expect(normalizeContextGuardConfig({ periodicHandoffMinTokens: 'x' }).periodicHandoffMinTokens).toBe(50_000)
  })

  it('switching it off, a longer cadence or a higher floor count as weakening', () => {
    const on = normalizeContextGuardConfig({ periodicHandoffEnabled: true })
    expect(contextGuardWeakenings(on, { ...on, periodicHandoffEnabled: false })).toContain('periodicHandoffEnabled')
    expect(contextGuardWeakenings(on, { ...on, periodicHandoffMinutes: 60 })).toContain('periodicHandoffMinutes')
    expect(contextGuardWeakenings(on, { ...on, periodicHandoffMinTokens: 100_000 })).toContain('periodicHandoffMinTokens')
    expect(contextGuardWeakenings(on, { ...on, periodicHandoffMinutes: 15 })).toEqual([])
  })
})

describe('periodicHandoffStep -- clock and token floor', () => {
  it('first sight seeds without firing', () => {
    expect(periodicHandoffStep(PERIODIC_ONLY, undefined, 120_000, NOW)).toEqual({ due: false, record: { atMs: NOW, tokens: 120_000 } })
  })

  it('not due before the interval elapsed', () => {
    const rec: PeriodicHandoffRecord = { atMs: NOW - 29 * MIN, tokens: 100_000 }
    expect(periodicHandoffStep(PERIODIC_ONLY, rec, 400_000, NOW)).toEqual({ due: false, record: rec })
  })

  it('fires when the interval elapsed and the context grew past the floor; record left for the runner to commit', () => {
    const rec: PeriodicHandoffRecord = { atMs: NOW - 30 * MIN, tokens: 100_000 }
    expect(periodicHandoffStep(PERIODIC_ONLY, rec, 150_000, NOW)).toEqual({ due: true, record: rec })
  })

  it('token-floor skip pushes the clock a full interval from now, baseline unchanged', () => {
    const rec: PeriodicHandoffRecord = { atMs: NOW - 45 * MIN, tokens: 100_000 }
    const step = periodicHandoffStep(PERIODIC_ONLY, rec, 120_000, NOW)
    expect(step).toEqual({ due: false, record: { atMs: NOW, tokens: 100_000 } })
    // Not re-checked on the next sweep...
    expect(periodicHandoffStep(PERIODIC_ONLY, step.record, 500_000, NOW + MIN).due).toBe(false)
    // ...but due once the pushed interval has elapsed and growth is there.
    expect(periodicHandoffStep(PERIODIC_ONLY, step.record, 500_000, NOW + 30 * MIN).due).toBe(true)
  })

  it('a 0 floor fires on the clock alone', () => {
    const rec: PeriodicHandoffRecord = { atMs: NOW - 30 * MIN, tokens: 100_000 }
    expect(periodicHandoffStep({ ...PERIODIC_ONLY, periodicHandoffMinTokens: 0 }, rec, 100_000, NOW).due).toBe(true)
  })
})

describe('periodicHandoffSweep -- default off and gates', () => {
  const rec: PeriodicHandoffRecord = { atMs: NOW - 60 * MIN, tokens: 0 }

  it('a disarmed tier never fires and forgets its record', () => {
    expect(periodicHandoffSweep(DEFAULT_CONTEXT_GUARD, rec, true, 500_000, NOW)).toEqual({ due: false, record: undefined })
  })

  it('an ineligible sweep keeps the record and does not fire', () => {
    expect(periodicHandoffSweep(PERIODIC_ONLY, rec, false, 500_000, NOW)).toEqual({ due: false, record: rec })
  })
})

describe('periodicHandoffSkipSweep -- the owner-question hold', () => {
  const rec: PeriodicHandoffRecord = { atMs: NOW - 30 * MIN, tokens: 0 }

  it('an open owner question blocks a due slot and records it as served', () => {
    const r = periodicHandoffSkipSweep(PERIODIC_ONLY, rec, false, true, 200_000, NOW, () => true)
    expect(r.due).toBe(false)
    expect(r.skippedNow).toBe(true)
    expect(r.skippedLast).toBe(true)
    expect(r.record).toEqual({ atMs: NOW, tokens: 200_000 })
  })

  it('no question: fires', () => {
    expect(periodicHandoffSkipSweep(PERIODIC_ONLY, rec, false, true, 200_000, NOW, () => false).due).toBe(true)
  })

  it('the question is not read on a sweep that is not due', () => {
    let reads = 0
    periodicHandoffSkipSweep(PERIODIC_ONLY, { atMs: NOW, tokens: 0 }, false, true, 200_000, NOW, () => { reads++; return true })
    expect(reads).toBe(0)
  })

  it('applyPeriodicHandoffSkipSweep: default-off agent gets no record and no fire', () => {
    const records = new Map<string, PeriodicHandoffRecord>([['a', rec]])
    const skipped = new Set<string>(['a'])
    const due = applyPeriodicHandoffSkipSweep(records, skipped, 'a', DEFAULT_CONTEXT_GUARD, true, 500_000, NOW, () => false, () => {})
    expect(due).toBe(false)
    expect(records.has('a')).toBe(false)
    expect(skipped.has('a')).toBe(false)
  })

  it('applyPeriodicHandoffSkipSweep: calls onSkip once on a question skip', () => {
    const records = new Map<string, PeriodicHandoffRecord>([['a', rec]])
    const skipped = new Set<string>()
    let skips = 0
    expect(applyPeriodicHandoffSkipSweep(records, skipped, 'a', PERIODIC_ONLY, true, 200_000, NOW, () => true, () => { skips++ })).toBe(false)
    expect(skips).toBe(1)
    expect(skipped.has('a')).toBe(true)
  })
})

describe('decideGuard -- the periodic tier', () => {
  it('default config: a due flag does nothing (tier off)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true }), DEFAULT_CONTEXT_GUARD)
    expect(d.reason.startsWith(PERIODIC_HANDOFF_REASON_PREFIX)).toBe(false)
    expect(d.action).not.toBe('request-handoff')
  })

  it('fires when due, as the only armed tier, entering await-handoff', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true }), PERIODIC_ONLY)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(PERIODIC_HANDOFF_REASON_PREFIX)).toBe(true)
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('does nothing when not due', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs(), PERIODIC_ONLY).action).toBe('none')
  })

  it('a busy pane blocks the request (no directive typed into a live reply)', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true, paneIdle: false, paneBusy: true }), PERIODIC_ONLY)
    expect(d.action).toBe('none')
  })

  it('a busy pane in await-handoff defers the restart past the deadline', () => {
    const awaiting: GuardState = {
      ...INITIAL_GUARD_STATE,
      phase: 'await-handoff',
      handoffMtimeAtRequest: null,
      deadlineMs: NOW - MIN,
      handoffRequestReason: `${PERIODIC_HANDOFF_REASON_PREFIX} (every 30m)`,
    }
    const d = decideGuard(awaiting, inputs({ paneIdle: false, paneBusy: true }), PERIODIC_ONLY)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('a usage-limited session parks it', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true, usageLimited: true }), PERIODIC_ONLY).action).toBe('none')
  })

  it('only one tier per sweep: idle-flush outranks it, it outranks daily', () => {
    const flushCfg = { ...PERIODIC_ONLY, idleFlushEnabled: true }
    const f = decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true, contextTokens: 500_000, idleMs: 30 * MIN }), flushCfg)
    expect(f.reason.startsWith(IDLE_FLUSH_REASON_PREFIX)).toBe(true)
    const dailyCfg = { ...PERIODIC_ONLY, dailyHandoffEnabled: true, dailyHandoffTime: '04:00' }
    const p = decideGuard(INITIAL_GUARD_STATE, inputs({ periodicHandoffDue: true, dailyHandoffDue: true }), dailyCfg)
    expect(p.reason.startsWith(PERIODIC_HANDOFF_REASON_PREFIX)).toBe(true)
    expect(p.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)).toBe(false)
  })

  it('does not stand down in await-handoff when it is the only tier armed', () => {
    const awaiting: GuardState = { ...INITIAL_GUARD_STATE, phase: 'await-handoff', handoffMtimeAtRequest: null, deadlineMs: NOW + MIN }
    expect(decideGuard(awaiting, inputs(), PERIODIC_ONLY).reason).not.toBe('guard disabled during await-handoff')
  })
})

describe('runner wiring', () => {
  it('the prompt names the cadence and claims no percentage', () => {
    const p = periodicHandoffPrompt(30, '/x/HANDOFF.md')
    expect(p).toContain('30 percenkénti')
    expect(p).toContain('/x/HANDOFF.md')
    expect(p).not.toMatch(/\d+%/)
    expect(p).not.toContain('—')
  })

  it('the runner picks the periodic prompt by its reason prefix', () => {
    expect(runnerSrc()).toContain('promptReason.startsWith(PERIODIC_HANDOFF_REASON_PREFIX)')
    expect(runnerSrc()).toContain('periodicHandoffPrompt(cfg.periodicHandoffMinutes, handoffPathFor(name))')
  })

  it('the periodic slot respects the owner-question hold (dailyQuestionOpen)', () => {
    expect(runnerSrc()).toMatch(/applyPeriodicHandoffSkipSweep\([\s\S]*?\(\) => dailyQuestionOpen\(name\)/)
  })

  it('any handoff/restart decision re-seeds the periodic record (deleted, not stamped)', () => {
    expect(runnerSrc()).toContain(
      "  if (decision.action === 'request-handoff' || decision.action === 'restart') {\n" +
      '    lastPeriodicHandoff.delete(name)\n',
    )
  })
})
