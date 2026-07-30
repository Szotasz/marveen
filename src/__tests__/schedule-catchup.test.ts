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
} from '../web/schedule-runner.js'
import { cronDueBetween, cronPrevOccurrence } from '../web/cron.js'

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
    expect(SRC).toMatch(/sendCatchUpSummary\(caughtUpThisTick, staleThisTick/)
  })

  it('stays silent on a tick that caught nothing up', () => {
    expect(SRC).toMatch(/if \(caughtUpThisTick\.length \|\| staleThisTick\.length\) \{/)
  })
})
