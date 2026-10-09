import { randomUUID } from 'node:crypto'
import {
  createReminder, getReminder, listReminders, updatePendingReminder, setReminderStatusByHand,
  type Reminder,
} from '../../db.js'
import { logger } from '../../logger.js'
import { nextAllowedMs } from '../../reminder-window.js'
import { isKnownAgent } from '../agent-config.js'
import { readBody, json } from '../http-helpers.js'
import { loadReminderWindows } from '../reminder-sender.js'
import type { RouteContext } from './types.js'

// fb79dc1f: the reminders API. POST creates one, GET lists / reads, PATCH edits
// a pending one or moves its status by hand (cancel; a failed one back to
// pending). The dashboard sends them itself (src/web/reminder-sender.ts).

export const REMINDER_TEXT_MAX = 4000
// Telegram allows 4096; the margin keeps a verbatim text under the limit.
export const REMINDER_MAX_AHEAD_SEC = 366 * 24 * 3600
// A due time slightly in the past is a clock difference, not a mistake.
export const REMINDER_PAST_GRACE_SEC = 10 * 60

const CHAT_ID = /^-?\d{1,20}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// An ISO time WITH its zone (Z or +HH:MM): a bare local time would be read in
// the server's zone, which is UTC on the live install and not what was meant.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** A due time as epoch seconds: an integer, or an ISO string with its zone. Null when it is neither. Pure + exported for tests. */
export function parseDueAt(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null
  if (typeof raw === 'string' && ISO_WITH_ZONE.test(raw)) {
    const ms = Date.parse(raw)
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
  }
  return null
}

/** A chat id as stored: digits (a group id is negative), from a string or a safe integer. */
export function normChatId(raw: unknown): string | null {
  const s = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  return CHAT_ID.test(s) ? s : null
}

function optString(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s && s.length <= max ? s : null
}

type SendAfter = { ok: true; sendAfter: number } | { ok: false; error: string }

/** The moment the reminder may go: its due time moved by the recipient's window. */
function computeSendAfter(recipient: string, dueAt: number, allowWeekend: boolean, nowSec?: number): SendAfter {
  const w = loadReminderWindows()
  if (!w.ok) return { ok: false, error: w.error }
  const from = Math.max(dueAt, nowSec ?? 0)
  return { ok: true, sendAfter: Math.floor(nextAllowedMs(from * 1000, w.config.recipients[recipient], allowWeekend) / 1000) }
}

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const x = JSON.parse((await readBody(ctx.req)).toString())
    return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function tryHandleReminders(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  const caller = ctx.auth?.kind === 'token' ? ctx.auth.agent : undefined

  // POST /api/reminders -- a new reminder
  if (path === '/api/reminders' && method === 'POST') {
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
    const requester = optString(body.requester, 128)
    if (!requester) { json(res, { error: 'requester is required (at most 128 characters)' }, 400); return true }
    const recipient = normChatId(body.recipient_chat_id)
    if (!recipient) { json(res, { error: 'recipient_chat_id must be a chat id (digits)' }, 400); return true }
    const agentRaw = body.agent_id === undefined ? caller : body.agent_id
    if (typeof agentRaw !== 'string' || !isKnownAgent(agentRaw.trim())) {
      json(res, { error: 'agent_id must be a registered agent (its bot sends the reminder)' }, 400)
      return true
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > REMINDER_TEXT_MAX) {
      json(res, { error: `text is required (at most ${REMINDER_TEXT_MAX} characters)` }, 400)
      return true
    }
    const dueAt = parseDueAt(body.due_at)
    if (dueAt === null) {
      json(res, { error: 'due_at must be epoch seconds or an ISO time with its zone (Z or +HH:MM)' }, 400)
      return true
    }
    const now = Math.floor(Date.now() / 1000)
    if (dueAt < now - REMINDER_PAST_GRACE_SEC) { json(res, { error: 'due_at is in the past' }, 400); return true }
    if (dueAt > now + REMINDER_MAX_AHEAD_SEC) { json(res, { error: 'due_at is more than a year ahead' }, 400); return true }
    if (body.allow_weekend !== undefined && typeof body.allow_weekend !== 'boolean') {
      json(res, { error: 'allow_weekend must be a boolean' }, 400)
      return true
    }
    const sourceRef = optString(body.source_ref, 128)
    if (sourceRef === null) { json(res, { error: 'source_ref must be a string (at most 128 characters)' }, 400); return true }
    const allowWeekend = body.allow_weekend === true
    const sa = computeSendAfter(recipient, dueAt, allowWeekend)
    if (!sa.ok) {
      // fail-closed: a send moment that cannot be computed is not stored as "now"
      logger.warn({ error: sa.error }, 'reminders: the windows config is invalid, reminder refused')
      json(res, { error: `reminder windows config is invalid: ${sa.error}` }, 503)
      return true
    }
    const reminder = createReminder({
      id: randomUUID(), requester, recipient_chat_id: recipient, agent_id: agentRaw.trim(), text, due_at: dueAt,
      send_after: sa.sendAfter, allow_weekend: allowWeekend, source_ref: sourceRef ?? null, created_by: caller ?? null,
    })
    logger.info({ id: reminder.id, agent_id: reminder.agent_id, due_at: dueAt, send_after: sa.sendAfter }, 'Reminder created')
    json(res, reminder, 201)
    return true
  }

  // GET /api/reminders -- list with filters (status, agent, recipient, due_from, due_to, limit)
  if (path === '/api/reminders' && method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    const agent = url.searchParams.get('agent') ?? undefined
    const recipientRaw = url.searchParams.get('recipient')
    const recipient = recipientRaw === null ? undefined : normChatId(recipientRaw)
    if (recipient === null) { json(res, { error: 'recipient must be a chat id' }, 400); return true }
    const bound = (k: string): number | undefined | null => {
      const v = url.searchParams.get(k)
      if (v === null) return undefined
      return /^\d+$/.test(v) ? Number(v) : parseDueAt(v)
    }
    const dueFrom = bound('due_from')
    const dueTo = bound('due_to')
    if (dueFrom === null || dueTo === null) { json(res, { error: 'due_from / due_to must be epoch seconds or an ISO time with its zone' }, 400); return true }
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100
    json(res, listReminders({ status, agent_id: agent, recipient_chat_id: recipient, due_from: dueFrom, due_to: dueTo, limit }))
    return true
  }

  const idMatch = path.match(/^\/api\/reminders\/([^/]+)$/)
  if (!idMatch) return false
  const id = idMatch[1]

  // GET /api/reminders/:id
  if (method === 'GET') {
    const r = UUID.test(id) ? getReminder(id) : undefined
    if (!r) { json(res, { error: 'Not found' }, 404); return true }
    json(res, r)
    return true
  }

  // PATCH /api/reminders/:id -- either a status move by hand, or edits of a pending reminder
  if (method === 'PATCH') {
    const body = await readJson(ctx)
    if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
    const current: Reminder | undefined = UUID.test(id) ? getReminder(id) : undefined
    if (!current) { json(res, { error: 'Not found' }, 404); return true }
    const editKeys = ['text', 'due_at', 'allow_weekend', 'recipient_chat_id'].filter(k => body[k] !== undefined)

    if (body.status !== undefined) {
      if (editKeys.length) { json(res, { error: 'a status move and field edits are separate requests' }, 400); return true }
      if (body.status === 'cancelled') {
        if (!setReminderStatusByHand(id, ['pending', 'failed'], 'cancelled', caller ?? null)) {
          json(res, { error: `cannot cancel a reminder in status ${getReminder(id)?.status}` }, 409)
          return true
        }
      } else if (body.status === 'pending') {
        // a failed one goes again, at the first allowed moment from now
        const sa = computeSendAfter(current.recipient_chat_id, current.due_at, current.allow_weekend === 1, Math.floor(Date.now() / 1000))
        if (!sa.ok) { json(res, { error: `reminder windows config is invalid: ${sa.error}` }, 503); return true }
        if (!setReminderStatusByHand(id, ['failed'], 'pending', caller ?? null, sa.sendAfter)) {
          json(res, { error: `only a failed reminder goes back to pending (it is ${getReminder(id)?.status})` }, 409)
          return true
        }
      } else {
        json(res, { error: 'status must be cancelled or pending' }, 400)
        return true
      }
      logger.info({ id, status: body.status, by: caller }, 'Reminder status moved by hand')
      json(res, getReminder(id))
      return true
    }

    if (!editKeys.length) { json(res, { error: 'nothing to change (text, due_at, allow_weekend, recipient_chat_id, or status)' }, 400); return true }
    const fields: { text?: string; due_at?: number; allow_weekend?: boolean; recipient_chat_id?: string; send_after?: number } = {}
    if (body.text !== undefined) {
      const t = typeof body.text === 'string' ? body.text.trim() : ''
      if (!t || t.length > REMINDER_TEXT_MAX) { json(res, { error: `text is required (at most ${REMINDER_TEXT_MAX} characters)` }, 400); return true }
      fields.text = t
    }
    if (body.due_at !== undefined) {
      const d = parseDueAt(body.due_at)
      const now = Math.floor(Date.now() / 1000)
      if (d === null || d < now - REMINDER_PAST_GRACE_SEC || d > now + REMINDER_MAX_AHEAD_SEC) {
        json(res, { error: 'due_at must be a time from now to a year ahead (epoch seconds or ISO with its zone)' }, 400)
        return true
      }
      fields.due_at = d
    }
    if (body.allow_weekend !== undefined) {
      if (typeof body.allow_weekend !== 'boolean') { json(res, { error: 'allow_weekend must be a boolean' }, 400); return true }
      fields.allow_weekend = body.allow_weekend
    }
    if (body.recipient_chat_id !== undefined) {
      const c = normChatId(body.recipient_chat_id)
      if (!c) { json(res, { error: 'recipient_chat_id must be a chat id (digits)' }, 400); return true }
      fields.recipient_chat_id = c
    }
    if (fields.due_at !== undefined || fields.allow_weekend !== undefined || fields.recipient_chat_id !== undefined) {
      const sa = computeSendAfter(
        fields.recipient_chat_id ?? current.recipient_chat_id, fields.due_at ?? current.due_at,
        fields.allow_weekend ?? current.allow_weekend === 1,
      )
      if (!sa.ok) { json(res, { error: `reminder windows config is invalid: ${sa.error}` }, 503); return true }
      fields.send_after = sa.sendAfter
    }
    if (!updatePendingReminder(id, fields, caller ?? null)) {
      json(res, { error: `only a pending reminder can be edited (it is ${getReminder(id)?.status})` }, 409)
      return true
    }
    logger.info({ id, fields: Object.keys(fields), by: caller }, 'Reminder edited')
    json(res, getReminder(id))
    return true
  }

  return false
}
