import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIME_ZONE,
  buildCalendarViewQuery,
  buildEventPayload,
  createEvent,
  deniedInvitees,
  readInviteAllowlist,
  toAttendeeList,
  updateEvent,
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

// PR #2983 review (Dani B4, Geri note 1): the invite allowlist is checked in the
// library, so createEvent and updateEvent refuse an unlisted guest for EVERY
// caller, before any request (the token mint included).
describe('invite allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invite-allowlist-'))
  const list = (body: string) => {
    const p = join(dir, `l${Math.random()}.json`)
    writeFileSync(p, body)
    return p
  }
  afterEach(() => vi.unstubAllGlobals())

  it('reads the addresses lower-cased', () => {
    expect([...readInviteAllowlist(list('{"addresses":[{"address":"A@B.hu"},{"address":" c@d.hu ","note":"x"}]}'))])
      .toEqual(['a@b.hu', 'c@d.hu'])
  })
  it('a missing, unparsable or mis-shaped list allows nobody', () => {
    for (const p of [join(dir, 'missing.json'), list('{'), list('{"addresses":"a@b.hu"}'),
      list('{"addresses":[{"address":"a@b.hu"},{"note":"no address"}]}'), list('{"addresses":[{"address":""}]}')]) {
      expect(readInviteAllowlist(p).size, p).toBe(0)
    }
  })
  it('names the unlisted guests as they would be sent, in every input form', () => {
    const allowed = new Set(['a@b.hu'])
    expect(deniedInvitees(['A@B.hu', ' x@y.hu '], allowed)).toEqual(['x@y.hu'])
    expect(deniedInvitees([{ address: 'z@y.hu', optional: true }, { address: 'a@b.hu' }], allowed)).toEqual(['z@y.hu'])
    expect(deniedInvitees([], allowed)).toEqual([])
  })
  it('createEvent and updateEvent refuse an unlisted guest before any request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // This checkout has no store/calendar-invite-allowlist.json, so the list is empty: nobody.
    await expect(createEvent({ subject: 's', start: '2026-10-16T09:00', end: '2026-10-16T09:30', attendees: ['x@y.hu'] }))
      .rejects.toThrowError(/meghivo megtagadva.*x@y\.hu/)
    await expect(updateEvent('ev1', { attendees: [{ address: 'x@y.hu' }] })).rejects.toThrowError(/meghivo megtagadva/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
