// A rate needs a clock, and dashboard.log has none.
//
// Card 0390aa37 asks how often the channel plugin drops. It could not be
// answered, and the reason is instructive: store/channels-failures.log turned
// out to hold the daily restart's config line, not plugin drops at all (a
// near-order-of-magnitude "improvement" was almost reported from it), while the
// real evidence sits in dashboard.log -- 332 MB, and its lines carry a TIME
// (`[17:30:25.451]`) but no DATE. Two days' events are indistinguishable, so
// there is no denominator and no rate.
//
// This log exists to be counted: one JSON line per event, a full ISO timestamp
// on every line, one file per day so a day's count is a `wc -l`, and a
// retention window so it cannot grow into the thing it replaces.

import { describe, it, expect } from 'vitest'
import {
  eventLogFileName,
  parseEventLogDate,
  isEventLogExpired,
  formatChannelEvent,
  summarizeByDay,
  CHANNEL_EVENT_RETENTION_DAYS,
  type ChannelEvent,
} from '../web/channel-event-log.js'

const T = Date.parse('2026-09-06T15:04:05.123Z')

describe('eventLogFileName', () => {
  it('names one file per UTC day', () => {
    expect(eventLogFileName(T)).toBe('channel-events-2026-09-06.log')
  })

  it('does not roll the file at local midnight -- the day boundary is UTC everywhere', () => {
    // 23:30 UTC is already the NEXT day in Budapest (UTC+2). A local-time
    // implementation would file this instant under 09-07 on this machine and
    // under 09-06 on a UTC host, which makes a daily count host-dependent --
    // exactly the ambiguity this log exists to remove. The earlier version of
    // this test used 21:30Z, where local and UTC agree, and a local-time
    // mutation survived it.
    expect(eventLogFileName(Date.parse('2026-09-06T23:30:00Z'))).toBe('channel-events-2026-09-06.log')
    expect(eventLogFileName(Date.parse('2026-09-07T00:00:00Z'))).toBe('channel-events-2026-09-07.log')
  })
})

describe('parseEventLogDate', () => {
  it('reads the day back out of a file name', () => {
    expect(parseEventLogDate('channel-events-2026-09-06.log')).toBe(Date.parse('2026-09-06T00:00:00Z'))
  })

  it('returns null for anything that is not one of ours', () => {
    expect(parseEventLogDate('dashboard.log')).toBeNull()
    expect(parseEventLogDate('channel-events-.log')).toBeNull()
    expect(parseEventLogDate('channel-events-2026-13-40.log')).toBeNull()
  })
})

describe('isEventLogExpired', () => {
  const now = Date.parse('2026-09-06T00:00:00Z')

  it('keeps a file inside the retention window', () => {
    expect(isEventLogExpired('channel-events-2026-09-01.log', now, CHANNEL_EVENT_RETENTION_DAYS)).toBe(false)
  })

  it('drops one past it', () => {
    const old = new Date(now - (CHANNEL_EVENT_RETENTION_DAYS + 1) * 86400_000).toISOString().slice(0, 10)
    expect(isEventLogExpired(`channel-events-${old}.log`, now, CHANNEL_EVENT_RETENTION_DAYS)).toBe(true)
  })

  it('keeps the file exactly on the boundary', () => {
    const edge = new Date(now - CHANNEL_EVENT_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10)
    expect(isEventLogExpired(`channel-events-${edge}.log`, now, CHANNEL_EVENT_RETENTION_DAYS)).toBe(false)
  })

  it('never deletes a file it cannot date -- an unreadable name is not evidence of age', () => {
    expect(isEventLogExpired('dashboard.log', now, CHANNEL_EVENT_RETENTION_DAYS)).toBe(false)
    expect(isEventLogExpired('channel-events-nonsense.log', now, CHANNEL_EVENT_RETENTION_DAYS)).toBe(false)
  })
})

describe('formatChannelEvent', () => {
  const event: ChannelEvent = { at: T, agent: 'finy', provider: 'telegram', event: 'down', detail: { failures: 2 } }

  it('writes one line of JSON carrying a full timestamp, not just a time', () => {
    const line = formatChannelEvent(event)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.includes('\n', 0)).toBe(true)
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['ts']).toBe('2026-09-06T15:04:05.123Z')
    expect(parsed['agent']).toBe('finy')
    expect(parsed['event']).toBe('down')
    expect(parsed['failures']).toBe(2)
  })

  it('keeps a multi-line detail on one line, so a line stays a record', () => {
    const line = formatChannelEvent({ ...event, detail: { note: 'first\nsecond' } })
    expect(line.split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(line)['note']).toBe('first\nsecond')
  })

  it('never lets a detail field overwrite the identity of the record', () => {
    const line = formatChannelEvent({ ...event, detail: { ts: 'yesterday', agent: 'someone-else' } })
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['ts']).toBe('2026-09-06T15:04:05.123Z')
    expect(parsed['agent']).toBe('finy')
  })
})

describe('summarizeByDay', () => {
  const lines = [
    formatChannelEvent({ at: Date.parse('2026-09-05T08:00:00Z'), agent: 'finy', provider: 'telegram', event: 'down' }),
    formatChannelEvent({ at: Date.parse('2026-09-05T09:00:00Z'), agent: 'finy', provider: 'telegram', event: 'restart' }),
    formatChannelEvent({ at: Date.parse('2026-09-05T10:00:00Z'), agent: 'disy', provider: 'telegram', event: 'down' }),
    formatChannelEvent({ at: Date.parse('2026-09-06T10:00:00Z'), agent: 'finy', provider: 'telegram', event: 'down' }),
  ].join('')

  it('counts events per day and per event kind -- the denominator the card was missing', () => {
    const summary = summarizeByDay(lines)
    expect(summary['2026-09-05']).toEqual({ down: 2, restart: 1 })
    expect(summary['2026-09-06']).toEqual({ down: 1 })
  })

  it('skips a corrupt line instead of losing what follows it', () => {
    // The corrupt line goes in the MIDDLE on purpose: appended at the end, an
    // implementation that ABORTS on the first parse error still returns every
    // earlier day and the test passes for the wrong reason.
    const parts = lines.split('\n').filter(Boolean).map(l => `${l}\n`)
    const withGarbage = [parts[0], 'not json\n', ...parts.slice(1)].join('')
    const summary = summarizeByDay(withGarbage)
    expect(summary['2026-09-05']).toEqual({ down: 2, restart: 1 })
    expect(summary['2026-09-06']).toEqual({ down: 1 })
  })
})
