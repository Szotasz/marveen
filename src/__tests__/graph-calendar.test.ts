import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TIME_ZONE,
  buildCalendarViewQuery,
  buildEventPayload,
  toAttendeeList,
} from '../graph-calendar.js'

// The network paths (token mint, Graph calls) are exercised out of band
// against the live tenant. What is pinned here is everything that decides WHAT
// gets sent: the time zone that travels with every timestamp, the attendee
// normalisation, and the calendarView window. Each of these fails silently in
// production -- a wrong zone puts the meeting an hour off, a dropped attendee
// simply does not get invited, and a missing window bound returns the series
// master instead of its occurrences.

describe('buildEventPayload', () => {
  const base = { subject: 'Egyeztetes', start: '2026-10-16T09:00:00', end: '2026-10-16T09:30:00' }

  it('attaches the Budapest zone to both ends when none is given', () => {
    const p = buildEventPayload(base) as { start: { timeZone: string }; end: { timeZone: string } }
    expect(p.start.timeZone).toBe(DEFAULT_TIME_ZONE)
    expect(p.end.timeZone).toBe(DEFAULT_TIME_ZONE)
  })

  it('honours an explicit zone', () => {
    const p = buildEventPayload({ ...base, timeZone: 'UTC' }) as { start: { timeZone: string } }
    expect(p.start.timeZone).toBe('UTC')
  })

  it('sends Text body by default and HTML on request', () => {
    expect((buildEventPayload({ ...base, body: 'x' }) as { body: { contentType: string } }).body.contentType).toBe(
      'Text',
    )
    expect(
      (buildEventPayload({ ...base, body: 'x', isHtml: true }) as { body: { contentType: string } }).body.contentType,
    ).toBe('HTML')
  })

  it('omits every field the caller did not set, so a PATCH stays partial', () => {
    const p = buildEventPayload({ subject: 'csak a cim' })
    expect(Object.keys(p)).toEqual(['subject'])
  })

  it('adds the Teams provider only when an online meeting is asked for', () => {
    expect(buildEventPayload({ ...base, isOnlineMeeting: true }).onlineMeetingProvider).toBe('teamsForBusiness')
    expect(buildEventPayload({ ...base, isOnlineMeeting: false }).onlineMeetingProvider).toBeUndefined()
    expect('isOnlineMeeting' in buildEventPayload(base)).toBe(false)
  })
})

describe('toAttendeeList', () => {
  it('accepts a bare address', () => {
    expect(toAttendeeList(['colleague@example.com'])).toEqual([
      { emailAddress: { address: 'colleague@example.com' }, type: 'required' },
    ])
  })

  it('keeps the display name when one is given', () => {
    expect(toAttendeeList([{ address: 'a@b.hu', name: 'Adam' }])[0].emailAddress).toEqual({
      address: 'a@b.hu',
      name: 'Adam',
    })
  })

  it('marks optional attendees', () => {
    expect(toAttendeeList([{ address: 'a@b.hu', optional: true }])[0].type).toBe('optional')
  })

  it('trims and drops empties instead of inviting a blank address', () => {
    expect(toAttendeeList([' a@b.hu ', '', '   '])).toEqual([
      { emailAddress: { address: 'a@b.hu' }, type: 'required' },
    ])
  })

  it('returns an empty list for undefined', () => {
    expect(toAttendeeList(undefined)).toEqual([])
  })
})

describe('buildCalendarViewQuery', () => {
  const win = { start: '2026-10-16T00:00:00', end: '2026-10-17T00:00:00' }

  it('carries both window bounds, which is what expands a recurring series', () => {
    const q = new URLSearchParams(buildCalendarViewQuery(win))
    expect(q.get('startDateTime')).toBe(win.start)
    expect(q.get('endDateTime')).toBe(win.end)
  })

  it('defaults to 50 and clamps into 1..250', () => {
    expect(new URLSearchParams(buildCalendarViewQuery(win)).get('$top')).toBe('50')
    expect(new URLSearchParams(buildCalendarViewQuery({ ...win, top: 0 })).get('$top')).toBe('1')
    expect(new URLSearchParams(buildCalendarViewQuery({ ...win, top: 9999 })).get('$top')).toBe('250')
  })

  it('orders by start time so the caller can read the day top to bottom', () => {
    expect(new URLSearchParams(buildCalendarViewQuery(win)).get('$orderby')).toBe('start/dateTime')
  })
})
