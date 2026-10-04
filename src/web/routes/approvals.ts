import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, TELEGRAM_BOT_TOKEN } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, setApprovalTelegramMessageId,
  listOwnerGoApprovalsBetween, lastOwnerGoDigestDay, recordOwnerGoDigest,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { resolveOwnerChatId } from '../../owner-chat.js'
import { sendTelegramMessage } from '../telegram.js'
import type { RouteContext } from './types.js'

const AUTONOMY_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

// APPROVALVAK821: a pending approval with timeout_at NULL can never reach the
// 'timeout' status -- the sweeper's WHERE clause skips it forever, so an
// unanswered request leaves the asking agent polling into eternity. No
// category carried timeout_minutes in any real install, which made the state
// STRUCTURALLY unreachable. Every request therefore gets a timeout: the
// caller's explicit timeout_seconds wins, then the category's
// timeout_minutes, then this default.
export const DEFAULT_TIMEOUT_MINUTES = 1440
// Cap: a timeout past a week is indistinguishable from the old "never".
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 3600

function readCategoryTimeoutMinutes(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as {
      categories: { key: string; timeout_minutes?: number | null }[]
    }
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return cat.timeout_minutes
  } catch {
    return null
  }
}

// Pure + exported for tests. `timeoutSeconds` is the request-body value as
// received (unknown): the scaffolded agent instructions have always told
// agents to send timeout_seconds, but the old handler never read it.
export function computeTimeoutAt(category: string, timeoutSeconds: unknown, nowMs: number = Date.now()): number {
  const now = Math.floor(nowMs / 1000)
  if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return now + Math.min(Math.floor(timeoutSeconds), MAX_TIMEOUT_SECONDS)
  }
  const catMinutes = readCategoryTimeoutMinutes(category)
  if (catMinutes != null && catMinutes > 0) return now + catMinutes * 60
  return now + DEFAULT_TIMEOUT_MINUTES * 60
}

// Owner-facing Telegram text. Pure + exported for tests. Plain text (no
// markdown escaping concerns), proper accents: this is outgoing copy.
export function buildOwnerApprovalText(approval: Approval): string {
  const expires = approval.timeout_at
    ? new Date(approval.timeout_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
    : 'nincs'
  return [
    `[JÓVÁHAGYÁS KELL] ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    `Lejárat: ${expires}`,
    `Döntés: Dashboard -> Jóváhagyások (id: ${approval.id})`,
  ].join('\n')
}

// bc7c1e9d: an email_send request of the main agent that
// cites a written owner GO it already holds must not ping the owner again -- on
// 2026-09-23 four such pings (13:05-13:27Z) each asked for a decision another
// owner had already made. Every other request still notifies, unchanged: a
// sub-agent's, a main-agent one without a GO reference, any other category.
// The reference only silences the ping; the request stays pending until it is
// resolved, and the one-shot hash gate of the send is untouched.
// (b): the silenced requests are not invisible either. The
// "main agent" is a self-declared agent_id behind the shared token, so a
// silenced ping alone would let any token holder hide a request from the owner;
// every such request is listed in the owner's next daily digest instead.
// Pure + exported for tests.
export function ownerGoCoversRequest(approval: Pick<Approval, 'agent_id' | 'category' | 'owner_go_ref'>): boolean {
  return approval.agent_id === MAIN_AGENT_ID && approval.category === 'email_send' && Boolean(approval.owner_go_ref)
}

// A GO reference is a short pointer to where the owner said it (e.g.
// "tesztelek-tg-101"), never free text.
const OWNER_GO_REF_RX = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,119}$/

// When the owner send is suppressed or fails AND the requester is the main
// agent, there is no in-band signal left at all: the leg-2 short-circuit
// below skips the main-agent message unconditionally. The old self-notify was
// useless but VISIBLE -- losing even that would rebuild the closed loop this
// card documents, one layer deeper (Marveen's review finding on #1026).
// Everyone else already got the normal main-agent notify, so the fallback is
// main-requester-only. The marker names the reason so the reader knows this
// is a degraded delivery, not the normal path.
function fallbackInBand(approval: Approval, reason: string): void {
  if (approval.agent_id !== MAIN_AGENT_ID) return
  try {
    const content = [
      `[APPROVAL_REQUEST][OWNER_UNREACHED ${reason}]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'approval in-band fallback failed too -- the request is only visible on the dashboard')
  }
}

// APPROVALVAK821 (a) -- the request must reach the OWNER, not only the main
// agent's inter-agent queue. Fire-and-forget on purpose: the POST response
// must not wait on the Telegram round-trip, and a failed send must not fail
// the request -- but it must be LOUD in the logs, because a silently
// undelivered approval is exactly the closed loop this fixes.
function notifyOwner(approval: Approval): void {
  void (async () => {
    if (!TELEGRAM_BOT_TOKEN) {
      logger.warn({ approvalId: approval.id }, 'approval owner notification suppressed: no TELEGRAM_BOT_TOKEN')
      fallbackInBand(approval, 'no-token')
      return
    }
    const ownerChat = resolveOwnerChatId()
    if (!ownerChat) {
      logger.warn({ approvalId: approval.id }, 'approval owner notification suppressed: no owner chat')
      fallbackInBand(approval, 'no-owner-chat')
      return
    }
    try {
      const messageId = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, buildOwnerApprovalText(approval))
      if (messageId != null) setApprovalTelegramMessageId(approval.id, messageId)
      logger.info({ approvalId: approval.id, messageId }, 'approval owner notification sent')
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, 'approval owner notification FAILED -- the request is only visible on the dashboard')
      fallbackInBand(approval, 'send-failed')
    }
  })()
}

function notifyMainAgent(approval: Approval): void {
  // APPROVALVAK821 (b): when the requester IS the main agent, this used to
  // deliver the notification back to the requester itself -- which counted as
  // "notified" while no human ever saw it. The owner Telegram above is the
  // real notification; a self-addressed message is noise that hides the gap.
  if (approval.agent_id === MAIN_AGENT_ID) {
    logger.info({ approvalId: approval.id, ownerGoRef: approval.owner_go_ref }, 'approval main-agent notify skipped: requester is the main agent')
    return
  }
  try {
    const content = [
      `[APPROVAL_REQUEST]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

// --- bc7c1e9d (b): the daily owner digest of the GO-cited requests ---
// One message to the owner per Budapest calendar day, sent from 07:00 on the
// next morning, and only if the day had such a request (an empty day is
// settled without a message). Per row: time, the self-declared agent_id, the
// category, the envelope hash prefix, the GO reference and the state; never
// the content. A day is settled at most once (the digest table's key).
export const OWNER_GO_DIGEST_HOUR = 7
// A missed morning (the server was down) is caught up day by day, but never
// further back than this: older days stay on the dashboard.
export const OWNER_GO_DIGEST_MAX_CATCHUP_DAYS = 7
// A failed Telegram send is retried, but not on every sweep tick.
export const OWNER_GO_DIGEST_RETRY_MS = 15 * 60_000

const BUDAPEST = 'Europe/Budapest'

function budapestParts(ms: number): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUDAPEST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) }
}

function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10)
}

// The UTC instant (ms) of 00:00 Budapest time on `day`; the offset is +1h or +2h (DST). Pure + exported for tests.
export function budapestMidnightUtcMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  for (const offsetHours of [2, 1]) {
    const ms = Date.UTC(y, m - 1, d) - offsetHours * 3_600_000
    const p = budapestParts(ms)
    if (p.day === day && p.hour === 0 && p.minute === 0) return ms
  }
  throw new Error(`no Budapest midnight for ${day}`)
}

// Which Budapest day's digest is due at `nowMs`: the oldest unsettled complete
// day, from OWNER_GO_DIGEST_HOUR on, at most OWNER_GO_DIGEST_MAX_CATCHUP_DAYS
// back; the very first run starts with yesterday. Pure + exported for tests.
export function ownerGoDigestDayDue(nowMs: number, lastSettledDay: string | null): string | null {
  const now = budapestParts(nowMs)
  if (now.hour < OWNER_GO_DIGEST_HOUR) return null
  const yesterday = shiftDay(now.day, -1)
  const floor = shiftDay(now.day, -OWNER_GO_DIGEST_MAX_CATCHUP_DAYS)
  let due = lastSettledDay === null ? yesterday : shiftDay(lastSettledDay, 1)
  if (due < floor) due = floor
  return due <= yesterday ? due : null
}

const DIGEST_STATE: Record<Approval['status'], string> = {
  pending: 'függőben',
  approved: 'jóváhagyva',
  rejected: 'elutasítva',
  timeout: 'lejárt',
}

// Owner-facing digest text. Plain text, proper accents, no request content. Pure + exported for tests.
export function buildOwnerGoDigestText(day: string, rows: Approval[]): string {
  const lines = rows.map((row) => {
    const at = budapestParts(row.requested_at * 1000)
    const time = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`
    const hash = row.content_hash ? row.content_hash.slice(0, 12) : '-'
    const state = row.consumed_at ? 'felhasználva' : DIGEST_STATE[row.status]
    return `${time} | ${row.agent_id} | ${row.category} | boríték ${hash} | GO: ${row.owner_go_ref ?? '-'} | ${state}`
  })
  return [
    `[NAPI ÖSSZESÍTŐ] ${day}: a fő ügynök ${rows.length} email-jóváhagyási kérése meglévő tulajdonosi GO-ra hivatkozott`,
    'Ezekről egyenként nem ment értesítés. Soronként: idő | kérő | kategória | boríték-hash eleje | GO | állapot.',
    ...lines,
    'Részletek: Dashboard -> Jóváhagyások',
  ].join('\n')
}

let digestInFlight = false
let lastDigestFailureMs = 0

// Settles at most one due day per call. Returns what happened (for the sweep log and the tests).
export async function sendOwnerGoDigestIfDue(nowMs: number = Date.now()): Promise<'none' | 'empty' | 'telegram' | 'in_band' | 'failed'> {
  if (digestInFlight) return 'none'
  const day = ownerGoDigestDayDue(nowMs, lastOwnerGoDigestDay())
  if (!day) return 'none'
  const rows = listOwnerGoApprovalsBetween(budapestMidnightUtcMs(day) / 1000, budapestMidnightUtcMs(shiftDay(day, 1)) / 1000)
  if (rows.length === 0) {
    recordOwnerGoDigest(day, 0, 'empty', null)
    return 'empty'
  }
  if (lastDigestFailureMs && nowMs - lastDigestFailureMs < OWNER_GO_DIGEST_RETRY_MS) return 'none'
  digestInFlight = true
  try {
    const text = buildOwnerGoDigestText(day, rows)
    const ownerChat = TELEGRAM_BOT_TOKEN ? resolveOwnerChatId() : null
    if (!TELEGRAM_BOT_TOKEN || !ownerChat) {
      // Same degraded path as a suppressed ping: visible in-band, never dropped.
      logger.warn({ day, rows: rows.length }, 'owner GO digest: no Telegram path to the owner -- delivered in-band to the main agent')
      createAgentMessage('system', MAIN_AGENT_ID, `[OWNER_UNREACHED owner-go-digest] ${text}`)
      recordOwnerGoDigest(day, rows.length, 'in_band', null)
      return 'in_band'
    }
    const messageId = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
    recordOwnerGoDigest(day, rows.length, 'telegram', messageId ?? null)
    lastDigestFailureMs = 0
    logger.info({ day, rows: rows.length, messageId }, 'owner GO digest sent')
    return 'telegram'
  } catch (err) {
    lastDigestFailureMs = nowMs
    logger.warn({ err, day, rows: rows.length }, 'owner GO digest FAILED -- retried after the backoff; the requests are on the dashboard')
    return 'failed'
  } finally {
    digestInFlight = false
  }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
    sendOwnerGoDigestIfDue().catch((err) => logger.warn({ err }, 'owner GO digest sweep failed'))
  }, 60_000)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; timeout_seconds?: unknown; content_hash?: unknown; owner_go_ref?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, timeout_seconds, content_hash, owner_go_ref } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'category is required' }, 400)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }
    // EMAILKAPU901 PR2: the email-approval-gate hook hands the requesting
    // agent this exact sha256 anchor (to+cc+subject+body); a malformed value
    // could never match the gate's recomputation, so reject it loudly here
    // instead of storing a row that silently authorizes nothing.
    if (content_hash !== undefined && (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash))) {
      json(res, { error: 'content_hash must be a 64-char lowercase sha256 hex string if provided' }, 400)
      return true
    }
    if (owner_go_ref !== undefined && (typeof owner_go_ref !== 'string' || !OWNER_GO_REF_RX.test(owner_go_ref.trim()))) {
      json(res, { error: 'owner_go_ref must be a short reference (letters, digits, . _ : # / -; at most 120 characters) if provided' }, 400)
      return true
    }
    const goRef = typeof owner_go_ref === 'string' ? owner_go_ref.trim() : null
    const goHonoured = goRef !== null && ownerGoCoversRequest({ agent_id: agent_id.trim(), category: category.trim(), owner_go_ref: goRef })
    if (goRef !== null && !goHonoured) {
      logger.warn({ agent_id, category }, 'owner_go_ref ignored: only an email_send request of the main agent may cite an owner GO -- the owner is notified as usual')
    }

    const id = randomUUID()
    const timeout_at = computeTimeoutAt(category, timeout_seconds)
    const approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
      content_hash: typeof content_hash === 'string' ? content_hash : null,
      owner_go_ref: goHonoured ? goRef : null,
    })

    if (ownerGoCoversRequest(approval)) {
      logger.info({ approvalId: approval.id, ownerGoRef: approval.owner_go_ref }, 'approval owner notification skipped: the main agent cites an existing owner GO -- listed in the next daily owner digest')
    } else {
      notifyOwner(approval)
    }
    notifyMainAgent(approval)
    logger.info({ id, agent_id, category }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    const items = listApprovals({ agent_id, category, status, limit })
    json(res, items)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    json(res, approval)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
      json(res, { error: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    // Self-approval guard: the requesting agent cannot approve its own request.
    // This is a best-effort check on the self-declared resolved_by value (all fleet
    // agents share the same bearer token, so server-side identity is not enforceable).
    // It catches naive/accidental self-approvals; the real control lives on the
    // main-agent side (approval-request-handling skill).
    const target = getApproval(idMatch[1])
    if (target && resolved_by.trim() === target.agent_id) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    const updated = resolveApproval(idMatch[1], status, resolved_by.trim(), msgId)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'Not found' }, 404)
      } else {
        json(res, { error: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    logger.info({ id: idMatch[1], status, resolved_by }, 'Approval resolved')
    json(res, approval)
    return true
  }

  return false
}
