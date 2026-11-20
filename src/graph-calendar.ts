import { logger } from './logger.js'
import { APP_TZ } from './config.js'
import { graphError, graphFetch, loadCredentials, userPath } from './graph-client.js'

// Microsoft Graph calendar for the agent's own M365 mailbox, app-only, on the
// same client-credentials token as graph-mail (see graph-client.ts).
//
// SCOPE: the Exchange Online RBAC ManagementScope that limits the app to one
// mailbox limits the calendar too -- a calendar lives IN a mailbox. The roles
// are different though: mail needs Application Mail.Read / Mail.Send, the
// calendar needs Application Calendars.Read (and Calendars.ReadWrite to
// create or change anything). If reading works and writing 403s, that is the
// missing role, not a bug here.
//
// TIME ZONE: the install's one zone, APP_TZ (src/config.ts: APP_TZ / SCHEDULER_TZ, else the host zone).
// Outgoing times carry an explicit timeZone, and reads send the
// `Prefer: outlook.timezone` header so Graph returns local time instead of
// UTC. Without that header Graph answers in UTC and every displayed hour is
// one or two off, depending on the season -- the exact class of bug that is
// invisible in winter and wrong all summer.

const PREFIX = 'graph-calendar'
export const DEFAULT_TIME_ZONE = APP_TZ

export interface GraphDateTime {
  dateTime: string
  timeZone?: string
}

export interface GraphEvent {
  id: string
  subject?: string
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  location?: { displayName?: string }
  organizer?: { emailAddress?: { name?: string; address?: string } }
  attendees?: Array<{
    type?: string
    status?: { response?: string }
    emailAddress?: { name?: string; address?: string }
  }>
  bodyPreview?: string
  webLink?: string
  onlineMeeting?: { joinUrl?: string } | null
}

export interface ListEventsOptions {
  /** Window start, ISO 8601 local time (e.g. '2026-10-16T00:00:00'). */
  start: string
  /** Window end, ISO 8601 local time. */
  end: string
  /** Max events to return. Default 50, capped at 250. */
  top?: number
  /** IANA zone the window and the returned times are expressed in. */
  timeZone?: string
}

export interface CreateEventOptions {
  subject: string
  start: string
  end: string
  timeZone?: string
  /** Free-text body; sent as HTML when `isHtml` is set. */
  body?: string
  isHtml?: boolean
  location?: string
  /** Addresses, or {address,name} pairs. Required attendees by default. */
  attendees?: Array<string | { address: string; name?: string; optional?: boolean }>
  /** All-day event: Graph wants midnight-to-midnight dates here. */
  isAllDay?: boolean
  /** Ask Exchange to attach a Teams link. Needs the tenant to allow it. */
  isOnlineMeeting?: boolean
}

export type UpdateEventOptions = Partial<Omit<CreateEventOptions, 'subject'>> & { subject?: string }

/** One free/busy block as Graph reports it for an address. */
export interface ScheduleItem {
  status?: string
  start?: GraphDateTime
  end?: GraphDateTime
  subject?: string
}

function calendarPath(): string {
  return `${userPath(PREFIX)}/calendar`
}

/**
 * Attendee shorthand to Graph's shape. Pure and exported: the three accepted
 * input forms (string, object, object with optional) are exactly the kind of
 * normalisation that silently drops a guest if it is wrong.
 */
export function toAttendeeList(
  attendees: CreateEventOptions['attendees'],
): Array<{ emailAddress: { address: string; name?: string }; type: string }> {
  if (!attendees?.length) return []
  return attendees
    .map((a) => (typeof a === 'string' ? { address: a } : a))
    .map((a) => ({ ...a, address: a.address?.trim() ?? '' }))
    .filter((a) => a.address)
    .map((a) => ({
      emailAddress: a.name ? { address: a.address, name: a.name } : { address: a.address },
      type: a.optional ? 'optional' : 'required',
    }))
}

/**
 * Build the Graph event body. Pure, so the payload contract can be pinned
 * without a tenant: this is where a missing timeZone or a dropped attendee
 * would otherwise only show up as a wrong entry in somebody's calendar.
 */
export function buildEventPayload(options: CreateEventOptions | UpdateEventOptions): Record<string, unknown> {
  const tz = options.timeZone ?? DEFAULT_TIME_ZONE
  const payload: Record<string, unknown> = {}
  if (options.subject !== undefined) payload.subject = options.subject
  if (options.start !== undefined) payload.start = { dateTime: options.start, timeZone: tz }
  if (options.end !== undefined) payload.end = { dateTime: options.end, timeZone: tz }
  if (options.isAllDay !== undefined) payload.isAllDay = options.isAllDay
  if (options.location !== undefined) payload.location = { displayName: options.location }
  if (options.body !== undefined) {
    payload.body = { contentType: options.isHtml ? 'HTML' : 'Text', content: options.body }
  }
  if (options.attendees !== undefined) payload.attendees = toAttendeeList(options.attendees)
  if (options.isOnlineMeeting !== undefined) {
    payload.isOnlineMeeting = options.isOnlineMeeting
    if (options.isOnlineMeeting) payload.onlineMeetingProvider = 'teamsForBusiness'
  }
  return payload
}

/**
 * Query string for /calendarView. Pure: calendarView is the endpoint that
 * expands recurring series, and it is the one that needs BOTH window bounds --
 * /events would quietly return the series master instead of its occurrences.
 */
export function buildCalendarViewQuery(options: ListEventsOptions): string {
  const top = Math.min(Math.max(options.top ?? 50, 1), 250)
  return new URLSearchParams({
    startDateTime: options.start,
    endDateTime: options.end,
    $top: String(top),
    $orderby: 'start/dateTime',
    $select: 'id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,webLink,onlineMeeting',
  }).toString()
}

function timeZoneHeader(timeZone?: string): Record<string, string> {
  return { Prefer: `outlook.timezone="${timeZone ?? DEFAULT_TIME_ZONE}"` }
}

/** Events overlapping [start, end), recurring series expanded to occurrences. */
export async function listEvents(options: ListEventsOptions): Promise<GraphEvent[]> {
  const res = await graphFetch(`${calendarPath()}/calendarView?${buildCalendarViewQuery(options)}`, {
    prefix: PREFIX,
    headers: timeZoneHeader(options.timeZone),
  })
  if (!res.ok) throw await graphError(PREFIX, 'listEvents', res)
  const json = (await res.json()) as { value?: GraphEvent[] }
  return json.value ?? []
}

/** One event by id. */
export async function getEvent(eventId: string, timeZone?: string): Promise<GraphEvent> {
  const res = await graphFetch(`${userPath(PREFIX)}/events/${encodeURIComponent(eventId)}`, {
    prefix: PREFIX,
    headers: timeZoneHeader(timeZone),
  })
  if (!res.ok) throw await graphError(PREFIX, 'getEvent', res)
  return (await res.json()) as GraphEvent
}

/** Create an event in the agent's own calendar. */
export async function createEvent(options: CreateEventOptions): Promise<GraphEvent> {
  const res = await graphFetch(`${calendarPath()}/events`, {
    method: 'POST',
    prefix: PREFIX,
    headers: timeZoneHeader(options.timeZone),
    body: JSON.stringify(buildEventPayload(options)),
  })
  if (!res.ok) throw await graphError(PREFIX, 'createEvent', res)
  const event = (await res.json()) as GraphEvent
  logger.info({ id: event.id, subject: options.subject, start: options.start }, 'graph-calendar: event created')
  return event
}

/** Patch an existing event. Only the fields present in `options` are sent. */
export async function updateEvent(eventId: string, options: UpdateEventOptions): Promise<GraphEvent> {
  const payload = buildEventPayload(options)
  if (Object.keys(payload).length === 0) {
    throw new Error(`${PREFIX}: updateEvent called with nothing to change`)
  }
  const res = await graphFetch(`${userPath(PREFIX)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    prefix: PREFIX,
    headers: timeZoneHeader(options.timeZone),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw await graphError(PREFIX, 'updateEvent', res)
  const event = (await res.json()) as GraphEvent
  logger.info({ id: eventId, changed: Object.keys(payload) }, 'graph-calendar: event updated')
  return event
}

/**
 * Delete an event. On an event the agent organised this cancels it for every
 * attendee, so the caller is responsible for deciding that is wanted; this
 * module does not second-guess it, it only records what it did.
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const res = await graphFetch(`${userPath(PREFIX)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    prefix: PREFIX,
  })
  if (!res.ok && res.status !== 204) throw await graphError(PREFIX, 'deleteEvent', res)
  logger.info({ id: eventId }, 'graph-calendar: event deleted')
}

/**
 * Free/busy for one or more addresses over a window. Useful before proposing a
 * time to a colleague; returns whatever the tenant's sharing policy allows,
 * which for an outside address may be nothing at all.
 */
export async function getSchedule(options: {
  addresses: string[]
  start: string
  end: string
  timeZone?: string
  /** Slot size in minutes Graph aggregates into. Default 30. */
  intervalMinutes?: number
}): Promise<Array<{ address: string; items: ScheduleItem[] }>> {
  const tz = options.timeZone ?? DEFAULT_TIME_ZONE
  const res = await graphFetch(`${calendarPath()}/getSchedule`, {
    method: 'POST',
    prefix: PREFIX,
    headers: timeZoneHeader(tz),
    body: JSON.stringify({
      schedules: options.addresses,
      startTime: { dateTime: options.start, timeZone: tz },
      endTime: { dateTime: options.end, timeZone: tz },
      availabilityViewInterval: options.intervalMinutes ?? 30,
    }),
  })
  if (!res.ok) throw await graphError(PREFIX, 'getSchedule', res)
  const json = (await res.json()) as {
    value?: Array<{ scheduleId?: string; scheduleItems?: ScheduleItem[] }>
  }
  return (json.value ?? []).map((v) => ({ address: v.scheduleId ?? '', items: v.scheduleItems ?? [] }))
}

/**
 * Connectivity + scope smoke check for the calendar, mirroring graph-mail's.
 * Reads one event from the agent's own calendar: proves the token mints, the
 * mailbox resolves and the calendar role is present. Says nothing about write
 * access -- Calendars.ReadWrite is a separate role, and the first create is
 * what proves it.
 */
export async function verifyCalendarAccess(): Promise<{ mailbox: string; eventCount: number }> {
  const creds = loadCredentials(PREFIX)
  const res = await graphFetch(`${calendarPath()}/events?$top=1&$select=id`, { prefix: PREFIX })
  if (!res.ok) throw await graphError(PREFIX, `verifyCalendarAccess for ${creds.mailbox}`, res)
  const json = (await res.json()) as { value?: unknown[] }
  return { mailbox: creds.mailbox, eventCount: json.value?.length ?? 0 }
}
