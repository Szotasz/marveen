import { CALENDAR_PROVIDER } from './config.js'
import { getCalendarEvents, type CalendarEvent } from './google-api.js'
import { getM365CalendarEvents } from './m365-api.js'

export type { CalendarEvent }

export async function getCalendarEventsForHeartbeat(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  if (CALENDAR_PROVIDER === 'm365') {
    return getM365CalendarEvents(calendarId, timeMin, timeMax)
  }
  return getCalendarEvents(calendarId, timeMin, timeMax)
}
