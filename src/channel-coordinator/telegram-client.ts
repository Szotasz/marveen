// Thin Telegram Bot-API client for the standalone channel-coordinator.
//
// This is deliberately NOT grammy: the coordinator only needs getUpdates
// long-polling, and pulling grammy in would re-introduce the same in-memory
// offset handling and bot.start() lifecycle that the plugin uses. We poll with
// a raw fetch + AbortController read-timeout and persist the offset ourselves
// (see ingest.ts), so a crash/restart resumes exactly where we left off.
//
// Outbound (reply/react/edit) stays in the Telegram channel plugin running in
// outbound-only mode (TELEGRAM_OUTBOUND_ONLY=1). This client never sends; it
// only ingests. Keeping inbound here and outbound there means a single poller
// holds the token's getUpdates slot, so there is no 409 Conflict.

const API_BASE = 'https://api.telegram.org'

// allowed_updates whitelist sent on every poll. callback_query is included so
// the coordinator at least records inline-button presses, even though the
// permission-relay path (notifications/claude/channel/permission) is a known
// gap in outbound-only mode -- see the design risk register.
export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'callback_query'] as const

export type UpdateKind = 'message' | 'edited_message' | 'channel_post' | 'callback_query'

export interface NormalizedEvent {
  update_id: number
  kind: UpdateKind
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  content: string
  meta: Record<string, unknown>
  tg_date: number | null
}

// One error type, classified by `kind` so the poll loop can pick a backoff
// strategy without re-parsing HTTP status / Bot-API error_code everywhere.
//   fatal     -> 401 invalid token: exit + alert, retrying is pointless
//   rate_limit-> 429: wait exactly parameters.retry_after seconds
//   conflict  -> 409: another poller holds the token; fixed backoff + window
//   transient -> 5xx / network / abort: exponential backoff with jitter
export type TelegramErrorKind = 'fatal' | 'rate_limit' | 'conflict' | 'transient'

export class TelegramApiError extends Error {
  constructor(
    public readonly kind: TelegramErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

interface RawUpdate {
  update_id: number
  message?: RawMessage
  edited_message?: RawMessage
  channel_post?: RawMessage
  callback_query?: {
    id: string
    data?: string
    from?: RawUser
    message?: RawMessage
  }
}

interface RawMessage {
  message_id: number
  date?: number
  text?: string
  caption?: string
  chat: { id: number; username?: string; title?: string }
  from?: RawUser
  photo?: unknown[]
  document?: { file_id: string; file_name?: string }
  voice?: { file_id: string }
}

interface RawUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

function displayName(u?: RawUser): string | null {
  if (!u) return null
  if (u.username) return u.username
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return full || String(u.id)
}

// Normalize a raw Telegram update into the flat shape the ingest layer stores.
// Returns null for update kinds we do not handle (so the caller still advances
// the offset past them rather than re-fetching forever).
export function mapUpdate(u: RawUpdate): NormalizedEvent | null {
  const msg = u.message ?? u.edited_message ?? u.channel_post
  if (msg) {
    const kind: UpdateKind = u.edited_message
      ? 'edited_message'
      : u.channel_post
        ? 'channel_post'
        : 'message'
    const meta: Record<string, unknown> = {}
    if (Array.isArray(msg.photo) && msg.photo.length > 0) meta['has_photo'] = true
    if (msg.document) meta['document'] = { file_id: msg.document.file_id, file_name: msg.document.file_name }
    if (msg.voice) meta['voice'] = { file_id: msg.voice.file_id }
    return {
      update_id: u.update_id,
      kind,
      chat_id: msg.chat.id,
      user_id: msg.from?.id ?? null,
      username: displayName(msg.from) ?? msg.chat.title ?? null,
      message_id: msg.message_id,
      content: msg.text ?? msg.caption ?? '',
      meta,
      tg_date: msg.date ?? null,
    }
  }
  if (u.callback_query) {
    const cq = u.callback_query
    return {
      update_id: u.update_id,
      kind: 'callback_query',
      chat_id: cq.message?.chat.id ?? null,
      user_id: cq.from?.id ?? null,
      username: displayName(cq.from),
      message_id: cq.message?.message_id ?? null,
      content: cq.data ?? '',
      meta: { callback_query_id: cq.id },
      tg_date: cq.message?.date ?? null,
    }
  }
  return null
}

// Long-poll getUpdates. `timeout` is the Telegram-side long-poll seconds; the
// HTTP read-timeout is timeout + 10 so a healthy long-poll that returns near
// its deadline is never aborted mid-flight, while a wedged connection still
// gets torn down.
export async function getUpdates(
  token: string,
  offset: number,
  timeout: number,
  limit: number,
): Promise<RawUpdate[]> {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), (timeout + 10) * 1000)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, timeout, limit, allowed_updates: ALLOWED_UPDATES }),
      signal: controller.signal,
    })
  } catch (err) {
    // Network failure, DNS, or our own abort: all retryable.
    throw new TelegramApiError('transient', `network error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(abortTimer)
  }

  if (!res.ok) {
    // Bot-API mirrors error_code in the JSON body with parameters.retry_after.
    // Parse defensively -- a proxy 5xx may not be JSON at all.
    let errorCode = res.status
    let description = `HTTP ${res.status}`
    let retryAfter: number | undefined
    try {
      const body = await res.json() as { error_code?: number; description?: string; parameters?: { retry_after?: number } }
      if (typeof body.error_code === 'number') errorCode = body.error_code
      if (body.description) description = body.description
      retryAfter = body.parameters?.retry_after
    } catch { /* non-JSON error body, fall back to status */ }

    if (errorCode === 401) throw new TelegramApiError('fatal', `401 unauthorized: ${description}`)
    if (errorCode === 409) throw new TelegramApiError('conflict', `409 conflict: ${description}`)
    if (errorCode === 429) throw new TelegramApiError('rate_limit', `429 too many requests: ${description}`, retryAfter)
    if (errorCode >= 500) throw new TelegramApiError('transient', `5xx: ${description}`)
    // 400 / 403 / other 4xx on getUpdates are configuration bugs, not transient.
    throw new TelegramApiError('fatal', `unexpected ${errorCode}: ${description}`)
  }

  const json = await res.json() as { ok: boolean; result?: RawUpdate[]; description?: string }
  if (!json.ok) throw new TelegramApiError('transient', `getUpdates ok=false: ${json.description ?? 'unknown'}`)
  return json.result ?? []
}
