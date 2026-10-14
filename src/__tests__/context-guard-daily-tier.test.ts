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
  applyDailyHandoffSweep,
  dailyHandoffSkipSweep,
  applyDailyHandoffSkipSweep,
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

describe('applyDailyHandoffSweep -- the sweep applied to the runner\'s record map', () => {
  const at = (h: number, m: number) => MIDNIGHT + (h * 60 + m) * 60_000
  const OFF: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffEnabled: false, dailyHandoffTime: '03:00' }
  const ON: ContextGuardConfig = { ...DAILY_ONLY, dailyHandoffTime: '03:00' }

  it('a never-running agent on a disarmed tier loses its record, so arming after the slot does not fire', () => {
    const records = new Map([['a', at(0, 30)]])
    expect(applyDailyHandoffSweep(records, 'a', OFF, false, MIDNIGHT, at(2, 0))).toBe(false)
    expect(records.has('a')).toBe(false)
    expect(applyDailyHandoffSweep(records, 'a', ON, true, MIDNIGHT, at(12, 53))).toBe(false)
    expect(records.get('a')).toBe(at(12, 53))
  })

  it('armed but not eligible: the record is left exactly as it was', () => {
    const records = new Map([['a', at(1, 0)]])
    expect(applyDailyHandoffSweep(records, 'a', ON, false, MIDNIGHT, at(12, 0))).toBe(false)
    expect(records.get('a')).toBe(at(1, 0))
    const empty = new Map<string, number>()
    applyDailyHandoffSweep(empty, 'a', ON, false, MIDNIGHT, at(12, 0))
    expect(empty.has('a')).toBe(false)
  })

  it('armed and eligible: returns due for a record from before the slot, and touches only its own agent', () => {
    const records = new Map([['a', at(1, 0)], ['b', at(0, 10)]])
    expect(applyDailyHandoffSweep(records, 'a', ON, true, MIDNIGHT, at(3, 0))).toBe(true)
    expect(records.get('a')).toBe(at(1, 0))
    expect(applyDailyHandoffSweep(records, 'a', OFF, false, MIDNIGHT, at(3, 0))).toBe(false)
    expect(records.has('a')).toBe(false)
    expect(records.get('b')).toBe(at(0, 10))
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
      '    lastDailyHandoff.set(name, nowMs)\n',
    )
  })

  it('the runner computes dailyHandoffDue in ONE call, gated on running and idle', () => {
    const code = src('src/web/context-guard-runner.ts')
    // Applying the record and the skip flag is behaviour-tested (applyDailyHandoffSkipSweep);
    // what only the runner can get wrong is the eligibility it passes. The whole property line
    // is pinned, so nothing can stand in front of the call: an early `if (!running) return
    // false` or a `running && ...` guard would put the forget behind the idle gate again.
    expect(code).toContain(
      "\n    dailyHandoffDue: applyDailyHandoffSkipSweep(lastDailyHandoff, dailySkipped, name, cfg, running && state.phase === 'idle', localMidnightMs(nowMs), nowMs, () => dailyQuestionOpen(name), () => logger.info({ name }, 'context-guard: daily handoff skipped today -- open inbound question (the next slot fires regardless)')),\n",
    )
    expect(code.match(/dailyHandoffDue:/g)).toHaveLength(1)
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

describe('dailyHandoffSkipSweep -- an open question skips one slot, never more in a row', () => {
  const H = 60 * 60 * 1000
  const cfg: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, dailyHandoffEnabled: true, dailyHandoffTime: '03:00' }
  // Synthetic, epoch-aligned midnights: independent of the host timezone.
  const DAY0 = Date.UTC(2026, 0, 5)

  // Drives the sweep the way the runner does, every 15 minutes. "Served" is
  // the runner's served block: mark the slot and clear the skip flag.
  function simulate(
    hours: number,
    open: (t: number) => boolean | undefined,
    opts: { eligible?: (t: number) => boolean; serve?: (t: number) => boolean } = {},
  ) {
    let record: number | undefined = DAY0 - H
    let skippedLast = false
    const fired: number[] = []
    const skipped: number[] = []
    let reads = 0
    for (let t = DAY0; t < DAY0 + hours * H; t += 15 * 60 * 1000) {
      const midnight = DAY0 + Math.floor((t - DAY0) / (24 * H)) * 24 * H
      const r = dailyHandoffSkipSweep(cfg, record, skippedLast, opts.eligible ? opts.eligible(t) : true, midnight, t, () => { reads++; return open(t) })
      record = r.record
      skippedLast = r.skippedLast
      if (r.skippedNow) skipped.push(t)
      if (r.due) {
        fired.push(t)
        if (!opts.serve || opts.serve(t)) { record = t; skippedLast = false }
      }
    }
    const h = (xs: number[]) => xs.map(x => (x - DAY0) / H)
    return { fired: h(fired), skipped: h(skipped), reads }
  }

  it('with no question the slot fires once a day at 03:00', () => {
    expect(simulate(72, () => false).fired).toEqual([3, 27, 51])
  })

  it('a question open at the slot skips that day; the next slot fires even if one is open again', () => {
    const r = simulate(4 * 24, () => true)
    expect(r.skipped).toEqual([3, 51])
    expect(r.fired).toEqual([27, 75])
  })

  it('a question open only on day 0 costs exactly that one slot', () => {
    const r = simulate(72, t => t < DAY0 + 24 * H)
    expect(r.skipped).toEqual([3])
    expect(r.fired).toEqual([27, 51])
  })

  it('never fires off the slot: an evening acknowledgement answered next morning gives every other day, at 03:00', () => {
    // Every day the owner sends an unanswered "thanks" at 22:00 and gets a reply at 08:01.
    const open = (t: number) => { const hod = ((t - DAY0) / H) % 24; return hod >= 22 || hod < 8 }
    const r = simulate(7 * 24, open)
    expect(r.fired).toEqual([27, 75, 123])
    expect(r.skipped).toEqual([3, 51, 99, 147])
    for (const f of r.fired) expect(f % 24).toBe(3)
  })

  it('a failed ledger read counts as no question: the slot fires', () => {
    expect(simulate(4, () => undefined).fired).toEqual([3])
  })

  it('reads the ledger only on a due, eligible, unforced sweep', () => {
    expect(simulate(72, () => false).reads).toBe(3)
    // Skip at 3 (read), forced fire at 27 (no read), skip at 51 (read).
    expect(simulate(72, () => true).reads).toBe(2)
  })

  it('an ineligible slot time is not a skip: the first eligible sweep decides, as without this rule', () => {
    // Busy 02:00-09:00 on day 0: develop fires at 09:00; with no question so does this.
    const busy = (t: number) => !(t >= DAY0 + 2 * H && t < DAY0 + 9 * H)
    expect(simulate(12, () => false, { eligible: busy }).fired).toEqual([9])
    const r = simulate(12, () => true, { eligible: busy })
    expect(r.skipped).toEqual([9])
    expect(r.fired).toEqual([])
  })

  it('a forced slot pre-empted by a higher tier stays forced on the next sweep', () => {
    // Day 1's forced slot at 27:00 is not served (another tier won); 27:15 is still forced.
    const r = simulate(28, () => true, { serve: t => t !== DAY0 + 27 * H })
    expect(r.fired).toEqual([27, 27.25])
    expect(r.skipped).toEqual([3])
  })

  it('a disarmed tier forgets the record and the skip flag, without a ledger read', () => {
    let reads = 0
    const r = dailyHandoffSkipSweep({ ...cfg, dailyHandoffEnabled: false }, DAY0 - H, true, false, DAY0, DAY0 + 5 * H, () => { reads++; return true })
    expect(r).toEqual({ due: false, record: undefined, skippedLast: false, skippedNow: false })
    expect(reads).toBe(0)
  })

  it('a first armed sight seeds the record without a read or a skip', () => {
    let reads = 0
    const r = dailyHandoffSkipSweep(cfg, undefined, false, true, DAY0, DAY0 + 5 * H, () => { reads++; return true })
    expect(r).toEqual({ due: false, record: DAY0 + 5 * H, skippedLast: false, skippedNow: false })
    expect(reads).toBe(0)
  })
})

describe('applyDailyHandoffSkipSweep -- the sweep applied to the runner\'s map and set', () => {
  const H = 60 * 60 * 1000
  const DAY0 = Date.UTC(2026, 0, 5)
  const cfg: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, dailyHandoffEnabled: true, dailyHandoffTime: '03:00' }
  const noop = () => {}

  it('a skip records the slot as served now, sets the flag, reports it, and returns not due', () => {
    const records = new Map([['a', DAY0 - H]])
    const skipped = new Set<string>()
    let reported = 0
    const due = applyDailyHandoffSkipSweep(records, skipped, 'a', cfg, true, DAY0, DAY0 + 4 * H, () => true, () => { reported++ })
    expect(due).toBe(false)
    expect(records.get('a')).toBe(DAY0 + 4 * H)
    expect(skipped.has('a')).toBe(true)
    expect(reported).toBe(1)
  })

  it('a forced slot is due and keeps the flag until the runner serves it', () => {
    const records = new Map([['a', DAY0 - H]])
    const skipped = new Set(['a'])
    let reads = 0
    const due = applyDailyHandoffSkipSweep(records, skipped, 'a', cfg, true, DAY0, DAY0 + 4 * H, () => { reads++; return true }, noop)
    expect(due).toBe(true)
    expect(skipped.has('a')).toBe(true)
    expect(records.get('a')).toBe(DAY0 - H)
    expect(reads).toBe(0)
  })

  it('no question: due, no flag, nothing reported', () => {
    const records = new Map([['a', DAY0 - H]])
    const skipped = new Set<string>()
    let reported = 0
    expect(applyDailyHandoffSkipSweep(records, skipped, 'a', cfg, true, DAY0, DAY0 + 4 * H, () => false, () => { reported++ })).toBe(true)
    expect(skipped.size).toBe(0)
    expect(reported).toBe(0)
  })

  it('disarming deletes the record and the flag, even on an ineligible sweep', () => {
    const records = new Map([['a', DAY0 - H]])
    const skipped = new Set(['a'])
    applyDailyHandoffSkipSweep(records, skipped, 'a', { ...cfg, dailyHandoffEnabled: false }, false, DAY0, DAY0 + 4 * H, () => true, noop)
    expect(records.has('a')).toBe(false)
    expect(skipped.has('a')).toBe(false)
  })

  it('an ineligible sweep keeps the record and the flag, with no read', () => {
    const records = new Map([['a', DAY0 - H]])
    const skipped = new Set(['a'])
    let reads = 0
    expect(applyDailyHandoffSkipSweep(records, skipped, 'a', cfg, false, DAY0, DAY0 + 4 * H, () => { reads++; return true }, noop)).toBe(false)
    expect(records.get('a')).toBe(DAY0 - H)
    expect(skipped.has('a')).toBe(true)
    expect(reads).toBe(0)
  })

  it('applying one agent never touches another agent\'s entries', () => {
    const records = new Map([['a', DAY0 - H], ['b', DAY0 - 2 * H]])
    const skipped = new Set(['b'])
    applyDailyHandoffSkipSweep(records, skipped, 'a', cfg, true, DAY0, DAY0 + 4 * H, () => true, noop) // skip a
    applyDailyHandoffSkipSweep(records, skipped, 'a', { ...cfg, dailyHandoffEnabled: false }, true, DAY0, DAY0 + 4 * H, () => true, noop) // disarm a
    expect(records.get('b')).toBe(DAY0 - 2 * H)
    expect(skipped.has('b')).toBe(true)
    expect(records.has('a')).toBe(false)
    expect(skipped.has('a')).toBe(false)
  })
})

describe('runner wiring -- open-question skip', () => {
  const code = () => src('src/web/context-guard-runner.ts')

  it('the skip set and the question read are pinned verbatim, at module level, declared once', () => {
    expect(code()).toContain(
      '\nconst lastDailyHandoff = new Map<string, number>()\n' +
      '// Agents whose last due daily slot was skipped for an open inbound question;\n' +
      '// their next due slot fires regardless (see dailyHandoffSkipSweep). In-memory\n' +
      '// like lastDailyHandoff: a dashboard restart forgets it, which can allow one\n' +
      '// more skip in a row.\n' +
      'const dailySkipped = new Set<string>()\n' +
      '\n' +
      '/** Does the owner\'s open question hold this agent back (the /clear gate\'s rule)? undefined = unreadable. */\n' +
      'function dailyQuestionOpen(name: string): boolean | undefined {\n' +
      '  try { return ownerQuestionHolds(name) }\n' +
      '  catch { return undefined }\n' +
      '}\n',
    )
    expect(code().split('new Set<string>()').length - 1).toBeGreaterThanOrEqual(1)
    expect(code().split('const dailySkipped').length - 1).toBe(1)
  })

  it('the served block clears the skip flag together with marking the slot', () => {
    expect(code()).toContain(
      '  if (decision.reason.startsWith(DAILY_HANDOFF_REASON_PREFIX)) {\n' +
      '    lastDailyHandoff.set(name, nowMs)\n' +
      '    dailySkipped.delete(name)\n' +
      '  }\n',
    )
    // The flag is written only by applyDailyHandoffSkipSweep and this block.
    expect(code().split('dailySkipped.').length - 1).toBe(1)
  })
})
