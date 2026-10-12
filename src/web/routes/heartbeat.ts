// 5E0A32B0: the heartbeat round's CODE-SIDE calendar source.
//
// The calendar was the last heartbeat data source the agent fetched itself
// (MCP tool), and it produced a month of migrating symptoms -- "MCP tool
// validation error", "tool not available", and finally a FOSSIL: one failed
// probe against a NONEXISTENT endpoint (/api/calendar/list-events, 404) on
// 2026-09-02 15:00 was copy-forwarded as "calendar fetch failed: API error"
// for every subsequent round with zero real attempts. Moving the fetch here
// -- next to the token cache and refresh logic that already work for the
// dashboard process -- puts the calendar on the same instrument path as
// every other digest number: the agent copies verbatim, composes nothing.
//
// Contract (consumed by scripts/heartbeat-metrics.sh):
//   200 { ok: true,  events: [{ start, end, summary, attendees }] }
//   200 { ok: false, error: "<reason>" }
// Both states are HTTP 200 on purpose: "the query failed" is a MEASURED
// result the instrument must relay ("calendar fetch failed: <reason>"),
// distinct from "no events" (ok:true, empty list) -- exactly the difference
// the fossil erased. A non-200 therefore always means the route itself is
// absent/broken, never a calendar-side failure.
import { getCalendarEvents } from '../../google-api.js'
import { HEARTBEAT_CALENDAR_ID } from '../../config.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export const HEARTBEAT_CALENDAR_WINDOW_MS = 2 * 60 * 60 * 1000

export async function tryHandleHeartbeat(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/heartbeat/calendar' && method === 'GET') {
    if (!HEARTBEAT_CALENDAR_ID) {
      json(res, { ok: false, error: 'HEARTBEAT_CALENDAR_ID is not configured' })
      return true
    }
    const now = new Date()
    const end = new Date(now.getTime() + HEARTBEAT_CALENDAR_WINDOW_MS)
    try {
      const events = await getCalendarEvents(HEARTBEAT_CALENDAR_ID, now, end)
      json(res, {
        ok: true,
        events: events
          .filter((e) => e.status !== 'cancelled')
          .map((e) => ({
            start: e.start ?? null,
            end: e.end ?? null,
            summary: e.summary ?? '(nincs cim)',
            attendees: e.attendees?.length ?? 0,
          })),
      })
    } catch (err) {
      logger.warn({ err }, 'heartbeat calendar endpoint: fetch failed')
      json(res, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) })
    }
    return true
  }

  return false
}
