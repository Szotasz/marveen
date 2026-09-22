// Gmail sync for the ASSISTANT account only (the one Google OAuth we hold),
// raw API, no MCP: ~/.gmail-mcp/credentials.json (refresh_token) plus
// ~/.gmail-mcp/gcp-oauth.keys.json (installed client). The access token is
// refreshed in memory for the run and never written back into the MCP's file.
// Everything network-facing is behind `GmailApi` so the fixtures test drives
// the exact same normalisation and upsert.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { upsertMail, normalizeMessageId, parseReferences, parseAddresses, htmlToText, type NormalizedMail } from './mail-model.js'

export interface GmailHeader { name: string; value: string }
export interface GmailPart { mimeType?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: GmailHeader[] }
export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPart
}
export interface GmailApi {
  listMessageIds(query: string, max: number): Promise<string[]>
  getMessage(id: string): Promise<GmailMessage>
}

const CREDS_PATH = join(homedir(), '.gmail-mcp', 'credentials.json')
const CLIENT_PATH = join(homedir(), '.gmail-mcp', 'gcp-oauth.keys.json')
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

function header(p: GmailPart | undefined, name: string): string | null {
  const h = p?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : null
}

function b64url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

/** text/plain first; else text/html stripped; walks nested parts. */
export function extractBodyText(p: GmailPart | undefined): string | null {
  if (!p) return null
  const plain: string[] = []
  const html: string[] = []
  const walk = (part: GmailPart) => {
    const mt = (part.mimeType ?? '').toLowerCase()
    if (part.body?.data) {
      if (mt === 'text/plain') plain.push(b64url(part.body.data))
      else if (mt === 'text/html') html.push(b64url(part.body.data))
    }
    for (const c of part.parts ?? []) walk(c)
  }
  walk(p)
  if (plain.length) return plain.join('\n').trim()
  if (html.length) return htmlToText(html.join('\n'))
  return null
}

/** Gmail message -> the common shape. A letter forwarded from the personal
 *  account arrives with X-Forwarded-To and keeps its ORIGINAL Message-ID
 *  (measured): source becomes gmail_forwarded_personal, so the same letter
 *  seen through both accounts is one row. */
export function normalizeGmail(msg: GmailMessage): NormalizedMail {
  const p = msg.payload
  const labels = msg.labelIds ?? []
  const forwarded = header(p, 'X-Forwarded-To')
  const direction: NormalizedMail['direction'] = labels.includes('DRAFT') ? 'draft' : labels.includes('SENT') ? 'out' : 'in'
  const dateHeader = header(p, 'Date')
  const sentAt = msg.internalDate ? Math.floor(Number(msg.internalDate) / 1000) : dateHeader ? Math.floor(Date.parse(dateHeader) / 1000) : null
  return {
    source: forwarded ? 'gmail_forwarded_personal' : 'gmail_assistant',
    source_uid: msg.id,
    rfc_message_id: normalizeMessageId(header(p, 'Message-ID') ?? header(p, 'Message-Id')),
    provider_thread_id: msg.threadId || null,
    direction,
    from_addr: parseAddresses(header(p, 'From'))[0] ?? null,
    to_addrs: parseAddresses(header(p, 'To')),
    cc_addrs: parseAddresses(header(p, 'Cc')),
    subject: header(p, 'Subject'),
    sent_at: Number.isFinite(sentAt as number) ? sentAt : null,
    body_text: extractBodyText(p),
    in_reply_to: normalizeMessageId(header(p, 'In-Reply-To')),
    references: parseReferences(header(p, 'References')),
  }
}

export interface SyncStats { fetched: number; inserted: number; updated: number; unthreaded: number }

export async function syncGmail(db: Database.Database, api: GmailApi, opts: { query: string; max: number; now?: number }): Promise<SyncStats> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const ids = await api.listMessageIds(opts.query, opts.max)
  const stats: SyncStats = { fetched: 0, inserted: 0, updated: 0, unthreaded: 0 }
  const tx = db.transaction((msgs: GmailMessage[]) => {
    for (const msg of msgs) {
      const m = normalizeGmail(msg)
      const r = upsertMail(db, m, now)
      stats.fetched++
      if (r.inserted) stats.inserted++
      else stats.updated++
      if (!r.threadKey) stats.unthreaded++
    }
  })
  const batch: GmailMessage[] = []
  for (const id of ids) batch.push(await api.getMessage(id))
  tx(batch)
  return stats
}

// ---- the live client (not exercised by the unit tests) ----------------------

export function createLiveGmailApi(fetchImpl: typeof fetch = fetch): GmailApi {
  let accessToken: string | null = null
  async function token(): Promise<string> {
    if (accessToken) return accessToken
    const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as { refresh_token: string }
    const client = JSON.parse(readFileSync(CLIENT_PATH, 'utf-8')) as { installed: { client_id: string; client_secret: string } }
    const r = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.installed.client_id,
        client_secret: client.installed.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    })
    if (!r.ok) throw new Error(`gmail token refresh failed: HTTP ${r.status}`)
    const j = (await r.json()) as { access_token: string }
    accessToken = j.access_token
    return accessToken
  }
  async function get(url: string): Promise<unknown> {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${await token()}` } })
    if (!r.ok) throw new Error(`gmail api ${r.status} on ${url.replace(/\?.*$/, '')}`)
    return r.json()
  }
  return {
    async listMessageIds(query, max) {
      const ids: string[] = []
      let pageToken: string | undefined
      // PAGINATE TO THE END and count: a first page alone is the false negative
      // this fleet already fell into once (memory: calendar events.list).
      do {
        const qs = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) })
        if (pageToken) qs.set('pageToken', pageToken)
        const j = (await get(`${GMAIL}/messages?${qs}`)) as { messages?: Array<{ id: string }>; nextPageToken?: string }
        for (const m of j.messages ?? []) ids.push(m.id)
        pageToken = j.nextPageToken
      } while (pageToken && ids.length < max)
      return ids
    },
    async getMessage(id) {
      return (await get(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage
    },
  }
}
