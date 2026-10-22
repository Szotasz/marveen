import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, TELEGRAM_BOT_TOKEN, CHANNEL_PROVIDER, APP_TZ } from '../../config.js'
import {
  consumeApproval, consumeCategoryApproval,
  CATEGORY_CONSUME_DEFAULT_WINDOW_S, CATEGORY_CONSUME_MAX_WINDOW_S,
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, setApprovalTelegramMessageId,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { resolveOwnerChatId } from '../../owner-chat.js'
import { sendOwnerMessage } from '../../notify.js'
import { sendTelegramMessage } from '../telegram.js'
import { mayIssueCredentials, OWNER_SESSION_REQUIRED } from './auth.js'
import { activeApprovalBot, sendApprovalPrompt } from '../../approval-bot.js'
import type { RouteContext } from './types.js'

// Kanban 80d0e3c6: APPROVING is the owner's decision, so the two routes that make a row approved
// (the born-approved POST and PATCH status=approved) take an owner credential. Measured before:
// a caller with the shared token (every agent holds it) got an approved row on both routes, and
// the real email-approval-gate then let its letter through; through STANDING_CATEGORY the same
// row made every later letter to an address approval-free. The self-declared agent_id and
// resolved_by checks below stay, but they were never what stopped this.
// Who counts as the owner is the predicate that guards issuing credentials (mayIssueCredentials,
// #2163): the owner's session, also when the browser sends the stored token alongside it; the
// bare token only before the first dashboard login exists.
const OWNER_ONLY = {
  ...OWNER_SESSION_REQUIRED,
  error: 'Approving needs the dashboard login (an owner session); the shared dashboard token can file, reject or time out a request, not approve one. ' +
    'The token alone approves only before the first login exists.',
}

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

// f2c5edb0: the window inside which an approved letter may still be consumed,
// counted from resolved_at. The SAME variable and default as the gate
// (EMAIL_APPROVAL_WINDOW_S, 1800 s in scripts/hooks/email-approval-gate.py), so
// the two consume paths agree on when an approval has gone stale.
export function approvalWindowSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number.parseInt(env.EMAIL_APPROVAL_WINDOW_S ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : 1800
}

// The consumer names the sending tool in the audit trail. Printable only (no
// control characters, checked by code point so the source carries no escape),
// 1-120 characters after trimming.
export function isConsumerName(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t.length < 1 || t.length > 120) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

// One RFC 5322 msg-id, angle brackets included: the sender generates it BEFORE
// the send and hands the same value to its mailer, so the approval row names the
// letter that used it.
export function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 250 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(v)
}

// A category key as the autonomy config spells them (email_send, data_delete,
// external_message): lower-case ASCII letter first, then letters, digits, underscore.
export function isCategoryKey(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)
}

// What the acting tool names as the thing that used the approval (a plan id,
// a change-list id). Printable, 1-250 characters after trimming.
export function isConsumeRef(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t.length < 1 || t.length > 250) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

// The window the acting tool asks for, in seconds. Absent = the default;
// anything else must be a whole number inside 1..cap, or the call is refused
// (400) rather than silently clamped, so a tool learns its policy is not what
// it thinks.
export function categoryWindowSeconds(v: unknown): number | null {
  if (v === undefined || v === null) return CATEGORY_CONSUME_DEFAULT_WINDOW_S
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > CATEGORY_CONSUME_MAX_WINDOW_S) return null
  return v
}

// Owner-facing Telegram text. Pure + exported for tests. Plain text (no
// markdown escaping concerns), proper accents: this is outgoing copy.
export function buildOwnerApprovalText(approval: Approval): string {
  const expires = approval.timeout_at
    ? new Date(approval.timeout_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ })
    : 'nincs'
  return [
    `[JÓVÁHAGYÁS KELL] ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    `Lejárat: ${expires}`,
    `Döntés: Dashboard -> Jóváhagyások (id: ${approval.id})`,
  ].join('\n')
}

// The informative variant, for a row the owner already approved in the chat
// before it was filed. Pure + exported for tests. It must NOT read as a
// question -- the owner answering "mehet" a second time to a done deal is
// exactly the noise this replaces -- but it keeps the action visible in the
// owner's chat.
export function buildOwnerChatApprovedText(approval: Approval, ownerMessageId: number | string): string {
  return [
    `[JÓVÁHAGYVA A CHATBEN] ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    `Jóváhagyás: a chat-üzeneted (üzenet-azonosító: ${ownerMessageId})`,
    `Nincs további teendőd, ez csak tájékoztatás.`,
    `Napló: Dashboard -> Jóváhagyások (id: ${approval.id})`,
  ].join('\n')
}

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
//
// With `chatApprovedMessageId` set, the row is already approved (the owner said
// yes in that chat message) and the owner gets the informative note instead of
// the question. Two things differ on that path: the note's own message id is
// NOT stamped (telegram_message_id already names the owner's approving
// message), and a failed note does NOT fall back in-band -- the only requester
// allowed on this path is the main agent, which already knows the action is
// approved; an [APPROVAL_REQUEST] marker would mislead it.
function notifyOwner(approval: Approval, chatApprovedMessageId: number | string | null = null): void {
  const informative = chatApprovedMessageId != null
  const text = informative
    ? buildOwnerChatApprovedText(approval, chatApprovedMessageId)
    : buildOwnerApprovalText(approval)
  void (async () => {
    // 80d0e3c6: with the approval bot on, the question goes out through it, with buttons whose press this
    // server receives (src/approval-bot.ts). If it cannot send (no owner chat, the owner never pressed
    // /start on that bot, Telegram down), the main-bot path below runs as if the bot were off.
    if (!informative) {
      const bot = activeApprovalBot()
      if (bot) {
        try {
          if (await sendApprovalPrompt(bot, approval)) {
            logger.info({ approvalId: approval.id }, 'approval owner notification sent through the approval bot')
            return
          }
          logger.warn({ approvalId: approval.id }, 'approval bot could not send the question: using the main bot')
        } catch (err) {
          logger.warn({ err, approvalId: approval.id }, 'approval bot send FAILED: using the main bot')
        }
      }
    }
    // APPROVALVAK821 fixed this path so the request reaches the OWNER and not
    // only the main agent's queue -- but the fix went out Telegram-only, so on
    // any install that speaks another provider the old silence came straight
    // back. Measured on a Discord install 2026-09-26: every approval request
    // logged `owner notification suppressed: no TELEGRAM_BOT_TOKEN`, the owner
    // was told nothing, and the only notification went to the main agent, i.e.
    // to the very agent whose request it was. An approval gate whose owner
    // never hears about it is not a gate.
    //
    // The Telegram branch is kept for Telegram installs ONLY because it also
    // records the message id (setApprovalTelegramMessageId); every other
    // provider goes through sendOwnerMessage, which resolves provider, token
    // and owner chat the same way every other owner message does.
    if (CHANNEL_PROVIDER === 'telegram' && TELEGRAM_BOT_TOKEN) {
      const ownerChat = resolveOwnerChatId()
      if (!ownerChat) {
        logger.warn({ approvalId: approval.id, informative }, 'approval owner notification suppressed: no owner chat')
        if (!informative) fallbackInBand(approval, 'no-owner-chat')
        return
      }
      try {
        const messageId = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
        if (!informative && messageId != null) setApprovalTelegramMessageId(approval.id, messageId)
        logger.info({ approvalId: approval.id, messageId, informative }, 'approval owner notification sent')
      } catch (err) {
        logger.warn({ err, approvalId: approval.id, informative }, 'approval owner notification FAILED -- the request is only visible on the dashboard')
        if (!informative) fallbackInBand(approval, 'send-failed')
      }
      return
    }

    // sendOwnerMessage REPORTS whether it went out (PR1655 review, ask 2). The
    // funnel it wraps swallows every provider exception, so a `catch` here
    // would be unreachable and a failed Discord send would be recorded as a
    // delivered notification. The result is read instead.
    // The literals below are deliberate, not a computed reason string: the
    // delivery contract test (approvals-delivery.test.ts) reads this function's
    // SOURCE and requires every failure path to name its fallback explicitly.
    // That test exists so a refactor cannot quietly drop a fallback -- and it
    // caught exactly that when this branch first used a template string.
    const r = await sendOwnerMessage(text)
    if (r.sent) {
      logger.info({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative }, 'approval owner notification sent')
      return
    }
    if (r.reason === 'no-token') {
      logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative },
        'approval owner notification suppressed: no channel token')
      if (!informative) fallbackInBand(approval, 'no-token')
      return
    }
    if (r.reason === 'no-owner-chat') {
      logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative },
        'approval owner notification suppressed: no owner chat')
      if (!informative) fallbackInBand(approval, 'no-owner-chat')
      return
    }
    logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, reason: r.reason, informative },
      'approval owner notification FAILED -- the request is only visible on the dashboard')
    if (!informative) fallbackInBand(approval, 'send-failed')
  })()
}

function notifyMainAgent(approval: Approval): void {
  // APPROVALVAK821 (b): when the requester IS the main agent, this used to
  // deliver the notification back to the requester itself -- which counted as
  // "notified" while no human ever saw it. The owner Telegram above is the
  // real notification; a self-addressed message is noise that hides the gap.
  if (approval.agent_id === MAIN_AGENT_ID) {
    logger.info({ approvalId: approval.id }, 'approval main-agent notify skipped: requester is the main agent (owner is notified on Telegram)')
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

// MARVEENGAPS1020 (a): a route that needs an approval files it itself, with a
// description it built from the real object, on the same path as POST
// /api/approvals: same row, same timeout rule, same owner and main-agent
// notification. The requester cannot word the request the owner reads.
export function fileServerApproval(params: {
  agent_id: string
  category: string
  action_description: string
  action_payload?: string | null
  content_hash: string
}): Approval {
  const approval = createApproval({
    id: randomUUID(),
    agent_id: params.agent_id,
    category: params.category,
    action_description: params.action_description,
    action_payload: params.action_payload ?? null,
    timeout_at: computeTimeoutAt(params.category, undefined),
    content_hash: params.content_hash,
  })
  notifyOwner(approval)
  notifyMainAgent(approval)
  logger.info({ id: approval.id, agent_id: approval.agent_id, category: approval.category }, 'Approval request filed by the server')
  return approval
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

// POST /api/approvals/:id/consume with a category other than email_send. The
// acting tool calls it right BEFORE its first irreversible write and acts only
// on 200; 409 means do NOT act (used, unapproved, another plan, another
// category, stale). Same answer shapes as the letter path. email_send and
// data_delete rows are refused here (wrong_category): the server consumes
// those on their own paths.
function handleCategoryConsume(ctx: RouteContext, id: string, body: Record<string, unknown>): void {
  const { res } = ctx
  const { category, content_hash, consumer, ref, max_age_seconds } = body
  if (!isCategoryKey(category)) {
    json(res, { error: 'category must be a category key (lower-case letters, digits, underscore; max 64)' }, 400)
    return
  }
  if (content_hash !== undefined && content_hash !== null && (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash))) {
    json(res, { error: 'content_hash, if given, must be the 64-char lowercase sha256 hex anchor the approval was requested with' }, 400)
    return
  }
  if (!isConsumerName(consumer)) {
    json(res, { error: 'consumer is required: 1-120 printable characters naming the acting tool' }, 400)
    return
  }
  if (ref !== undefined && ref !== null && !isConsumeRef(ref)) {
    json(res, { error: 'ref, if given, must be 1-250 printable characters' }, 400)
    return
  }
  const windowSeconds = categoryWindowSeconds(max_age_seconds)
  if (windowSeconds === null) {
    json(res, { error: `max_age_seconds, if given, must be a whole number of seconds between 1 and ${CATEGORY_CONSUME_MAX_WINDOW_S}` }, 400)
    return
  }
  const result = consumeCategoryApproval({
    id,
    category,
    contentHash: typeof content_hash === 'string' ? content_hash : null,
    consumer: consumer.trim(),
    ref: typeof ref === 'string' ? ref.trim() : null,
    windowSeconds,
  })
  if (result.ok) {
    logger.info({ id, category, consumer: consumer.trim(), ref: ref ?? null }, 'Approval consumed by the acting tool')
    json(res, { ok: true, approval: result.approval })
    return
  }
  if (result.reason === 'not_found') {
    json(res, { ok: false, reason: 'not_found' }, 404)
    return
  }
  const a = result.approval
  logger.warn({ id, category, consumer: consumer.trim(), reason: result.reason }, 'Approval consume refused')
  json(res, {
    ok: false,
    reason: result.reason,
    approval: a ? { id: a.id, status: a.status, consumed_at: a.consumed_at, consumed_by: a.consumed_by, consumed_ref: a.consumed_ref } : null,
  }, 409)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; timeout_seconds?: unknown; content_hash?: unknown; owner_approved_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, timeout_seconds, content_hash, owner_approved_message_id } = body
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

    // The main agent may file an approval for an action the
    // owner ALREADY approved in the chat, naming the owner's approving
    // message. Such a row is born approved and the owner is told, not asked.
    // Only the main agent: it is the one reading the owner's chat. Any other
    // requester sending the field is refused outright (not silently ignored),
    // so a caller relying on the field learns at once that it does not apply.
    // A sub-agent that declares its own name is refused; the check rests on
    // the self-declared agent_id, and any holder of the shared dashboard token
    // can send the main agent's name and get a row born approved.
    //
    // The server does not verify the id: it does not check that the message
    // exists, came from the owner, is recent, or refers to this action. Any
    // value of the right shape passes. Whether the owner approved this action
    // in the chat is the main agent's judgement, not a server check.
    //
    // The id is the owner's approving chat message: a positive integer
    // (Telegram), or a short id string for providers whose message ids are not
    // safe integers (a Slack ts, a Discord snowflake). Only an integer id is
    // stored in the row's telegram_message_id column (INTEGER, the same column
    // PATCH writes); a string id is kept in the owner note and the log line.
    let chatApprovedMessageId: number | string | null = null
    if (owner_approved_message_id !== undefined && owner_approved_message_id !== null) {
      if (!mayIssueCredentials(ctx.auth, req)) {
        logger.warn({ agent_id, category, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'born-approved approval refused: no owner session')
        json(res, OWNER_ONLY, 403)
        return true
      }
      if (agent_id.trim() !== MAIN_AGENT_ID) {
        json(res, { error: 'owner_approved_message_id is only accepted from the main agent; a requesting agent cannot pre-approve its own request' }, 400)
        return true
      }
      const okInt = typeof owner_approved_message_id === 'number' && Number.isSafeInteger(owner_approved_message_id) && owner_approved_message_id > 0
      const okStr = typeof owner_approved_message_id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(owner_approved_message_id)
      if (!okInt && !okStr) {
        json(res, { error: 'owner_approved_message_id must be the owner\'s approving chat message id (a positive integer, or an id string of 1-64 [A-Za-z0-9._:-] characters) if provided' }, 400)
        return true
      }
      chatApprovedMessageId = owner_approved_message_id as number | string
    }

    const id = randomUUID()
    const timeout_at = computeTimeoutAt(category, timeout_seconds)
    let approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
      content_hash: typeof content_hash === 'string' ? content_hash : null,
    })
    if (chatApprovedMessageId != null) {
      // Same resolve path as PATCH, so the row is indistinguishable from a
      // PATCH-approved one for every reader (e.g. the email-approval-gate).
      resolveApproval(id, 'approved', `${CHANNEL_PROVIDER}_text`,
        typeof chatApprovedMessageId === 'number' ? chatApprovedMessageId : null)
      approval = getApproval(id) ?? approval
    }

    notifyOwner(approval, chatApprovedMessageId)
    notifyMainAgent(approval)
    logger.info({ id, agent_id, category, chatApprovedMessageId }, chatApprovedMessageId != null ? 'Approval created as already approved in chat' : 'Approval request created')
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

  // POST /api/approvals/:id/consume -- f2c5edb0: one-shot consumption on the
  // SEND path. A sender the gate cannot see (a script that mails from another
  // host) calls this right BEFORE the letter goes out and sends only on 200.
  // 409 means do NOT send: the approval is used, unapproved, for another letter,
  // or stale -- and a second attempt on a used approval is the double send this
  // exists to stop.
  // With "category": "<key>" (anything but email_send) the same route consumes
  // an approval of that category once, for the tool about to act on it
  // (handleCategoryConsume above).
  const consumeMatch = path.match(/^\/api\/approvals\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    let body: { content_hash?: unknown; consumer?: unknown; message_id?: unknown; category?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      json(res, { error: 'body must be a JSON object' }, 400)
      return true
    }
    // A body naming any category other than email_send is the generic one-shot
    // path. No category (or email_send, or null) is the letter path below,
    // exactly as before.
    if (body.category !== undefined && body.category !== null && body.category !== 'email_send') {
      handleCategoryConsume(ctx, consumeMatch[1], body as Record<string, unknown>)
      return true
    }
    const { content_hash, consumer, message_id } = body
    if (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash)) {
      json(res, { error: 'content_hash must be the 64-char lowercase sha256 hex anchor of the letter being sent' }, 400)
      return true
    }
    if (!isConsumerName(consumer)) {
      json(res, { error: 'consumer is required: 1-120 printable characters naming the sending tool' }, 400)
      return true
    }
    if (message_id !== undefined && message_id !== null && !isMessageId(message_id)) {
      json(res, { error: 'message_id, if given, must be one RFC 5322 id like <local@domain> (max 250 chars)' }, 400)
      return true
    }
    const result = consumeApproval({
      id: consumeMatch[1],
      contentHash: content_hash,
      consumer: consumer.trim(),
      messageId: typeof message_id === 'string' ? message_id : null,
      windowSeconds: approvalWindowSeconds(),
    })
    if (result.ok) {
      logger.info({ id: consumeMatch[1], consumer: consumer.trim(), ref: message_id ?? null }, 'Approval consumed by the send path')
      json(res, { ok: true, approval: result.approval })
      return true
    }
    if (result.reason === 'not_found') {
      json(res, { ok: false, reason: 'not_found' }, 404)
      return true
    }
    const a = result.approval
    logger.warn({ id: consumeMatch[1], consumer: consumer.trim(), reason: result.reason }, 'Approval consume refused')
    json(res, {
      ok: false,
      reason: result.reason,
      approval: a ? { id: a.id, status: a.status, consumed_at: a.consumed_at, consumed_by: a.consumed_by, consumed_ref: a.consumed_ref } : null,
    }, 409)
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

    // Approving takes the owner (see OWNER_ONLY); rejecting or timing out does not, since
    // an agent that cancels a request gains nothing by it.
    if (status === 'approved' && !mayIssueCredentials(ctx.auth, req)) {
      logger.warn({ id: idMatch[1], resolved_by, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'approval approve refused: no owner session')
      json(res, OWNER_ONLY, 403)
      return true
    }

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
