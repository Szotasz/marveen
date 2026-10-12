import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CATCHUP_MAX_AGE_MIN,
  LATE_CATCHUP_THRESHOLD_MS,
  SCHEDULE_COLD_START_CATCHUP_MS,
  SCHEDULE_MAX_CATCHUP_MS,
  catchUpMaxAgeMs,
  computeCatchUpStart,
  decideCatchUp,
  decideCatchUpSummaryDelivery,
  HEARTBEAT_MISS_REPORT_MIN_CADENCE_MS,
  isMissedRunReportable,
} from '../web/schedule-runner.js'
import { cronDueBetween, cronMinGapMs, cronPrevOccurrence } from '../web/cron.js'

// 2026-07-29 incident: the host died at dawn and came back mid-afternoon. The
// scan window on start was a flat `now - 30 min`, so every occurrence missed
// during the outage (the weekly LLM research, the fleet research run, the
// morning briefing) fell outside it and was dropped WITHOUT a fire, a retry row
// or an alert -- the gap surfaced only because the operator asked hours later.
//
// The policy under test: seed the window from a persisted liveness stamp so it
// covers the real downtime (capped), then decide each missed occurrence on its
// own staleness -- run it if it is still useful, record + report it as 'missed'
// if it is not. Silence is the one outcome that is no longer possible.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
const MIN = 60_000
const HOUR = 60 * MIN

describe('computeCatchUpStart: the window covers the actual downtime', () => {
  const now = 1_700_000_000_000

  it('falls back to the cold-start window when no stamp exists', () => {
    expect(computeCatchUpStart(null, now)).toBe(now - SCHEDULE_COLD_START_CATCHUP_MS)
  })

  it('ignores a non-finite stamp', () => {
    expect(computeCatchUpStart(NaN, now)).toBe(now - SCHEDULE_COLD_START_CATCHUP_MS)
  })

  it('scans the real gap when the process was down for hours', () => {
    const downSince = now - 9 * HOUR
    expect(computeCatchUpStart(downSince, now)).toBe(downSince)
  })

  it('caps a multi-day outage instead of replaying a week of crons', () => {
    expect(computeCatchUpStart(now - 7 * 24 * HOUR, now)).toBe(now - SCHEDULE_MAX_CATCHUP_MS)
  })

  it('rejects a future stamp (clock jumped backwards) rather than scanning a negative window', () => {
    // Trusting it would make fromMs > now, so cronPrevOccurrence returns null
    // for everything and the tick silently scans nothing.
    const start = computeCatchUpStart(now + 3 * HOUR, now)
    expect(start).toBeLessThan(now)
    expect(start).toBe(now - SCHEDULE_COLD_START_CATCHUP_MS)
  })

  it('keeps a normal restart window tight', () => {
    expect(computeCatchUpStart(now - 40_000, now)).toBe(now - 40_000)
  })
})

describe('decideCatchUp: run it, or say it was missed -- never neither', () => {
  const task = { type: 'task' as const }

  it('treats an occurrence inside the tick window as an ordinary on-time fire', () => {
    expect(decideCatchUp(task, 10_000)).toBe('on-time')
    expect(decideCatchUp(task, LATE_CATCHUP_THRESHOLD_MS)).toBe('on-time')
  })

  it('catches up a task missed by a couple of hours', () => {
    expect(decideCatchUp(task, 2 * HOUR)).toBe('catch-up')
  })

  it('declares a task missed once it is past its staleness budget', () => {
    // The morning briefing at 06:40, first tick after boot at 20:00: firing it
    // would be worse than not firing it, but it must still be reported.
    expect(decideCatchUp(task, 13 * HOUR)).toBe('stale')
  })

  it('gives heartbeats a short budget -- the next tick is already on its way', () => {
    expect(decideCatchUp({ type: 'heartbeat' }, 20 * MIN)).toBe('catch-up')
    expect(decideCatchUp({ type: 'heartbeat' }, 3 * HOUR)).toBe('stale')
  })

  it('gives cheap command monitors a long budget (the silent Gmail-refresh death)', () => {
    expect(decideCatchUp({ type: 'command' }, 10 * HOUR)).toBe('catch-up')
  })

  it('honours a per-task override', () => {
    expect(decideCatchUp({ type: 'task', catchUpMaxAgeMinutes: 30 }, 2 * HOUR)).toBe('stale')
    expect(decideCatchUp({ type: 'task', catchUpMaxAgeMinutes: 720 }, 10 * HOUR)).toBe('catch-up')
  })

  it('catchUpMaxAgeMinutes: 0 disables catch-up without disabling the schedule', () => {
    expect(decideCatchUp({ type: 'task', catchUpMaxAgeMinutes: 0 }, 5 * MIN)).toBe('stale')
    expect(decideCatchUp({ type: 'task', catchUpMaxAgeMinutes: 0 }, 10_000)).toBe('on-time')
  })

  it('a negative override means always catch up, however late', () => {
    expect(catchUpMaxAgeMs({ type: 'task', catchUpMaxAgeMinutes: -1 })).toBe(Infinity)
    expect(decideCatchUp({ type: 'task', catchUpMaxAgeMinutes: -1 }, 20 * HOUR)).toBe('catch-up')
  })

  it('an unknown task type falls back to the task budget, not to NaN', () => {
    // The live install runs a `type: "dream-engine"` schedule; task-config.json's
    // type is cast, never validated. An undefined lookup would make every
    // comparison NaN and declare each occurrence stale forever.
    const exotic = { type: 'dream-engine' } as unknown as Parameters<typeof catchUpMaxAgeMs>[0]
    expect(catchUpMaxAgeMs(exotic)).toBe(DEFAULT_CATCHUP_MAX_AGE_MIN.task * MIN)
    expect(decideCatchUp(exotic, 2 * HOUR)).toBe('catch-up')
  })

  it('a malformed override falls back to the type default instead of disabling catch-up', () => {
    expect(catchUpMaxAgeMs({ type: 'task', catchUpMaxAgeMinutes: NaN }))
      .toBe(DEFAULT_CATCHUP_MAX_AGE_MIN.task * MIN)
    expect(catchUpMaxAgeMs({ catchUpMaxAgeMinutes: undefined }))
      .toBe(DEFAULT_CATCHUP_MAX_AGE_MIN.task * MIN)
  })
})

describe('cronPrevOccurrence: the age the decision is made on', () => {
  // 2026-07-29 08:40 local, a Wednesday -- one occurrence of "40 6 * * *" is in
  // the window (06:40 that morning), and it is 2h late.
  const at = (iso: string) => new Date(iso).getTime()

  it('returns the occurrence time inside the half-open window', () => {
    const from = at('2026-07-29T00:00:00+02:00')
    const to = at('2026-07-29T08:40:00+02:00')
    const occ = cronPrevOccurrence('40 6 * * *', from, to, 'Europe/Budapest')
    expect(occ).toBe(at('2026-07-29T06:40:00+02:00'))
    expect(to - (occ as number)).toBe(2 * HOUR)
  })

  it('returns null when nothing is due, and agrees with cronDueBetween', () => {
    const from = at('2026-07-29T07:00:00+02:00')
    const to = at('2026-07-29T08:00:00+02:00')
    expect(cronPrevOccurrence('40 6 * * *', from, to, 'Europe/Budapest')).toBeNull()
    expect(cronDueBetween('40 6 * * *', from, to, 'Europe/Budapest')).toBe(false)
  })

  it('yields at most one occurrence for a long window -- no burst on boot', () => {
    const from = at('2026-07-23T00:00:00+02:00')
    const to = at('2026-07-29T08:00:00+02:00')
    const occ = cronPrevOccurrence('*/30 * * * *', from, to, 'Europe/Budapest')
    expect(occ).toBe(at('2026-07-29T08:00:00+02:00'))
  })

  it('an unparseable expression is null, not a throw', () => {
    expect(cronPrevOccurrence('not a cron', 0, 1_000_000)).toBeNull()
  })
})

describe('the runner wires the policy in', () => {
  it('seeds the scan window from the persisted liveness stamp', () => {
    expect(SRC).toMatch(/let lastCheckMs = computeCatchUpStart\(persistedTickMs, Date\.now\(\)\)/)
    expect(SRC).not.toMatch(/let lastCheckMs = Date\.now\(\) - 30 \* 60000/)
  })

  it('persists the stamp AFTER the scan, so a mid-tick crash re-scans that tick', () => {
    const persistIdx = SRC.indexOf('persistLastTickMs(now)')
    const advanceIdx = SRC.indexOf('lastCheckMs = now')
    expect(persistIdx).toBeGreaterThan(advanceIdx)
  })

  it('records a stale occurrence as a missed run instead of dropping it', () => {
    const idx = SRC.indexOf("if (decision === 'stale')")
    expect(idx).toBeGreaterThan(0)
    const branch = SRC.slice(idx, idx + 900)
    expect(branch).toMatch(/appendTaskRun\(task\.name, agentName, 'missed'\)/)
    expect(branch).toMatch(/staleThisTick\.push/)
  })

  it('reports both halves of the gap in one line', () => {
    expect(SRC).toMatch(/sendCatchUpSummary\(caughtUpReportable, staleReportable/)
  })

  it('stays silent on a tick that caught nothing up', () => {
    expect(SRC).toMatch(/if \(caughtUpReportable\.length \|\| staleReportable\.length\) \{/)
  })

  // A heartbeat is self-healing -- the next occurrence is minutes away -- so a
  // missed one is not operator-actionable. Reporting it turned a routine
  // 15-minute heartbeat into ~25 Telegram alerts a day. The miss must still be
  // recorded (WARN log + task_runs); only the push notification is dropped.
  it('filters the report through the cadence rule, not a bare type check', () => {
    expect(SRC).toMatch(/caughtUpThisTick\.filter\(e => isMissedRunReportable\(e, now\)\)/)
    expect(SRC).toMatch(/staleThisTick\.filter\(e => isMissedRunReportable\(e, now\)\)/)
    // The rule needs the schedule on the entry, or every heartbeat reads as
    // "no schedule" and the daily ones stay muted.
    expect(SRC).toMatch(/staleThisTick\.push\(\{ task: task\.name, ageMs, type: task\.type, schedule: task\.schedule \}\)/)
    expect(SRC).toMatch(/caughtUpThisTick\.push\(\{ task: task\.name, ageMs, type: task\.type, schedule: task\.schedule \}\)/)
    // The miss itself is still recorded -- the fix mutes the alert, not the bookkeeping.
    expect(SRC).toMatch(/appendTaskRun\(task\.name, agentName, 'missed'\)/)
  })

  // 2026-09-02 (kanban 83b8c4c3) + review 2026-09-03 (#1153): a gap the
  // machine SLEPT through is operator-caused downtime and is only logged; a
  // gap with no sleep in it (process down: crash, kill, failed restart) is the
  // outage the owner wants to hear about and still goes to the channel. Both
  // delivery paths must exist and the call site must choose by the pure rule.
  it('mutes only a sleep-origin gap, a non-sleep gap still reaches the channel (fix-revert guard)', () => {
    expect(decideCatchUpSummaryDelivery(true)).toBe('log')
    expect(decideCatchUpSummaryDelivery(false)).toBe('channel')
    const callSite = SRC.slice(SRC.indexOf('const caughtUpReportable'), SRC.indexOf('pendingStartupGapMs = 0'))
    expect(callSite).toMatch(/decideCatchUpSummaryDelivery\(systemSleptBetween\(now - gapMs, now\)\) === 'log'/)
    expect(callSite).toMatch(/logCatchUpSummary\(caughtUpReportable, staleReportable, gapMs\)/)
    expect(callSite).toMatch(/sendCatchUpSummary\(caughtUpReportable, staleReportable, gapMs\)/)
    // The log-only variant never touches the channel; the channel variant still does.
    const logStart = SRC.indexOf('function logCatchUpSummary')
    const logFn = SRC.slice(logStart, SRC.indexOf('\nfunction ', logStart + 1))
    expect(logFn).not.toMatch(/sendSchedulerAlertMessage|resolveSchedulerAlertToken/)
    const sendFn = SRC.slice(SRC.indexOf('function sendCatchUpSummary'), SRC.indexOf('\nexport type CatchUpSummaryDelivery'))
    expect(sendFn).toMatch(/sendSchedulerAlertMessage\(token, ownerChat, text\)/)
  })
})

// The mute for missed heartbeats was written for a 15-minute round ("the next
// occurrence is minutes away"), but it was keyed on the TYPE. A heartbeat that
// runs once a day is a day away from its next run, and with the 30-minute
// heartbeat staleness budget its miss was neither caught up nor mentioned.
describe('isMissedRunReportable: muted by cadence, not by type', () => {
  // A fixed instant so the sampled occurrences do not depend on the wall clock.
  const NOW = Date.UTC(2026, 9, 12, 10, 0, 0)

  it('everything that is not a heartbeat is reported, as before', () => {
    expect(isMissedRunReportable({ type: 'task', schedule: '*/5 * * * *' }, NOW)).toBe(true)
    expect(isMissedRunReportable({ type: 'command', schedule: '0 4 * * 3' }, NOW)).toBe(true)
    expect(isMissedRunReportable({ type: 'dream-engine', schedule: '7 2 * * *' }, NOW)).toBe(true)
    expect(isMissedRunReportable({ schedule: '0 7 * * *' }, NOW)).toBe(true)
  })

  it.each([
    ['every 2 minutes', '*/2 * * * *'],
    ['every 15 minutes (the round the mute was added for)', '*/15 * * * *'],
    ['hourly', '0 * * * *'],
    ['four times a day, with a 12 h night gap', '0 8,12,16,20 * * *'],
  ])('a short-cadence heartbeat stays muted: %s', (_name, schedule) => {
    expect(isMissedRunReportable({ type: 'heartbeat', schedule }, NOW)).toBe(false)
  })

  it.each([
    ['twice a day', '0 9,21 * * *'],
    ['once a day', '47 21 * * *'],
    ['weekly', '0 9 * * 1'],
  ])('a heartbeat that comes at most twice a day is reported: %s', (_name, schedule) => {
    expect(isMissedRunReportable({ type: 'heartbeat', schedule }, NOW)).toBe(true)
  })

  it('the answer does not flap with the time of day on an uneven schedule', () => {
    const uneven = { type: 'heartbeat', schedule: '0 8,12,16,20 * * *' }
    for (let h = 0; h < 24; h++) {
      expect(isMissedRunReportable(uneven, NOW + h * HOUR)).toBe(false)
    }
  })

  it('a twice-a-day heartbeat stays reportable across a DST change', () => {
    // Europe/Budapest springs forward on 2027-03-28: the 21:00 -> 09:00 gap of
    // that night is 11 h, not 12. The threshold has to sit under it, or the
    // answer flips for the days whose sample window contains that night.
    const twice = { type: 'heartbeat', schedule: '0 9,21 * * *' }
    for (let d = 0; d < 10; d++) {
      expect(isMissedRunReportable(twice, Date.UTC(2027, 2, 22, 10, 0, 0) + d * 24 * HOUR)).toBe(true)
    }
  })

  it('a heartbeat without a readable schedule keeps the old behaviour', () => {
    expect(isMissedRunReportable({ type: 'heartbeat' }, NOW)).toBe(false)
    expect(isMissedRunReportable({ type: 'heartbeat', schedule: 'not a cron' }, NOW)).toBe(false)
  })

  it('the threshold is about half a day (with DST slack), and it is a parameter', () => {
    expect(HEARTBEAT_MISS_REPORT_MIN_CADENCE_MS).toBe(11 * HOUR)
    expect(isMissedRunReportable({ type: 'heartbeat', schedule: '0 * * * *' }, NOW, 30 * MIN)).toBe(true)
  })
})

describe('cronMinGapMs: the tightest gap of a schedule', () => {
  const NOW = Date.UTC(2026, 9, 12, 10, 0, 0)

  it('a regular schedule gives its period', () => {
    expect(cronMinGapMs('*/15 * * * *', NOW)).toBe(15 * MIN)
    expect(cronMinGapMs('47 21 * * *', NOW)).toBe(24 * HOUR)
  })

  it('an uneven schedule gives the SHORTEST gap, whatever the time of day', () => {
    for (let h = 0; h < 24; h++) {
      expect(cronMinGapMs('0 8,12,16,20 * * *', NOW + h * HOUR)).toBe(4 * HOUR)
    }
  })

  it('an unparseable expression is null, not a throw', () => {
    expect(cronMinGapMs('not a cron', NOW)).toBeNull()
  })
})
