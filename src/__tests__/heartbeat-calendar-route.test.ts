import { describe, it, expect, vi, beforeEach } from 'vitest'

// 5E0A32B0: the route the metrics instrument reads the calendar from. The
// load-bearing contract: BOTH end-states are HTTP 200 with a distinguishing
// payload -- {ok:true, events} vs {ok:false, error} -- so "no events" and
// "could not query" can never collapse into the same look. (The agent-side
// era collapsed them, and one failure line fossilized for a day.)

const getCalendarEvents = vi.fn()

vi.mock('../google-api.js', () => ({
  getCalendarEvents: (...a: unknown[]) => getCalendarEvents(...a),
}))
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, HEARTBEAT_CALENDAR_ID: 'owner@example.com' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { tryHandleHeartbeat } = await import('../web/routes/heartbeat.js')

async function get(): Promise<{ status: number; json: any }> {
  let status = 200
  let body = ''
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  const handled = await tryHandleHeartbeat({
    req: {} as any, res, path: '/api/heartbeat/calendar', method: 'GET',
    url: new URL('http://localhost/api/heartbeat/calendar'),
  } as any)
  expect(handled).toBe(true)
  return { status, json: body ? JSON.parse(body) : null }
}

beforeEach(() => { getCalendarEvents.mockReset() })

describe('GET /api/heartbeat/calendar', () => {
  it('returns ok:true with slimmed events, cancelled ones filtered', async () => {
    getCalendarEvents.mockResolvedValue([
      { id: '1', summary: 'Meeting', start: { dateTime: '2026-09-03T14:30:00+02:00' }, end: { dateTime: '2026-09-03T15:00:00+02:00' }, attendees: [{ email: 'a@b.c' }, { email: 'd@e.f' }] },
      { id: '2', summary: 'Cancelled thing', status: 'cancelled', start: { dateTime: '2026-09-03T15:00:00+02:00' } },
    ])
    const { status, json } = await get()
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.events).toHaveLength(1)
    expect(json.events[0]).toEqual({
      start: { dateTime: '2026-09-03T14:30:00+02:00' },
      end: { dateTime: '2026-09-03T15:00:00+02:00' },
      summary: 'Meeting',
      attendees: 2,
    })
  })

  it('returns ok:true with an EMPTY list for a measured free calendar', async () => {
    getCalendarEvents.mockResolvedValue([])
    const { status, json } = await get()
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, events: [] })
  })

  it('a thrown fetch (e.g. token refresh 400) is HTTP 200 ok:false with the reason', async () => {
    getCalendarEvents.mockRejectedValue(new Error('Token refresh failed: 400'))
    const { status, json } = await get()
    expect(status).toBe(200)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('Token refresh failed: 400')
  })

  it('asks for a 2h window starting now', async () => {
    getCalendarEvents.mockResolvedValue([])
    const before = Date.now()
    await get()
    const [id, timeMin, timeMax] = getCalendarEvents.mock.calls[0] as [string, Date, Date]
    expect(id).toBe('owner@example.com')
    expect(timeMin.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(timeMax.getTime() - timeMin.getTime()).toBe(2 * 60 * 60 * 1000)
  })
})
