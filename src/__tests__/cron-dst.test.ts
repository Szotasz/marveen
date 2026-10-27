import { describe, it, expect } from 'vitest'
import { CronExpressionParser } from 'cron-parser'
import {
  cronPrevOccurrence,
  isWallClockAnchored,
  tzOffsetMinutes,
  naiveWallMs,
} from '../web/cron.js'
import { checkHeartbeatDigestGaps, type GapGuardDeps } from '../web/heartbeat-direct-digest.js'

// Card 59458fb6: the runner fired an anchored cron ("7 2 * * *") twice in the
// autumn repeated hour (2026-10-25) and skipped it on the spring day
// (2027-03-28). All tests pass the zone explicitly, never via the process TZ.
// simulate() mimics the runner: contiguous (from, to] windows, one call each.

const TZ = 'Europe/Budapest'
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (utc: string) => Date.parse(utc)

function simulate(cron: string, startIso: string, endIso: string, stepMs = 15_000, tz = TZ): string[] {
  const fired: string[] = []
  let from = ms(startIso)
  const end = ms(endIso)
  while (from < end) {
    const to = Math.min(from + stepMs, end)
    const occ = cronPrevOccurrence(cron, from, to, tz)
    if (occ != null) fired.push(iso(occ))
    from = to
  }
  return fired
}

// The pre-fix implementation, verbatim, as the AC7 reference.
function legacyCronPrevOccurrence(cron: string, fromMs: number, toMs: number, tz: string): number | null {
  try {
    const expr = CronExpressionParser.parse(cron, { tz, currentDate: new Date(toMs + 1) })
    const prev = expr.prev().getTime()
    return prev > fromMs ? prev : null
  } catch {
    return null
  }
}

function simulateLegacy(cron: string, startIso: string, endIso: string, stepMs = 15_000): Array<number | null> {
  const out: Array<number | null> = []
  let from = ms(startIso)
  const end = ms(endIso)
  while (from < end) {
    const to = Math.min(from + stepMs, end)
    out.push(legacyCronPrevOccurrence(cron, from, to, TZ))
    from = to
  }
  return out
}

function simulateNew(cron: string, startIso: string, endIso: string, stepMs = 15_000): Array<number | null> {
  const out: Array<number | null> = []
  let from = ms(startIso)
  const end = ms(endIso)
  while (from < end) {
    const to = Math.min(from + stepMs, end)
    out.push(cronPrevOccurrence(cron, from, to, TZ))
    from = to
  }
  return out
}

const AUTUMN_START = '2026-10-24T23:00:00Z'
const AUTUMN_END = '2026-10-25T03:00:00Z'
const SPRING_START = '2027-03-27T23:00:00Z'
const SPRING_END = '2027-03-28T03:00:00Z'

describe('zone helpers', () => {
  it('reads the Budapest offset on both sides of both transitions', () => {
    expect(tzOffsetMinutes(ms('2026-10-25T00:59:59Z'), TZ)).toBe(120)
    expect(tzOffsetMinutes(ms('2026-10-25T01:00:00Z'), TZ)).toBe(60)
    expect(tzOffsetMinutes(ms('2027-03-28T00:59:59Z'), TZ)).toBe(60)
    expect(tzOffsetMinutes(ms('2027-03-28T01:00:00Z'), TZ)).toBe(120)
    expect(tzOffsetMinutes(ms('2026-07-15T12:00:00Z'), 'UTC')).toBe(0)
  })

  it('naiveWallMs gives the local reading as if it were UTC', () => {
    expect(iso(naiveWallMs(ms('2026-07-15T05:30:00Z'), TZ))).toBe('2026-07-15T07:30:00.000Z')
  })

  it('isWallClockAnchored: fixed hours are anchored, all-24-hour crons are not', () => {
    expect(isWallClockAnchored('7 2 * * *')).toBe(true)
    expect(isWallClockAnchored('*/30 2 * * *')).toBe(true)
    expect(isWallClockAnchored('0 */2 * * *')).toBe(true)
    expect(isWallClockAnchored('@daily')).toBe(true)
    expect(isWallClockAnchored('*/30 * * * *')).toBe(false)
    expect(isWallClockAnchored('0 * * * *')).toBe(false)
    expect(isWallClockAnchored('@hourly')).toBe(false)
    expect(isWallClockAnchored('not a cron')).toBe(false)
  })
})

describe('cron-parser prev() baseline around 2027-03-28 (measured, not assumed)', () => {
  const prevs = (cron: string, fromIso: string, n: number) => {
    const e = CronExpressionParser.parse(cron, { tz: TZ, currentDate: new Date(ms(fromIso) + 1) })
    return Array.from({ length: n }, () => iso(e.prev().getTime()))
  }

  it('"30 2,3 * * *": only the real 03:30 CEST slot exists that day; the missing 02:30 yields no instant', () => {
    expect(prevs('30 2,3 * * *', '2027-03-28T03:00:00Z', 2)).toEqual([
      '2027-03-28T01:30:00.000Z',
      '2027-03-27T02:30:00.000Z',
    ])
  })

  it('"*/30 2 * * *": no instant at all on the spring day (the day before is the newest)', () => {
    expect(prevs('*/30 2 * * *', '2027-03-28T03:00:00Z', 2)).toEqual([
      '2027-03-27T01:30:00.000Z',
      '2027-03-27T01:00:00.000Z',
    ])
  })

  it('"*/30 2 * * *" in autumn: prev() itself lists all four real instants (the dedup is ours)', () => {
    expect(prevs('*/30 2 * * *', '2026-10-25T03:00:00Z', 4)).toEqual([
      '2026-10-25T01:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T00:00:00.000Z',
    ])
  })
})

describe('AC1: autumn, anchored crons fire exactly once, at the first pass', () => {
  it('7 2 * * *', () => {
    expect(simulate('7 2 * * *', AUTUMN_START, AUTUMN_END)).toEqual(['2026-10-25T00:07:00.000Z'])
  })
  it('0 2 * * *', () => {
    expect(simulate('0 2 * * *', AUTUMN_START, AUTUMN_END)).toEqual(['2026-10-25T00:00:00.000Z'])
  })
  it('30 2 * * *', () => {
    expect(simulate('30 2 * * *', AUTUMN_START, AUTUMN_END)).toEqual(['2026-10-25T00:30:00.000Z'])
  })
  it('*/30 2 * * * keeps its two slots once each (no second-pass repeat)', () => {
    expect(simulate('*/30 2 * * *', AUTUMN_START, AUTUMN_END)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
    ])
  })
  it('30 2,3 * * *: 02:30 once, then 03:30 CET (a distinct, real slot)', () => {
    expect(simulate('30 2,3 * * *', AUTUMN_START, AUTUMN_END)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T02:30:00.000Z',
    ])
  })
})

describe('AC2: autumn, interval crons fire at every real instant', () => {
  it('*/30 * * * * fires 00:00, 00:30, 01:00, 01:30Z, no repeats', () => {
    const fired = simulate('*/30 * * * *', AUTUMN_START, AUTUMN_END)
    expect(new Set(fired).size).toBe(fired.length)
    expect(fired.filter((t) => t >= '2026-10-25T00:00:00.000Z' && t <= '2026-10-25T01:30:00.000Z')).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:30:00.000Z',
    ])
  })
  it('0 * * * * fires every real hour, including both 02:00 passes', () => {
    expect(simulate('0 * * * *', AUTUMN_START, AUTUMN_END)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
    ])
  })
})

describe('AC3: spring, a slot in the skipped hour fires once at the transition', () => {
  it('30 2 * * *', () => {
    expect(simulate('30 2 * * *', SPRING_START, SPRING_END)).toEqual(['2027-03-28T01:00:00.000Z'])
  })
  it('0 2 * * *', () => {
    expect(simulate('0 2 * * *', SPRING_START, SPRING_END)).toEqual(['2027-03-28T01:00:00.000Z'])
  })
  it('30 2,3 * * *: the make-up at 01:00Z and the real 03:30 CEST slot at 01:30Z', () => {
    expect(simulate('30 2,3 * * *', SPRING_START, SPRING_END)).toEqual([
      '2027-03-28T01:00:00.000Z',
      '2027-03-28T01:30:00.000Z',
    ])
  })
  it('0 3 * * * fires once at 03:00 CEST (the transition instant), no extra make-up', () => {
    expect(simulate('0 3 * * *', SPRING_START, SPRING_END)).toEqual(['2027-03-28T01:00:00.000Z'])
  })
  it('*/30 2 * * * makes up once, not once per skipped slot', () => {
    expect(simulate('*/30 2 * * *', SPRING_START, SPRING_END)).toEqual(['2027-03-28T01:00:00.000Z'])
  })
  it('a skipped-hour slot on a day the cron does not run (day-of-week) is not made up', () => {
    // 2027-03-28 is a Sunday; "30 2 * * 1-5" must stay silent that day.
    expect(simulate('30 2 * * 1-5', SPRING_START, SPRING_END)).toEqual([])
  })
})

describe('AC4: spring, interval crons are not made up', () => {
  it('*/30 * * * * goes 00:30Z, 01:00Z, 01:30Z without doubles', () => {
    expect(simulate('*/30 * * * *', SPRING_START, SPRING_END)).toEqual([
      '2027-03-27T23:30:00.000Z',
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T00:30:00.000Z',
      '2027-03-28T01:00:00.000Z',
      '2027-03-28T01:30:00.000Z',
      '2027-03-28T02:00:00.000Z',
      '2027-03-28T02:30:00.000Z',
      '2027-03-28T03:00:00.000Z',
    ])
  })
})

describe('AC5: restart inside the autumn repeated hour does not re-fire', () => {
  it('with a persisted liveness stamp (window starts at the stamp)', () => {
    expect(simulate('7 2 * * *', '2026-10-25T01:19:00Z', '2026-10-25T02:30:00Z')).toEqual([])
  })
  it('cold start without a stamp (30 minute lookback); first pass already behind it', () => {
    expect(simulate('7 2 * * *', '2026-10-25T00:50:00Z', '2026-10-25T02:30:00Z')).toEqual([])
  })
  it('a restart BEFORE the first pass still fires it once', () => {
    expect(simulate('7 2 * * *', '2026-10-24T23:50:00Z', '2026-10-25T02:30:00Z')).toEqual(['2026-10-25T00:07:00.000Z'])
  })
})

describe('AC6: a window covering both passes yields the first pass instant once', () => {
  it('7 2 * * *', () => {
    expect(cronPrevOccurrence('7 2 * * *', ms('2026-10-24T23:50:00Z'), ms('2026-10-25T02:00:00Z'), TZ)).toBe(
      ms('2026-10-25T00:07:00Z'),
    )
  })
  it('a dropped second pass does not hide an older valid slot in the window', () => {
    // Window (00:35Z, 01:35Z]: 01:30Z is the second pass of 02:30 (first pass 00:30Z, behind the window),
    // but 00:40Z (02:40 CEST) is a genuine first-pass slot inside it.
    expect(cronPrevOccurrence('30,40 2 * * *', ms('2026-10-25T00:35:00Z'), ms('2026-10-25T01:35:00Z'), TZ)).toBe(
      ms('2026-10-25T00:40:00Z'),
    )
  })
  it('a lone dropped second pass returns null', () => {
    expect(cronPrevOccurrence('30 2 * * *', ms('2026-10-25T00:40:00Z'), ms('2026-10-25T01:40:00Z'), TZ)).toBeNull()
  })
  it('the window edges stay half-open on the first pass instant', () => {
    expect(cronPrevOccurrence('7 2 * * *', ms('2026-10-25T00:07:00Z') - 1, ms('2026-10-25T00:07:00Z'), TZ)).toBe(
      ms('2026-10-25T00:07:00Z'),
    )
    expect(cronPrevOccurrence('7 2 * * *', ms('2026-10-25T00:07:00Z'), ms('2026-10-25T00:08:00Z'), TZ)).toBeNull()
  })
})

describe('AC7: ordinary days are bit-identical to the old implementation', () => {
  const crons = ['30 7 * * *', '7 2 * * *', '*/30 * * * *', '0 * * * *', '0 9-22 * * *', '*/15 8-18 * * 1-5']
  for (const day of ['2026-07-15', '2026-10-26']) {
    for (const cron of crons) {
      it(`${cron} on ${day}, 15s ticks over 24h`, () => {
        const start = `${day}T00:00:00Z`
        const end = iso(ms(start) + 24 * 3600_000)
        expect(simulateNew(cron, start, end)).toEqual(simulateLegacy(cron, start, end))
      }, 60_000)
    }
  }

  it('interval crons are unchanged even on the transition days', () => {
    for (const [start, end] of [
      [AUTUMN_START, '2026-10-26T00:00:00Z'],
      [SPRING_START, '2027-03-29T00:00:00Z'],
    ]) {
      for (const cron of ['*/30 * * * *', '0 * * * *', '*/15 * * * *']) {
        expect(simulateNew(cron, start, end)).toEqual(simulateLegacy(cron, start, end))
      }
    }
  }, 60_000)

  it('anchored crons away from the transition hour are unchanged on the transition days', () => {
    for (const [start, end] of [
      [AUTUMN_START, '2026-10-26T00:00:00Z'],
      [SPRING_START, '2027-03-29T00:00:00Z'],
    ]) {
      for (const cron of ['30 7 * * *', '0 12 * * *', '0 3 * * *', '0 1 * * *']) {
        expect(simulateNew(cron, start, end)).toEqual(simulateLegacy(cron, start, end))
      }
    }
  }, 60_000)

  it('other zones: UTC (no DST) matches the old implementation', () => {
    const start = '2026-10-25T00:00:00Z'
    const end = '2026-10-26T00:00:00Z'
    let from = ms(start)
    while (from < ms(end)) {
      const to = from + 60_000
      expect(cronPrevOccurrence('7 2 * * *', from, to, 'UTC')).toBe(legacyCronPrevOccurrence('7 2 * * *', from, to, 'UTC'))
      from = to
    }
  })

  it('an unparseable cron still yields null', () => {
    expect(cronPrevOccurrence('definitely not cron', 0, 1000, TZ)).toBeNull()
    expect(cronPrevOccurrence('definitely not cron', ms('2026-10-25T00:00:00Z'), ms('2026-10-25T01:30:00Z'), TZ)).toBeNull()
  })
})

describe('AC8: the digest gap guard does not report the dropped second pass', () => {
  const task = [{ name: 'dream-digest', agent: 'brainy', schedule: '7 2 * * *' }]
  const FIRST_PASS = ms('2026-10-25T00:07:00Z')

  function deps(digestAtMs: number | null): { deps: GapGuardDeps; notes: string[] } {
    const notes: string[] = []
    const d: GapGuardDeps = {
      prevOccurrence: (s, f, t) => cronPrevOccurrence(s, f, t, TZ),
      digestSince: (_agent, since) => digestAtMs != null && digestAtMs >= since,
      noteExists: () => false,
      sendNote: (c) => { notes.push(c) },
      slotLabel: (m) => iso(m),
    }
    return { deps: d, notes }
  }

  it('digest sent after the first pass: no [HB-HIANY] when the guard looks past the second pass', () => {
    const g = deps(FIRST_PASS + 60_000)
    expect(checkHeartbeatDigestGaps(task, ms('2026-10-25T01:30:00Z'), g.deps)).toEqual([])
    expect(g.notes).toEqual([])
  })

  it('digest sent after the first pass: nothing either while the first pass is the slot', () => {
    const g = deps(FIRST_PASS + 60_000)
    expect(checkHeartbeatDigestGaps(task, ms('2026-10-25T00:30:00Z'), g.deps)).toEqual([])
  })

  it('NEGATIVE CONTROL: a first pass with no digest is still reported once, for the first-pass slot', () => {
    const g = deps(null)
    const sent = checkHeartbeatDigestGaps(task, ms('2026-10-25T00:30:00Z'), g.deps)
    expect(sent).toEqual([`[HB-HIANY] task=dream-digest slot=${iso(FIRST_PASS)}`])
  })
})
