/**
 * fb79dc1f: the reminder send windows (src/reminder-window.ts). The example window
 * below: quiet 23:00-07:00 Europe/Budapest; a
 * weekend reminder slides to Monday 09:00 Budapest unless it is flagged
 * (allow_weekend: the recipient asked for that weekend time, or it is urgent /
 * money / an external party); the quiet hours stand either way. 09:00 is
 * Budapest wall time, so it is 07:00Z in summer time and 08:00Z after the
 * 2026-10-25 change to CET.
 */
import { describe, it, expect } from 'vitest'
import { nextAllowedMs, allowedAt, parseReminderWindows, zonedToUtcMs, localParts, type ReminderWindow } from '../reminder-window.js'

const OWNER: ReminderWindow = {
  tz: 'Europe/Budapest',
  quiet: { start: '23:00', end: '07:00' },
  weekend: { days: ['sat', 'sun'], resume: { day: 'mon', at: '09:00' } },
}

const z = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

describe('nextAllowedMs: the owner window', () => {
  it('a weekday afternoon goes at its moment', () => {
    // Wednesday 2026-10-07 17:00 Budapest (CEST)
    expect(iso(nextAllowedMs(z('2026-10-07T15:00:00Z'), OWNER))).toBe('2026-10-07T15:00:00Z')
  })

  it('a weekday 23:30 Budapest waits for 07:00 the next morning', () => {
    expect(iso(nextAllowedMs(z('2026-10-07T21:30:00Z'), OWNER))).toBe('2026-10-08T05:00:00Z')
  })

  it('a weekday 05:00 Budapest waits for 07:00 the same morning', () => {
    expect(iso(nextAllowedMs(z('2026-10-08T03:00:00Z'), OWNER))).toBe('2026-10-08T05:00:00Z')
  })

  it('07:00 Budapest itself is allowed, 06:59 is not', () => {
    expect(allowedAt(z('2026-10-08T05:00:00Z'), OWNER)).toBe(true)
    expect(allowedAt(z('2026-10-08T04:59:00Z'), OWNER)).toBe(false)
    expect(allowedAt(z('2026-10-07T20:59:00Z'), OWNER)).toBe(true)  // 22:59
    expect(allowedAt(z('2026-10-07T21:00:00Z'), OWNER)).toBe(false) // 23:00
  })

  it('SATURDAY 10:00 Budapest slides to Monday 09:00 Budapest', () => {
    expect(iso(nextAllowedMs(z('2026-10-10T08:00:00Z'), OWNER))).toBe('2026-10-12T07:00:00Z')
  })

  it('SUNDAY 22:00 Budapest slides to Monday 09:00 Budapest', () => {
    expect(iso(nextAllowedMs(z('2026-10-11T20:00:00Z'), OWNER))).toBe('2026-10-12T07:00:00Z')
  })

  it('Friday 23:30 Budapest: the quiet end falls on Saturday, so it goes Monday 09:00', () => {
    expect(iso(nextAllowedMs(z('2026-10-09T21:30:00Z'), OWNER))).toBe('2026-10-12T07:00:00Z')
  })

  it('Monday 06:00 Budapest is quiet, not weekend: 07:00', () => {
    expect(iso(nextAllowedMs(z('2026-10-12T04:00:00Z'), OWNER))).toBe('2026-10-12T05:00:00Z')
  })

  it('FLAGGED (allow_weekend): Saturday 10:00 Budapest goes at its moment', () => {
    expect(iso(nextAllowedMs(z('2026-10-10T08:00:00Z'), OWNER, true))).toBe('2026-10-10T08:00:00Z')
  })

  it('FLAGGED: the quiet hours still stand (Saturday 23:30 -> Sunday 07:00 Budapest)', () => {
    expect(iso(nextAllowedMs(z('2026-10-10T21:30:00Z'), OWNER, true))).toBe('2026-10-11T05:00:00Z')
  })
})

describe('nextAllowedMs: around the 2026-10-25 change to CET', () => {
  it('Saturday 2026-10-24 10:00 CEST -> Monday 2026-10-26 09:00 CET = 08:00Z (not 07:00Z)', () => {
    expect(iso(nextAllowedMs(z('2026-10-24T08:00:00Z'), OWNER))).toBe('2026-10-26T08:00:00Z')
  })

  it('FLAGGED Saturday 2026-10-24 23:30 CEST -> Sunday 07:00 CET = 06:00Z', () => {
    expect(iso(nextAllowedMs(z('2026-10-24T21:30:00Z'), OWNER, true))).toBe('2026-10-25T06:00:00Z')
  })

  it('Sunday night of the change (03:30 CET): Monday 09:00 CET', () => {
    expect(iso(nextAllowedMs(z('2026-10-25T02:30:00Z'), OWNER))).toBe('2026-10-26T08:00:00Z')
  })

  it('the spring change: Saturday 2027-03-27 12:00 CET -> Monday 2027-03-29 09:00 CEST = 07:00Z', () => {
    expect(iso(nextAllowedMs(z('2027-03-27T11:00:00Z'), OWNER))).toBe('2027-03-29T07:00:00Z')
  })
})

describe('zonedToUtcMs', () => {
  it('summer and winter time', () => {
    expect(iso(zonedToUtcMs(2026, 10, 12, 9, 0, 'Europe/Budapest'))).toBe('2026-10-12T07:00:00Z')
    expect(iso(zonedToUtcMs(2026, 10, 26, 9, 0, 'Europe/Budapest'))).toBe('2026-10-26T08:00:00Z')
  })

  it('a wall time in the spring gap maps to the first minute after it', () => {
    // 2027-03-28 02:30 does not exist in Budapest (02:00 CET -> 03:00 CEST)
    expect(iso(zonedToUtcMs(2027, 3, 28, 2, 30, 'Europe/Budapest'))).toBe('2027-03-28T01:00:00Z')
  })

  it('a wall time of the fall-back hour maps to its earlier occurrence', () => {
    // 2026-10-25 02:30 happens at 00:30Z (CEST) and at 01:30Z (CET)
    expect(iso(zonedToUtcMs(2026, 10, 25, 2, 30, 'Europe/Budapest'))).toBe('2026-10-25T00:30:00Z')
  })

  it('localParts reads the weekday in the zone, not in UTC', () => {
    // Sunday 23:30Z is already Monday 01:30 in Budapest (CEST)
    expect(localParts(z('2026-10-11T23:30:00Z'), 'Europe/Budapest').wd).toBe('mon')
  })
})

describe('no window, other windows', () => {
  it('no window: every moment is allowed', () => {
    expect(nextAllowedMs(z('2026-10-10T21:30:00Z'), undefined)).toBe(z('2026-10-10T21:30:00Z'))
    expect(allowedAt(z('2026-10-10T21:30:00Z'), undefined)).toBe(true)
  })

  it('a quiet window that does not wrap midnight (12:00-13:00)', () => {
    const lunch: ReminderWindow = { tz: 'Europe/Budapest', quiet: { start: '12:00', end: '13:00' } }
    expect(iso(nextAllowedMs(z('2026-10-07T10:30:00Z'), lunch))).toBe('2026-10-07T11:00:00Z') // 12:30 -> 13:00 CEST
    expect(allowedAt(z('2026-10-07T11:00:00Z'), lunch)).toBe(true)
  })
})

describe('parseReminderWindows (fail-closed)', () => {
  const good = { recipients: { '1234567': OWNER, '-100200300': { tz: 'Europe/Budapest' } } }

  it('reads a valid config', () => {
    const p = parseReminderWindows(JSON.stringify(good))
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.config.recipients['1234567'].weekend?.resume).toEqual({ day: 'mon', at: '09:00' })
  })

  it.each([
    ['not JSON', '{'],
    ['no recipients', JSON.stringify({})],
    ['a bad chat id key', JSON.stringify({ recipients: { 'abc': OWNER } })],
    ['a bad zone', JSON.stringify({ recipients: { '1': { ...OWNER, tz: 'Mars/Olympus' } } })],
    ['a bad hour', JSON.stringify({ recipients: { '1': { ...OWNER, quiet: { start: '24:00', end: '07:00' } } } })],
    ['equal quiet bounds', JSON.stringify({ recipients: { '1': { ...OWNER, quiet: { start: '07:00', end: '07:00' } } } })],
    ['an unknown weekday', JSON.stringify({ recipients: { '1': { ...OWNER, weekend: { days: ['sat', 'xyz'], resume: { day: 'mon', at: '09:00' } } } } })],
    ['a resume day that is itself a weekend day', JSON.stringify({ recipients: { '1': { ...OWNER, weekend: { days: ['sat', 'sun'], resume: { day: 'sun', at: '09:00' } } } } })],
    ['seven weekend days', JSON.stringify({ recipients: { '1': { ...OWNER, weekend: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], resume: { day: 'mon', at: '09:00' } } } } })],
  ])('refuses %s', (_name, raw) => {
    expect(parseReminderWindows(raw).ok).toBe(false)
  })
})
