import { describe, it, expect, vi } from 'vitest'

// Pin the install zone: APP_TZ otherwise follows the host zone.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  APP_TZ: 'Europe/Budapest',
}))

import { parseDateExpr, rangeToTs, toBudapestTs } from '../date-range.js'
import { parseDateExpression } from '../web/routes/recall.js'

// All instants are UTC; the install zone is Europe/Budapest (config.APP_TZ).
const utc = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000)

// Tuesday 2026-05-19 12:00 local (CEST)
const TUE = utc('2026-05-19T10:00:00Z')

describe('parseDateExpr (pinned now)', () => {
  it('today', () => {
    expect(parseDateExpr('ma', TUE)).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    expect(parseDateExpr('today', TUE)).toEqual({ from: '2026-05-19', to: '2026-05-19' })
  })

  it('yesterday', () => {
    expect(parseDateExpr('tegnap', TUE)).toEqual({ from: '2026-05-18', to: '2026-05-18' })
    expect(parseDateExpr('yesterday', TUE)).toEqual({ from: '2026-05-18', to: '2026-05-18' })
  })

  it('last week is the previous Monday-Sunday', () => {
    expect(parseDateExpr('múlt héten', TUE)).toEqual({ from: '2026-05-11', to: '2026-05-17' })
    expect(parseDateExpr('last week', TUE)).toEqual({ from: '2026-05-11', to: '2026-05-17' })
  })

  it('explicit day and range', () => {
    expect(parseDateExpr('2026-10-25', TUE)).toEqual({ from: '2026-10-25', to: '2026-10-25' })
    expect(parseDateExpr('2026-10-20 - 2026-10-25', TUE)).toEqual({ from: '2026-10-20', to: '2026-10-25' })
  })

  it('unknown expression is null', () => {
    expect(parseDateExpr('valamikor', TUE)).toBeNull()
  })

  it('recall keeps exporting the parser under its old name', () => {
    expect(parseDateExpression).toBe(parseDateExpr)
  })
})

describe('install-zone day boundaries', () => {
  it('00:30 local time is still the new local day, not the previous UTC day', () => {
    // 2026-05-19 00:30 CEST == 2026-05-18T22:30Z
    const now = utc('2026-05-18T22:30:00Z')
    expect(parseDateExpr('ma', now)).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    expect(parseDateExpr('tegnap', now)).toEqual({ from: '2026-05-18', to: '2026-05-18' })
  })

  it('23:30 local time is still the same local day', () => {
    // 2026-05-19 23:30 CEST == 2026-05-19T21:30Z
    expect(parseDateExpr('ma', utc('2026-05-19T21:30:00Z'))).toEqual({ from: '2026-05-19', to: '2026-05-19' })
  })

  it('2026-10-25 (DST ends) spans 25 hours', () => {
    const { fromTs, toTs } = rangeToTs({ from: '2026-10-25', to: '2026-10-25' })
    expect(fromTs).toBe(utc('2026-10-24T22:00:00Z'))  // 00:00 CEST
    expect(toTs).toBe(utc('2026-10-25T22:59:59Z'))    // 23:59:59 CET
    expect(toTs - fromTs + 1).toBe(25 * 3600)
  })

  it('2026-03-29 (DST starts) spans 23 hours', () => {
    const { fromTs, toTs } = rangeToTs({ from: '2026-03-29', to: '2026-03-29' })
    expect(fromTs).toBe(utc('2026-03-28T23:00:00Z'))  // 00:00 CET
    expect(toTs).toBe(utc('2026-03-29T21:59:59Z'))    // 23:59:59 CEST
    expect(toTs - fromTs + 1).toBe(23 * 3600)
  })

  it('on the DST day, 00:30 local and 02:30 local both resolve to 2026-10-25', () => {
    // 00:30 CEST = 22:30Z (24th); 02:30 CEST = 00:30Z; 02:30 CET (second pass) = 01:30Z
    for (const iso of ['2026-10-24T22:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      expect(parseDateExpr('ma', utc(iso))).toEqual({ from: '2026-10-25', to: '2026-10-25' })
    }
    // 00:30 CET on the 26th = 23:30Z on the 25th
    expect(parseDateExpr('ma', utc('2026-10-25T23:30:00Z'))).toEqual({ from: '2026-10-26', to: '2026-10-26' })
  })

  it('the day bounds of consecutive days are contiguous', () => {
    const a = toBudapestTs('2026-10-25', true)
    const b = toBudapestTs('2026-10-26', false)
    expect(b - a).toBe(1)
  })
})
