import https from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'
import type { CalendarEvent } from './google-api.js'

const MSAL_CACHE_PATH = join(homedir(), '.m365-mcp', 'msal-cache.json')
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

interface MsalCache {
  AccessToken?: Record<string, MsalAccessToken>
  RefreshToken?: Record<string, MsalRefreshToken>
}

interface MsalAccessToken {
  client_id: string
  secret: string
  realm: string
  expires_on: string
  cached_at: string
}

interface MsalRefreshToken {
  client_id: string
  secret: string
}

// Microsoft Graph calendar event shape (subset we use)
interface GraphEvent {
  id: string
  subject?: string
  start?: { dateTime: string; timeZone: string }
  end?: { dateTime: string; timeZone: string }
  location?: { displayName?: string }
  isAllDay?: boolean
  attendees?: Array<{
    emailAddress?: { address?: string; name?: string }
    type?: string
  }>
  bodyPreview?: string
  isCancelled?: boolean
}

interface GraphCalendarViewResponse {
  value?: GraphEvent[]
}

function loadMsalCache(): MsalCache {
  return JSON.parse(readFileSync(MSAL_CACHE_PATH, 'utf-8')) as MsalCache
}

function saveMsalCache(cache: MsalCache): void {
  writeFileSync(MSAL_CACHE_PATH, JSON.stringify(cache, null, 2))
}

function findAccessToken(cache: MsalCache): MsalAccessToken | null {
  const entries = Object.values(cache.AccessToken ?? {})
  return entries[0] ?? null
}

function findRefreshToken(cache: MsalCache): MsalRefreshToken | null {
  const entries = Object.values(cache.RefreshToken ?? {})
  return entries[0] ?? null
}

function httpsRequest(url: string, options: https.RequestOptions, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function refreshAccessToken(cache: MsalCache): Promise<string> {
  const atEntry = findAccessToken(cache)
  const rtEntry = findRefreshToken(cache)
  if (!atEntry || !rtEntry) throw new Error('M365: no token entries in MSAL cache')

  const clientId = atEntry.client_id
  const tenantId = atEntry.realm
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: rtEntry.secret,
    scope: 'https://graph.microsoft.com/Calendars.Read offline_access',
  })

  const { status, data } = await httpsRequest(
    tokenEndpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    params.toString()
  )

  if (status !== 200) {
    logger.error({ status, body: data }, 'M365 token refresh failed')
    throw new Error(`M365 token refresh failed: ${status}`)
  }

  const refreshed = JSON.parse(data)
  const now = Math.floor(Date.now() / 1000)

  // Update access token entry in cache
  const cacheKey = Object.keys(cache.AccessToken ?? {})[0]
  if (cacheKey && cache.AccessToken) {
    cache.AccessToken[cacheKey] = {
      ...cache.AccessToken[cacheKey],
      secret: refreshed.access_token as string,
      cached_at: String(now),
      expires_on: String(now + (refreshed.expires_in as number)),
    }
  }

  // Update refresh token if rotated
  if (refreshed.refresh_token) {
    const rtKey = Object.keys(cache.RefreshToken ?? {})[0]
    if (rtKey && cache.RefreshToken) {
      cache.RefreshToken[rtKey] = {
        ...cache.RefreshToken[rtKey],
        secret: refreshed.refresh_token as string,
      }
    }
  }

  saveMsalCache(cache)
  logger.info('M365 access token refreshed')
  return refreshed.access_token as string
}

async function getValidAccessToken(): Promise<string> {
  const cache = loadMsalCache()
  const atEntry = findAccessToken(cache)
  if (!atEntry) throw new Error('M365: no access token in MSAL cache')

  const expiresOn = parseInt(atEntry.expires_on, 10)
  const nowSec = Math.floor(Date.now() / 1000)

  if (nowSec > expiresOn - 300) {
    return refreshAccessToken(cache)
  }

  return atEntry.secret
}

function toIsoWithoutTz(dt: string): string {
  // Graph returns UTC datetime strings like "2026-05-26T10:00:00.0000000"
  // Append Z if no timezone indicator present
  return dt.endsWith('Z') || dt.includes('+') ? dt : dt + 'Z'
}

function mapGraphEvent(ev: GraphEvent): CalendarEvent {
  return {
    id: ev.id,
    summary: ev.subject,
    start: ev.isAllDay
      ? { date: ev.start?.dateTime?.split('T')[0] }
      : { dateTime: ev.start ? toIsoWithoutTz(ev.start.dateTime) : undefined },
    end: ev.isAllDay
      ? { date: ev.end?.dateTime?.split('T')[0] }
      : { dateTime: ev.end ? toIsoWithoutTz(ev.end.dateTime) : undefined },
    status: ev.isCancelled ? 'cancelled' : 'confirmed',
    location: ev.location?.displayName,
    attendees: ev.attendees?.map((a) => ({
      email: a.emailAddress?.address ?? '',
      displayName: a.emailAddress?.name,
    })),
  }
}

export async function getM365CalendarEvents(
  _calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken()

  const params = new URLSearchParams({
    startDateTime: timeMin.toISOString(),
    endDateTime: timeMax.toISOString(),
    $select: 'id,subject,start,end,location,attendees,isAllDay,isCancelled',
    $orderby: 'start/dateTime',
    $top: '20',
  })

  const url = `${GRAPH_BASE}/me/calendarView?${params}`

  const { status, data } = await httpsRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (status === 401) {
    const cache = loadMsalCache()
    const newToken = await refreshAccessToken(cache)
    const retry = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${newToken}` },
    })
    if (retry.status !== 200) {
      logger.error({ status: retry.status, body: retry.data }, 'M365 Graph API error after refresh')
      return []
    }
    const parsed: GraphCalendarViewResponse = JSON.parse(retry.data)
    return (parsed.value ?? []).map(mapGraphEvent)
  }

  if (status !== 200) {
    logger.error({ status, body: data }, 'M365 Graph API error')
    return []
  }

  const parsed: GraphCalendarViewResponse = JSON.parse(data)
  return (parsed.value ?? []).map(mapGraphEvent)
}
