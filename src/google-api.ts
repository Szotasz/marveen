import https from 'node:https'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

const TOKENS_PATH = join(homedir(), '.config', 'google-calendar-mcp', 'tokens.json')
const CLIENT_CREDS_PATH = join(homedir(), '.gmail-mcp', 'gcp-oauth.keys.json')

interface TokenData {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type: string
  scope: string
}

interface ClientCredentials {
  installed: {
    client_id: string
    client_secret: string
    token_uri: string
  }
}

interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  status?: string
  location?: string
  description?: string
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>
}

interface CalendarListResponse {
  items?: CalendarEvent[]
}

// Token cache + mtime-invalidation. The cache spares us a JSON parse on
// every getCalendarEvents call, but a stale cache kills the heartbeat after
// an out-of-process re-auth (the OAuth-mcp `auth` subcommand writes a fresh
// tokens.json from a separate process, our cache never re-reads it). Track
// the file's mtime alongside the parsed payload; re-read whenever the mtime
// advances. 2026-06-02 14:30 incident: after Szabi re-authed at 16:26 the
// dashboard kept dropping `Google token refresh failed` until a manual
// process restart, because cachedTokens held the pre-re-auth (88-day-old,
// already-revoked) refresh_token.
let cachedTokens: { normal: TokenData; mtimeMs: number } | null = null
let cachedClient: ClientCredentials | null = null

function loadTokens(): TokenData {
  let currentMtime = 0
  try { currentMtime = statSync(TOKENS_PATH).mtimeMs } catch { /* file missing -- fall through to readFileSync error */ }
  if (!cachedTokens || cachedTokens.mtimeMs !== currentMtime) {
    const parsed = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'))
    cachedTokens = { normal: parsed.normal, mtimeMs: currentMtime }
  }
  return cachedTokens.normal
}

function saveTokens(tokens: TokenData): void {
  writeFileSync(TOKENS_PATH, JSON.stringify({ normal: tokens }, null, 2))
  // Re-stat AFTER write so the next loadTokens() sees the matching mtime
  // and uses the freshly-written content from cache rather than triggering
  // an extra re-read on the very next call.
  let mtimeMs = 0
  try { mtimeMs = statSync(TOKENS_PATH).mtimeMs } catch { /* unlikely right after writeFileSync */ }
  cachedTokens = { normal: tokens, mtimeMs }
}

function loadClientCredentials(): ClientCredentials {
  if (!cachedClient) {
    cachedClient = JSON.parse(readFileSync(CLIENT_CREDS_PATH, 'utf-8'))
  }
  return cachedClient!
}

function httpsRequest(url: string, options: https.RequestOptions, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          data: Buffer.concat(chunks).toString('utf-8'),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function refreshAccessToken(): Promise<string> {
  const tokens = loadTokens()
  const client = loadClientCredentials()

  const params = new URLSearchParams({
    client_id: client.installed.client_id,
    client_secret: client.installed.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  })

  const { status, data } = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    params.toString()
  )

  if (status !== 200) {
    logger.error({ status, body: data }, 'Google token refresh failed')
    throw new Error(`Token refresh failed: ${status}`)
  }

  const refreshed = JSON.parse(data)
  const updated: TokenData = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: Date.now() + (refreshed.expires_in * 1000),
  }
  saveTokens(updated)
  logger.info('Google access token refreshed')
  return updated.access_token
}

async function getValidAccessToken(): Promise<string> {
  const tokens = loadTokens()
  // Refresh if token expires within 5 minutes
  if (Date.now() > tokens.expiry_date - 5 * 60 * 1000) {
    return refreshAccessToken()
  }
  return tokens.access_token
}

export async function getCalendarEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken()

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  })

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`

  const { status, data } = await httpsRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (status === 401) {
    // Token expired mid-flight, refresh and retry once
    const newToken = await refreshAccessToken()
    const retry = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${newToken}` },
    })
    if (retry.status !== 200) {
      logger.error({ status: retry.status, body: retry.data }, 'Google Calendar API error after refresh')
      return []
    }
    const parsed: CalendarListResponse = JSON.parse(retry.data)
    return parsed.items ?? []
  }

  if (status !== 200) {
    logger.error({ status, body: data }, 'Google Calendar API error')
    return []
  }

  const parsed: CalendarListResponse = JSON.parse(data)
  return parsed.items ?? []
}

export type { CalendarEvent }
