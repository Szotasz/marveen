import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, TELEGRAM_BOT_TOKEN, CHANNEL_PROVIDER, APP_TZ, PERMISSION_BOT_ID } from '../../config.js'
import {
  consumeApproval,
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals, clearSpentEmailPayloads,
  createAgentMessage, setApprovalTelegramMessageId, resolveApprovalFromTelegram,
  setApprovalCallbackNonceHashes,
  setPermissionBotNonceHashes, resolveApprovalFromPermissionBot, isOwnerVerified, consumeOwnerRunApproval,
  type Approval, type ApprovalTelegramRefusal, type PermissionBotRefusal, type OwnerRunConsumeRefusal,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { resolveOwnerChatId, resolveAlertOwnerChat } from '../../owner-chat.js'
import { sendOwnerMessage } from '../../notify.js'
import { channelStateDir, readChannelToken } from '../../channel-provider.js'
import { TEST_RUN_PREFIX } from '../../test-run-marker.js'
import { sendTelegramMessage, clearTelegramInlineKeyboard, type TelegramInlineKeyboard } from '../telegram.js'
import { getSecret } from '../vault.js'
import { PERMISSION_BOT_VAULT_ID } from '../permission-bot-vault.js'
import {
  RAG_RESERVED_PREFIX, isPermissionBotCategory, parseRagApprovalPayload,
  validateRagApprovalRequest, type RagApprovalPayload,
} from '../rag-approval-payload.js'
import { envelopeBinding, type EnvelopeUnboundReason, type EnvelopeV1 } from '../../approval-envelope.js'
import { buildCallbackData, isCallbackNonce, newCallbackNonce, nonceHash } from '../approval-callback-data.js'
import {
  buildBoundApprovalMessages, formatOutcomeText,
  type EnvelopeView,
} from '../approval-telegram-text.js'
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
// the question. Three things differ on that path: the note carries no buttons,
// the note's own message id is NOT stamped (telegram_message_id already names
// the owner's approving message), and a failed note does NOT fall back in-band
// -- the only requester allowed on this path is the main agent, which already
// knows the action is approved; an [APPROVAL_REQUEST] marker would mislead it.
//
// A bound email_send approval goes out as the full letter with approve/reject
// buttons (sendOwnerNotification below); everything else as the plain text
// above. The sends are queued, one notification at a time, in the background:
// the POST never waits for the queue.
function notifyOwner(approval: Approval, chatApprovedMessageId: number | string | null = null): void {
  // Card 9a77b3e5: a permission-bot category goes out through the permission
  // bot ONLY, never through the main bot's token below.
  if (isPermissionBotCategory(approval.category)) {
    notifyPermissionBot(approval)
    return
  }
  const informative = chatApprovedMessageId != null
  const text = informative
    ? buildOwnerChatApprovedText(approval, chatApprovedMessageId)
    : buildOwnerApprovalText(approval)
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
  // records the message id (setApprovalTelegramMessageId) and can carry the
  // approve/reject buttons; every other provider goes through
  // sendOwnerMessage, which resolves provider, token and owner chat the same
  // way every other owner message does.
  if (CHANNEL_PROVIDER === 'telegram' && TELEGRAM_BOT_TOKEN) {
    const ownerChat = resolveOwnerChatId()
    if (!ownerChat) {
      logger.warn({ approvalId: approval.id, informative }, 'approval owner notification suppressed: no owner chat')
      if (!informative) fallbackInBand(approval, 'no-owner-chat')
      return
    }
    const token = TELEGRAM_BOT_TOKEN
    if (informative) {
      enqueueOwnerNotification(approval.id, async () => {
        try {
          const messageId = await sendTelegramMessage(token, ownerChat, text)
          logger.info({ approvalId: approval.id, messageId, informative }, 'approval owner notification sent')
        } catch (err) {
          logger.warn({ err, approvalId: approval.id, informative }, 'approval owner notification FAILED -- the request is only visible on the dashboard')
        }
      })
      return
    }
    enqueueOwnerNotification(approval.id, async () => {
      try {
        // The queue may have held this notification for a while: send from the
        // row as it is NOW. A request that was decided, swept or ran past its
        // deadline meanwhile is not announced any more.
        const current = getApproval(approval.id)
        const nowS = Math.floor(Date.now() / 1000)
        if (!current || current.status !== 'pending' || (current.timeout_at != null && current.timeout_at <= nowS)) {
          logger.info({
            approvalId: approval.id,
            status: current?.status ?? null,
            expired: current?.timeout_at != null && current.timeout_at <= nowS,
          }, 'approval owner notification skipped: decided, expired or gone while it waited in the queue')
          return
        }
        const sent = await sendOwnerNotification(token, ownerChat, current)
        const messageId = sent.messageId
        if (messageId != null && !setApprovalTelegramMessageId(approval.id, messageId)) {
          // First stamp wins: the row is gone, or something stamped it first.
          logger.warn({ approvalId: approval.id }, 'approval owner notification sent, but its message id was NOT stamped onto the row')
        }
        if (sent.buttons && messageId == null) {
          logger.warn({ approvalId: approval.id }, 'approval button message sent without a message_id: NOT bound, every press will be refused (not_bound) -- decide on the dashboard')
        }
        logger.info({
          approvalId: approval.id,
          messageId,
          buttons: sent.buttons,
          ...(sent.withheld ? { buttons_withheld: sent.withheld } : {}),
        }, 'approval owner notification sent')
      } catch (err) {
        // A bound send rethrows a scrubbed error (no nonce); see sendOwnerNotification.
        logger.warn({ err, approvalId: approval.id }, 'approval owner notification FAILED -- the request is only visible on the dashboard')
        fallbackInBand(approval, 'send-failed')
      }
    })
    return
  }

  void (async () => {
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

// Approval notifications go out one at a time, in arrival order (an
// in-process promise chain), so the messages of two notifications (a failed
// button message and its plain notice, say) never interleave in the owner's
// chat. A failed notification never breaks the chain. Other messages of the
// same bot are not ordered against these (accepted trade-off).
let ownerNotificationQueue: Promise<void> = Promise.resolve()

function enqueueOwnerNotification(approvalId: string, task: () => Promise<void>): void {
  // Each task starts on its own macrotask, after the POST's response is out:
  // even its synchronous part (hashing, file reads) never delays the reply.
  ownerNotificationQueue = ownerNotificationQueue
    .then(() => new Promise<void>(r => setImmediate(r)))
    .then(task)
    .catch(() => {
    // The task catches its own failures; this is only the backstop that keeps
    // the chain alive. The error is not logged: it could carry the nonce.
      logger.warn({ approvalId }, 'approval owner notification aborted unexpectedly -- the request is only visible on the dashboard')
    })
}

/** Test seam: settles once every owner notification queued so far is done. */
export function ownerNotificationsSettled(): Promise<void> {
  return ownerNotificationQueue
}

// --- Owner notification with approve/reject buttons ---
//
// The buttons go out only when ALL of these hold; otherwise the plain
// notification goes out (buildOwnerApprovalText, "Döntés: Dashboard") and the
// reason is logged:
//   - the envelope is bound: the action_payload is the very letter its
//     content_hash approves (approval-envelope.ts);
//   - the strict owner (resolveAlertOwnerChat, a positive user id) is the chat
//     this notification goes to -- the Telegram decision endpoint accepts a
//     press from that user only, in that private chat;
//   - the main channel state dir is the install-scoped one: the plugin derives
//     this install's dashboard from it;
//   - the bot that sends is the bot the main channel plugin polls (equal bot
//     ids, the part of the token before the colon) -- otherwise the press
//     would reach another process. Neither token is logged or returned;
//   - the WHOLE letter (every identifying line and the full body) fits the ONE
//     message that carries the buttons (fail-closed). Every bot message
//     in the owner's chat can be rewritten by the main agent's edit_message
//     tool. A letter split over several messages would leave its body in
//     messages without buttons, which an injected agent could rewrite before
//     the owner decides. Kept in the button message, the body cannot change
//     without the buttons going with it: the plugin's edit_message sends no
//     reply_markup, and an edit without one takes the inline keyboard off.
//     A longer letter gets the plain notification with TOO_LONG_FOR_BUTTONS;
//   - both button nonces bind to the row (setApprovalCallbackNonceHashes).
// Order: two nonces (one per button) -> their hashes onto the row -> the one
// message with the buttons -> the message id stamp (by the caller). A 429 is
// retried once, after its retry_after (capped). Any other failure, or a second
// 429, gives up on the buttons: one best-effort plain notification follows,
// APPROVAL_PART_PAUSE_MS later and NOT stamped -- the row stays not_bound, so
// the owner learns to decide on the dashboard and no press can bind. The
// nonces exist only inside sendOwnerNotification and in the buttons'
// callback_data: never in a log line, an error, or a message text.

const TELEGRAM_TEXT_LIMIT = 4096
// Room the plugin needs to append the outcome line under the button message.
const APPROVAL_OUTCOME_RESERVE = 300

// The line under the plain notification of a bound letter too long for the
// one button message.
export const TOO_LONG_FOR_BUTTONS =
  'A levél túl hosszú a gombos jóváhagyáshoz (nem fér egy üzenetbe), a dashboardon dönts.'

// Pause before the plain notice that follows a failed button message, and the
// cap on a 429 wait.
export const APPROVAL_PART_PAUSE_MS = 1000
export const APPROVAL_RETRY_AFTER_CAP_S = 30
// A 429 without a readable retry_after (Telegram always sends one).
const APPROVAL_RETRY_AFTER_DEFAULT_S = 3

type Sleep = (ms: number) => Promise<void>
let ownerNotificationSleep: Sleep = ms => new Promise(r => setTimeout(r, ms))

/** Test seam: replace the pause/429 sleep; returns the previous one. */
export function setOwnerNotificationSleep(sleep: Sleep): Sleep {
  const prev = ownerNotificationSleep
  ownerNotificationSleep = sleep
  return prev
}

const APPROVE_BUTTON_TEXT = '✅ Jóváhagyom'
const REJECT_BUTTON_TEXT = '❌ Elutasítom'

// Why a notification went out without buttons. Safe to log: no hash, no
// letter content, no token.
export type ApprovalButtonsWithheld =
  | EnvelopeUnboundReason
  | 'bad_id' | 'owner_unresolved' | 'owner_chat_mismatch' | 'state_dir_not_install_scoped'
  | 'bot_mismatch' | 'too_long' | 'nonce_not_bound'

// The everyday reasons (not an email, or a requester that sent no envelope)
// ride on the "sent" line; everything else is a misconfiguration, a payload
// that does not match its hash, or a letter too long for the buttons, and gets
// its own warning.
const QUIET_WITHHELD = new Set<ApprovalButtonsWithheld>(['not_email_send', 'no_content_hash', 'no_payload'])

/**
 * The bot id of a Bot API token: the decimal part before the colon, or null.
 * Only the id leaves this function; the secret part is never returned.
 */
export function telegramBotId(token: string | null | undefined): string | null {
  if (typeof token !== 'string') return null
  const t = token.trim()
  const colon = t.indexOf(':')
  if (colon <= 0 || colon === t.length - 1) return null
  const id = t.slice(0, colon)
  return /^[1-9][0-9]{0,19}$/.test(id) ? id : null
}

/** True when both tokens belong to the same bot (equal bot ids, both well-formed). */
export function sameTelegramBot(a: string | null | undefined, b: string | null | undefined): boolean {
  const ia = telegramBotId(a)
  return ia != null && ia === telegramBotId(b)
}

// The install's own channel state dir, the one the plugin is started with.
function installTelegramStateDir(): string {
  return join(PROJECT_ROOT, '.claude', 'channels', 'telegram')
}

// The owner/bot/state-dir preconditions, or null when they all hold.
function buttonPreconditionRefusal(sendToken: string, ownerChat: string): ApprovalButtonsWithheld | null {
  const ownerId = telegramOwnerUserId()
  if (ownerId == null) return 'owner_unresolved'
  if (ownerId !== ownerChat) return 'owner_chat_mismatch'
  const stateDir = channelStateDir('telegram')
  if (resolve(stateDir) !== resolve(installTelegramStateDir())) return 'state_dir_not_install_scoped'
  if (!sameTelegramBot(sendToken, readChannelToken('telegram', join(stateDir, '.env')))) return 'bot_mismatch'
  return null
}

function envelopeView(env: EnvelopeV1): EnvelopeView {
  const view: EnvelopeView = { to: env.to, cc: env.cc, bcc: env.bcc, text: env.text }
  if (env.subject !== undefined) view.subjectHint = env.subject
  if (env.html_sha256 !== undefined) view.htmlSha256 = env.html_sha256
  if (env.attachments !== undefined) view.attachments = env.attachments
  return view
}

type ButtonPlan =
  | { ok: true; message: string }
  | { ok: false; reason: ApprovalButtonsWithheld }

function planButtonNotification(approval: Approval, sendToken: string, ownerChat: string): ButtonPlan {
  const binding = envelopeBinding(approval)
  if (!binding.bound) return { ok: false, reason: binding.reason }
  if (!APPROVAL_ID_RE.test(approval.id)) return { ok: false, reason: 'bad_id' }
  const refusal = buttonPreconditionRefusal(sendToken, ownerChat)
  if (refusal) return { ok: false, reason: refusal }
  // The budget: Telegram's 4096, minus the test-run prefix sendTelegramMessage
  // may put in front, minus APPROVAL_OUTCOME_RESERVE for the outcome line the
  // plugin appends on a decision. buildBoundApprovalMessages answers with zero chunks exactly when
  // the single message fits that budget; anything else is too long here.
  const messages = buildBoundApprovalMessages(envelopeView(binding.envelope), {
    agentId: approval.agent_id,
    shortId: approval.id.slice(0, 8),
    hash8: (approval.content_hash ?? '').slice(0, 8),
    timeoutAt: approval.timeout_at,
    windowMinutes: Math.floor(approvalWindowSeconds() / 60),
  }, { limit: TELEGRAM_TEXT_LIMIT - TEST_RUN_PREFIX.length, reserve: APPROVAL_OUTCOME_RESERVE })
  if ('unfit' in messages || messages.chunks.length > 0) return { ok: false, reason: 'too_long' }
  return { ok: true, message: messages.final }
}

function approvalButtons(approvalId: string, approveNonce: string, rejectNonce: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[
      { text: APPROVE_BUTTON_TEXT, callback_data: buildCallbackData('approved', approvalId, approveNonce) },
      { text: REJECT_BUTTON_TEXT, callback_data: buildCallbackData('rejected', approvalId, rejectNonce) },
    ]],
  }
}

// The message of an error, with every occurrence of each secret cut out.
function scrubbedErrorText(err: unknown, secrets: string[]): string {
  let text = err instanceof Error ? err.message : String(err)
  for (const secret of secrets) text = text.split(secret).join('<redacted>')
  return text
}

type OwnerSendResult = {
  // The id to stamp onto the row: the plain message's, or the button message's.
  messageId: number | null
  buttons: boolean
  withheld?: ApprovalButtonsWithheld
}

async function sendOwnerNotification(token: string, ownerChat: string, approval: Approval): Promise<OwnerSendResult> {
  const plan = planButtonNotification(approval, token, ownerChat)
  let withheld: ApprovalButtonsWithheld | undefined = plan.ok ? undefined : plan.reason

  let nonces: string[] = []
  let keyboard: TelegramInlineKeyboard | null = null
  if (plan.ok) {
    const approveNonce = newCallbackNonce()
    const rejectNonce = newCallbackNonce()
    nonces = [approveNonce, rejectNonce]
    keyboard = approvalButtons(approval.id, approveNonce, rejectNonce)
    if (!setApprovalCallbackNonceHashes(approval.id, { approved: nonceHash(approveNonce), rejected: nonceHash(rejectNonce) })) {
      // Decided, swept or already bound in the meantime: no button can win.
      withheld = 'nonce_not_bound'
      nonces = []
      keyboard = null
    }
  }

  if (!plan.ok || keyboard == null) {
    if (withheld && !QUIET_WITHHELD.has(withheld)) {
      logger.warn({ approvalId: approval.id, reason: withheld }, 'approval owner notification goes out WITHOUT buttons -- decide on the dashboard')
    }
    const plain = buildOwnerApprovalText(approval)
    const text = withheld === 'too_long' ? `${plain}\n${TOO_LONG_FOR_BUTTONS}` : plain
    const messageId = await sendTelegramMessage(token, ownerChat, text)
    return { messageId, buttons: false, ...(withheld ? { withheld } : {}) }
  }

  let messageId: number | null
  try {
    messageId = await sendButtonMessage(token, ownerChat, plan.message, approval.id, keyboard)
  } catch (err) {
    await sendPlainAfterFailure(token, ownerChat, approval)
    // The request carried the nonces: only a scrubbed message travels on.
    throw new Error(`approval button message failed: ${scrubbedErrorText(err, nonces)}`)
  }
  return { messageId, buttons: true }
}

/**
 * Seconds to wait before the one retry of a send Telegram refused with 429
 * (an HTTP 429, or ok:false with error_code 429), capped at
 * APPROVAL_RETRY_AFTER_CAP_S; null for any other error.
 */
export function telegramRetryAfterSeconds(err: unknown): number | null {
  const text = err instanceof Error ? err.message : ''
  if (!/^Telegram API 429\b/.test(text)) return null
  const m = /"retry_after"\s*:\s*(\d{1,6})/.exec(text) ?? /retry after (\d{1,6})/i.exec(text)
  const s = m ? Number(m[1]) : APPROVAL_RETRY_AFTER_DEFAULT_S
  return Math.min(Math.max(s, 1), APPROVAL_RETRY_AFTER_CAP_S)
}

// The button message: one retry after a 429, none otherwise (a timed-out send
// may have landed; repeating it would duplicate the message). The error travels
// on unchanged; the caller scrubs it. Nothing here logs it.
async function sendButtonMessage(
  token: string, chatId: string, text: string, approvalId: string, keyboard: TelegramInlineKeyboard,
): Promise<number | null> {
  try {
    return await sendTelegramMessage(token, chatId, text, keyboard)
  } catch (err) {
    const waitS = telegramRetryAfterSeconds(err)
    if (waitS == null) throw err
    logger.warn({ approvalId, waitS }, 'approval notification hit the Telegram rate limit (429): one retry after the wait')
    await ownerNotificationSleep(waitS * 1000)
    return await sendTelegramMessage(token, chatId, text, keyboard)
  }
}

// After a failed button message the owner holds no decision message. One
// attempt at the plain notification tells them to decide on the dashboard. Its
// message id is deliberately NOT stamped: the row stays not_bound, so no press
// can decide it.
async function sendPlainAfterFailure(token: string, ownerChat: string, approval: Approval): Promise<void> {
  try {
    await ownerNotificationSleep(APPROVAL_PART_PAUSE_MS)
    await sendTelegramMessage(token, ownerChat, buildOwnerApprovalText(approval))
    logger.info({ approvalId: approval.id }, 'approval plain notification sent after the failed button notification (not stamped, not bound)')
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'approval plain notification after the failed button notification failed too')
  }
}

// --- Card 9a77b3e5: the permission bot (rag_production_d, permission_bot_probe) ---
//
// The owner's buttons for these rows are sent by the permission bot
// (@fireeng_engedely_bot), whose token the dashboard reads in-process from the
// Vault entry below. The token is never logged, returned or put in a message;
// only its bot id (the part before the colon) is ever used outside the send
// call itself. The callback comes back through the relay (POST
// /api/approvals/:id/permission-bot); this process only SENDS, it never polls.
export { PERMISSION_BOT_VAULT_ID }

type PermissionBotTokenReader = () => string | null
const vaultPermissionBotToken: PermissionBotTokenReader = () => {
  try { return getSecret(PERMISSION_BOT_VAULT_ID) } catch { return null }
}
let permissionBotTokenReader: PermissionBotTokenReader = vaultPermissionBotToken

/** Test seam: replace the Vault read of the permission-bot token (null = the real one); returns the previous reader. */
export function setPermissionBotTokenReader(reader: PermissionBotTokenReader | null): PermissionBotTokenReader {
  const prev = permissionBotTokenReader
  permissionBotTokenReader = reader ?? vaultPermissionBotToken
  return prev
}

// The tokens of the main bot as far as this install knows it: the one the main
// channel plugin polls, then the one the dashboard's own sends use.
function mainBotTokens(): string[] {
  const tokens: string[] = []
  try {
    const channel = readChannelToken('telegram', join(channelStateDir('telegram'), '.env'))
    if (telegramBotId(channel) != null && channel) tokens.push(channel)
  } catch { /* unreadable: the other source decides */ }
  if (telegramBotId(TELEGRAM_BOT_TOKEN) != null) tokens.push(TELEGRAM_BOT_TOKEN)
  return tokens
}

export type PermissionBotUnavailable =
  | 'bot_id_unpinned' | 'token_missing' | 'token_malformed' | 'token_bot_mismatch'
  | 'main_bot_unresolved' | 'same_as_main_bot'

type PermissionBot =
  | { ok: true; token: string; botId: string }
  | { ok: false; reason: PermissionBotUnavailable }

type PermissionBotWithMain =
  | { ok: true; token: string; botId: string; mainBotId: string }
  | { ok: false; reason: PermissionBotUnavailable }

// The permission bot as configured NOW. Its id is the PINNED PERMISSION_BOT_ID
// (process env / install .env at startup, outside the Bearer's reach); the Vault
// token is only the credential to SEND with, and only while its bot id (the part
// before the colon) IS the pinned id. A missing or malformed pin, no token, a
// malformed token, or a token of another bot is no bot (fail-closed): a token
// swapped into the Vault is never used and never defines who may approve.
function resolvePermissionBot(): PermissionBot {
  const pinned = PERMISSION_BOT_ID
  if (typeof pinned !== 'string' || !TELEGRAM_BOT_ID_RE.test(pinned)) return { ok: false, reason: 'bot_id_unpinned' }
  let raw: string | null = null
  try { raw = permissionBotTokenReader() } catch { raw = null }
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (token === '') return { ok: false, reason: 'token_missing' }
  const tokenBotId = telegramBotId(token)
  if (tokenBotId == null) return { ok: false, reason: 'token_malformed' }
  if (tokenBotId !== pinned) return { ok: false, reason: 'token_bot_mismatch' }
  return { ok: true, token, botId: pinned }
}

// The same, plus the main bot's id: the SEND and the decision paths need it (the
// permission bot must not be the main bot, and a main-bot press must never
// decide). The consume path does not: it only compares against the pinned id.
function resolvePermissionBotWithMain(): PermissionBotWithMain {
  const bot = resolvePermissionBot()
  if (!bot.ok) return bot
  const mains = mainBotTokens()
  const mainBotId = mains.length > 0 ? telegramBotId(mains[0]) : null
  if (mainBotId == null) return { ok: false, reason: 'main_bot_unresolved' }
  if (mainBotId === bot.botId || mains.some(m => sameTelegramBot(m, bot.token))) return { ok: false, reason: 'same_as_main_bot' }
  return { ok: true, token: bot.token, botId: bot.botId, mainBotId }
}

// The owner-facing text of a permission-bot request. Built from the stored,
// validated payload -- never from the requester's action_description -- so
// the owner reads the package, run and window he is approving.
export function buildPermissionBotText(approval: Approval, payload: RagApprovalPayload): string {
  const title = approval.category === 'permission_bot_probe'
    ? 'Engedély-bot próba (nem engedélyez semmit)'
    : 'RAG éles futás (D) jóváhagyása'
  return [
    title,
    `Kérő ügynök: ${approval.agent_id}`,
    `Azonosító: ${approval.id.slice(0, 8)}`,
    `Csomag (sha256 első 16 jele): ${payload.package_sha256.slice(0, 16)}`,
    `Futás (run_id): ${payload.run_id}`,
    `Írási ablak: ${budapestTime(payload.write_window_start)} - ${budapestTime(payload.write_window_end)} (Budapest)`,
    `Lejárat: ${approval.timeout_at ? budapestTime(approval.timeout_at) : 'nincs'}`,
  ].join('\n')
}

function notifyPermissionBot(approval: Approval): void {
  const bot = resolvePermissionBotWithMain()
  if (!bot.ok) {
    logger.warn({ approvalId: approval.id, reason: bot.reason }, 'permission-bot approval NOT sent: the permission bot is unavailable -- the owner was not asked')
    fallbackInBand(approval, 'permission-bot-unavailable')
    return
  }
  const ownerChat = telegramOwnerUserId()
  if (ownerChat == null) {
    logger.warn({ approvalId: approval.id, reason: 'owner_unresolved' }, 'permission-bot approval NOT sent: the strict owner is unresolved -- the owner was not asked')
    fallbackInBand(approval, 'no-owner-chat')
    return
  }
  enqueueOwnerNotification(approval.id, async () => {
    const secretPart = bot.token.slice(bot.token.indexOf(':') + 1)
    try {
      const current = getApproval(approval.id)
      const nowS = Math.floor(Date.now() / 1000)
      if (!current || current.status !== 'pending' || (current.timeout_at != null && current.timeout_at <= nowS)) {
        logger.info({ approvalId: approval.id, status: current?.status ?? null }, 'permission-bot approval notification skipped: decided, expired or gone while it waited in the queue')
        return
      }
      const parsed = parseRagApprovalPayload(current.action_payload, current.category)
      if (!parsed.ok) {
        logger.warn({ approvalId: approval.id, field: parsed.field }, 'permission-bot approval NOT sent: the stored payload is not the canonical one')
        return
      }
      const approveNonce = newCallbackNonce()
      const rejectNonce = newCallbackNonce()
      // The hashes go onto the row BEFORE the message: a press can only ever
      // match a button that exists.
      if (!setPermissionBotNonceHashes(approval.id, { approved: nonceHash(approveNonce), rejected: nonceHash(rejectNonce) })) {
        logger.warn({ approvalId: approval.id, reason: 'nonce_not_bound' }, 'permission-bot approval NOT sent: the buttons could not be bound to the row')
        return
      }
      const keyboard = approvalButtons(approval.id, approveNonce, rejectNonce)
      let messageId: number | null
      try {
        messageId = await sendButtonMessage(bot.token, ownerChat, buildPermissionBotText(current, parsed.payload), approval.id, keyboard)
      } catch (err) {
        throw new Error(`permission-bot message failed: ${scrubbedErrorText(err, [bot.token, secretPart, approveNonce, rejectNonce])}`)
      }
      if (messageId != null && !setApprovalTelegramMessageId(approval.id, messageId)) {
        logger.warn({ approvalId: approval.id }, 'permission-bot message sent, but its message id was NOT stamped onto the row')
      }
      if (messageId == null) {
        logger.warn({ approvalId: approval.id }, 'permission-bot message sent without a message_id: NOT bound, every press will be refused (not_bound)')
      }
      logger.info({ approvalId: approval.id, messageId, botId: bot.botId }, 'permission-bot approval notification sent')
    } catch (err) {
      logger.warn({ err, approvalId: approval.id }, 'permission-bot approval notification FAILED -- the owner was not asked')
      fallbackInBand(approval, 'send-failed')
    }
  })
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
      const cleared = clearSpentEmailPayloads(approvalWindowSeconds())
      if (cleared > 0) logger.info({ cleared }, 'Approval timeout sweep: cleared spent email_send payloads')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

// --- The owner's Telegram button: POST /api/approvals/:id/telegram ---
//
// The channel plugin turns an approve/reject press on an email_send
// notification into a POST to this endpoint, resolved_by
// `owner:telegram:<from.id>`. The endpoint is separate from the legacy PATCH
// on purpose (fail-closed across versions): a plugin newer than the
// dashboard gets a 404 from an old server, which decides nothing, and the
// plugin leaves the buttons in place. Through the PATCH, an old dashboard
// would have taken the press down its legacy branch and decided it without
// any nonce. The `owner:telegram:` prefix is RESERVED and valid only here: the
// legacy PATCH refuses it with a 400, and so does the POST for agent_id.
// Here a missing or malformed field is a 400 as well.
//
// Look-alikes are kept out by an ALLOWLIST, not by folding: a free-text
// attribution (resolved_by on the legacy PATCH, agent_id on the POST) may hold
// printable ASCII and the Hungarian accented letters, nothing else, so no
// Cyrillic/Greek letter, combining or invisible mark, filler or colon
// look-alike can dress up as the prefix. Inside that alphabet the claim is
// recognised regardless of case and whitespace (claimsTelegramOwner) and
// refused; on this endpoint only the exact form passes.
//
// Order is fixed: shape -> owner -> chat -> the one conditional UPDATE. Nothing
// before the UPDATE reads the approval, so a caller that is not the owner, or
// not in the owner's private chat, gets the same answer for a pending, a
// decided and a nonexistent id. The owner id, the chat and the message id are
// readable by any holder of the shared dashboard token; the callback nonce is
// what proves the press, and each button has its own, so the
// nonce of one decision never takes the other. Neither a nonce nor its hash
// appears in a response or a log line.
const TELEGRAM_OWNER_PREFIX = 'owner:telegram:'
const TELEGRAM_RESOLVED_BY_RE = /^owner:telegram:([1-9][0-9]{0,15})$/
// A Telegram user id: a positive decimal integer, no sign, no leading zero.
const TELEGRAM_USER_ID_RE = /^[1-9][0-9]{0,15}$/
// A chat id as the plugin sends it (String(chat.id)); groups are negative.
const TELEGRAM_CHAT_ID_RE = /^-?[1-9][0-9]{0,15}$/
const TELEGRAM_CHAT_TYPE_RE = /^[a-z]{1,32}$/
const APPROVAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TELEGRAM_CALLBACK_PROTOCOL = 1

const TELEGRAM_REFUSAL_HTTP: Record<ApprovalTelegramRefusal, number> = {
  bad_request: 400,
  not_found: 404,
  wrong_category: 409,
  already_resolved: 409,
  expired: 409,
  not_bound: 409,
  message_mismatch: 403,
  bad_nonce: 403,
}

// Printable ASCII (0x20-0x7E) plus the Hungarian accented letters (á é í ó ö
// ő ú ü ű and their capitals): enough for every attribution actually written
// ("dashboard", "telegram_text", "Tulajdonos (Telegram <id>, Marveen rögzítette)").
// The regex uses escapes so it carries no NFC-vs-NFD ambiguity, and it checks
// the raw string, not a normalised one: a decomposed accent is refused too.
const ATTRIBUTION_TEXT_RE = /^[\x20-\x7E\u00E1\u00E9\u00ED\u00F3\u00F6\u0151\u00FA\u00FC\u0171\u00C1\u00C9\u00CD\u00D3\u00D6\u0150\u00DA\u00DC\u0170]*$/

export function isAttributionText(v: string): boolean {
  return ATTRIBUTION_TEXT_RE.test(v)
}

// True when the value claims the reserved owner:telegram: attribution: case
// and whitespace do not matter. Anything outside the allowlist is refused on
// its own (isAttributionText), so it need not be recognised here.
export function claimsTelegramOwner(resolvedBy: unknown): boolean {
  if (typeof resolvedBy !== 'string') return false
  return resolvedBy.replace(/\s/g, '').toLowerCase().startsWith(TELEGRAM_OWNER_PREFIX)
}

// The owner's Telegram user id, by the strict alert rule (the .env value, or
// the one and only DM entry of access.json), or null. A group or channel id
// (negative) or anything else that is not a user id is no owner. Fail-closed.
function telegramOwnerUserId(): string | null {
  try {
    const owner = resolveAlertOwnerChat()
    return owner.chatId != null && TELEGRAM_USER_ID_RE.test(owner.chatId) ? owner.chatId : null
  } catch {
    return null
  }
}

type TelegramDecisionBody = {
  status?: unknown
  resolved_by?: unknown
  telegram_message_id?: unknown
  telegram_chat_id?: unknown
  telegram_chat_type?: unknown
  callback_nonce?: unknown
  callback_protocol?: unknown
}

type TelegramDecisionRequest = {
  id: string
  status: 'approved' | 'rejected'
  fromId: string
  messageId: number
  chatId: string
  chatType: string
  nonce: string
}

// Shape only: no approval is read here. On failure, the NAME of the first bad
// field (for the log), never its value.
function parseTelegramDecision(id: string, raw: unknown): TelegramDecisionRequest | { badField: string } {
  if (!APPROVAL_ID_RE.test(id)) return { badField: 'id' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { badField: 'body' }
  const body = raw as TelegramDecisionBody
  const { status, resolved_by, telegram_message_id, telegram_chat_id, telegram_chat_type, callback_nonce, callback_protocol } = body
  if (status !== 'approved' && status !== 'rejected') return { badField: 'status' }
  const owner = typeof resolved_by === 'string' ? TELEGRAM_RESOLVED_BY_RE.exec(resolved_by) : null
  if (!owner) return { badField: 'resolved_by' }
  if (typeof telegram_message_id !== 'number' || !Number.isSafeInteger(telegram_message_id) || telegram_message_id <= 0) {
    return { badField: 'telegram_message_id' }
  }
  if (typeof telegram_chat_id !== 'string' || !TELEGRAM_CHAT_ID_RE.test(telegram_chat_id)) return { badField: 'telegram_chat_id' }
  if (typeof telegram_chat_type !== 'string' || !TELEGRAM_CHAT_TYPE_RE.test(telegram_chat_type)) return { badField: 'telegram_chat_type' }
  if (!isCallbackNonce(callback_nonce)) return { badField: 'callback_nonce' }
  if (callback_protocol !== TELEGRAM_CALLBACK_PROTOCOL) return { badField: 'callback_protocol' }
  return {
    id,
    status,
    fromId: owner[1] as string,
    messageId: telegram_message_id,
    chatId: telegram_chat_id,
    chatType: telegram_chat_type,
    nonce: callback_nonce,
  }
}

function budapestTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

// The outcome line for a press on an approval that was ALREADY decided. Unlike
// a fresh decision, the "send within 30 minutes" sentence would be stale here:
// the window runs from resolved_at, so the line states where it actually is
// (open until when, closed, or used). A decision that is not this owner's
// button press (dashboard, telegram_text, ...) says so.
function alreadyResolvedOutcomeText(a: Approval, ownerId: string, nowS: number): string | undefined {
  if ((a.status !== 'approved' && a.status !== 'rejected') || a.resolved_at == null) return undefined
  const byButton = a.resolved_by === `${TELEGRAM_OWNER_PREFIX}${ownerId}`
  const lead = byButton ? '' : 'Már eldöntve, nem gombbal: '
  if (a.status === 'rejected') return `${lead}${formatOutcomeText('rejected', a.resolved_at)}`
  const until = a.resolved_at + approvalWindowSeconds()
  const windowLine = a.consumed_at != null
    ? 'A jóváhagyást egy küldés már felhasználta.'
    : nowS >= until
      ? `A küldési ablak lejárt (${budapestTime(until)}).`
      : `A levél ${budapestTime(until)}-ig, egyszer küldhető el.`
  return `${lead}✅ Jóváhagyva: ${budapestTime(a.resolved_at)} (Budapest). ${windowLine}`
}

function handleTelegramDecision(res: RouteContext['res'], rawId: string, body: unknown): void {
  const logId = APPROVAL_ID_RE.test(rawId) ? rawId : null
  const parsed = parseTelegramDecision(rawId, body)
  if ('badField' in parsed) {
    logger.warn({ id: logId, reason: 'bad_request', field: parsed.badField }, 'Approval Telegram decision refused')
    json(res, { ok: false, reason: 'bad_request' }, 400)
    return
  }
  const { id, status, fromId } = parsed

  const ownerId = telegramOwnerUserId()
  if (ownerId == null || fromId !== ownerId) {
    logger.warn({ id, reason: 'not_owner', owner_resolved: ownerId != null }, 'Approval Telegram decision refused')
    json(res, { ok: false, reason: 'not_owner' }, 403)
    return
  }
  if (parsed.chatType !== 'private' || parsed.chatId !== fromId) {
    logger.warn({ id, reason: 'chat_mismatch' }, 'Approval Telegram decision refused')
    json(res, { ok: false, reason: 'chat_mismatch' }, 403)
    return
  }

  const result = resolveApprovalFromTelegram({
    id,
    status,
    ownerId: fromId,
    messageId: parsed.messageId,
    nonceHash: nonceHash(parsed.nonce),
  })
  if (result.ok) {
    const approval = result.approval ?? getApproval(id)
    const resolvedAt = approval?.resolved_at ?? Math.floor(Date.now() / 1000)
    logger.info({ id, status }, 'Approval resolved from the owner\'s Telegram button')
    json(res, {
      ok: true,
      approval,
      outcome_text: formatOutcomeText(status, resolvedAt, Math.floor(approvalWindowSeconds() / 60)),
    })
    return
  }

  const reason: ApprovalTelegramRefusal = result.reason ?? 'bad_request'
  const httpStatus = TELEGRAM_REFUSAL_HTTP[reason] ?? 400
  const out: Record<string, unknown> = { ok: false, reason }
  if (reason === 'already_resolved' && result.approval) {
    out.status = result.approval.status
    const outcome = alreadyResolvedOutcomeText(result.approval, ownerId, Math.floor(Date.now() / 1000))
    if (outcome) out.outcome_text = outcome
  }
  logger.warn({ id, reason }, 'Approval Telegram decision refused')
  json(res, out, httpStatus)
}

// --- Card 9a77b3e5: the permission bot's decision and the run consume ---

// An approval id as a URL carries it: the dashed UUID, or the same without
// dashes (the callback_data form). Returns the dashed form, or null.
function normalizeApprovalId(raw: string): string | null {
  if (APPROVAL_ID_RE.test(raw)) return raw
  if (/^[0-9a-f]{32}$/.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
  }
  return null
}

const PERMISSION_BOT_REFUSAL_HTTP: Record<PermissionBotRefusal, number> = {
  bad_request: 400,
  not_found: 404,
  wrong_category: 409,
  already_resolved: 409,
  expired: 409,
  not_bound: 409,
  payload_mismatch: 409,
  message_mismatch: 403,
  owner_mismatch: 403,
  bot_mismatch: 403,
  bad_nonce: 403,
}

const CONSUME_RUN_REFUSAL_HTTP: Record<OwnerRunConsumeRefusal, number> = {
  bad_request: 400,
  not_found: 404,
  wrong_category: 409,
  not_approved: 409,
  owner_unresolved: 503,
  not_owner_verified: 409,
  unbound: 409,
  package_mismatch: 409,
  run_id_mismatch: 409,
  window_not_open: 409,
  window_closed: 409,
  already_consumed: 409,
  run_id_already_used: 409,
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const RUN_ID_RE = /^[0-9a-f]{32}$/
const TELEGRAM_BOT_ID_RE = /^[1-9][0-9]{0,15}$/

// owner_verified and run_window of a permission-bot row (GET). Informative
// only: the permission is granted by the consume alone.
function permissionBotView(approval: Approval): { owner_verified: boolean; run_window: { start: number; end: number; open: boolean } | null } {
  const bot = resolvePermissionBot()
  const owner = telegramOwnerUserId()
  const ownerVerified = bot.ok && owner != null && isOwnerVerified(approval.id, owner, bot.botId)
  const parsed = approval.action_payload == null ? null : parseRagApprovalPayload(approval.action_payload, approval.category)
  const now = Math.floor(Date.now() / 1000)
  const runWindow = parsed && parsed.ok
    ? {
        start: parsed.payload.write_window_start,
        end: parsed.payload.write_window_end,
        open: now >= parsed.payload.write_window_start && now <= parsed.payload.write_window_end,
      }
    : null
  return { owner_verified: ownerVerified, run_window: runWindow }
}

type PermissionBotDecisionRequest = {
  id: string
  decision: 'approved' | 'rejected'
  nonce: string
  fromId: string
  chatId: string
  messageId: number
  botId: string
}

// Shape only. On failure, the NAME of the first bad field, never its value.
function parsePermissionBotDecision(rawId: string, raw: unknown): PermissionBotDecisionRequest | { badField: string } {
  const id = normalizeApprovalId(rawId)
  if (id == null) return { badField: 'id' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { badField: 'body' }
  const b = raw as Record<string, unknown>
  if (b.decision !== 'approved' && b.decision !== 'rejected') return { badField: 'decision' }
  if (!isCallbackNonce(b.nonce)) return { badField: 'nonce' }
  if (typeof b.from_id !== 'string' || !TELEGRAM_USER_ID_RE.test(b.from_id)) return { badField: 'from_id' }
  if (typeof b.chat_id !== 'string' || !TELEGRAM_CHAT_ID_RE.test(b.chat_id)) return { badField: 'chat_id' }
  if (typeof b.message_id !== 'number' || !Number.isSafeInteger(b.message_id) || b.message_id <= 0) return { badField: 'message_id' }
  if (typeof b.bot_id !== 'string' || !TELEGRAM_BOT_ID_RE.test(b.bot_id)) return { badField: 'bot_id' }
  return { id, decision: b.decision, nonce: b.nonce, fromId: b.from_id, chatId: b.chat_id, messageId: b.message_id, botId: b.bot_id }
}

function handlePermissionBotDecision(res: RouteContext['res'], rawId: string, body: unknown): void {
  const logId = normalizeApprovalId(rawId)
  const refuse = (status: number, reason: string, extra: Record<string, unknown> = {}): void => {
    logger.warn({ id: logId, reason, ...extra }, 'Approval permission-bot decision refused')
    json(res, { ok: false, reason, ...extra }, status)
  }
  const parsed = parsePermissionBotDecision(rawId, body)
  if ('badField' in parsed) return refuse(400, 'bad_request', { field: parsed.badField })

  const ownerId = telegramOwnerUserId()
  if (ownerId == null) return refuse(503, 'owner_unresolved')
  const bot = resolvePermissionBotWithMain()
  if (!bot.ok) return refuse(503, 'permission_bot_unavailable', { why: bot.reason })
  if (parsed.chatId !== parsed.fromId) return refuse(403, 'owner_mismatch')

  const result = resolveApprovalFromPermissionBot({
    id: parsed.id,
    decision: parsed.decision,
    nonce: parsed.nonce,
    fromId: parsed.fromId,
    chatId: parsed.chatId,
    messageId: parsed.messageId,
    botId: parsed.botId,
    ownerId,
    expectedBotId: bot.botId,
    mainBotId: bot.mainBotId,
  })
  if (result.ok) {
    const approval = result.approval ?? getApproval(parsed.id)
    const resolvedAt = approval?.resolved_at ?? Math.floor(Date.now() / 1000)
    logger.info({ id: parsed.id, status: parsed.decision }, 'Approval resolved from the permission bot\'s button')
    // The buttons are spent: take them off, best effort, in the notification
    // queue (ordered, never blocks the answer).
    const { token, botId } = bot
    const messageId = parsed.messageId
    const chatId = parsed.chatId
    const secretPart = token.slice(token.indexOf(':') + 1)
    enqueueOwnerNotification(parsed.id, async () => {
      try {
        await clearTelegramInlineKeyboard(token, chatId, messageId)
      } catch (err) {
        logger.warn({ id: parsed.id, botId, err: scrubbedErrorText(err, [token, secretPart]) }, 'permission-bot buttons could not be taken off (the press is decided anyway)')
      }
    })
    json(res, {
      ok: true,
      approval,
      outcome_text: parsed.decision === 'approved'
        ? `✅ Jóváhagyva: ${budapestTime(resolvedAt)} (Budapest).`
        : `❌ Elutasítva: ${budapestTime(resolvedAt)} (Budapest).`,
    })
    return
  }
  const reason: PermissionBotRefusal = result.reason ?? 'bad_request'
  const out: Record<string, unknown> = {}
  if (reason === 'already_resolved' && result.approval) out.status = result.approval.status
  return refuse(PERMISSION_BOT_REFUSAL_HTTP[reason] ?? 400, reason, out)
}

type ConsumeRunRequest = { id: string; category: string; packageSha256: string; runId: string; consumer: string }

function parseConsumeRun(rawId: string, raw: unknown): ConsumeRunRequest | { badField: string } {
  const id = normalizeApprovalId(rawId)
  if (id == null) return { badField: 'id' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { badField: 'body' }
  const b = raw as Record<string, unknown>
  if (typeof b.category !== 'string' || !isPermissionBotCategory(b.category)) return { badField: 'category' }
  if (typeof b.package_sha256 !== 'string' || !SHA256_HEX_RE.test(b.package_sha256)) return { badField: 'package_sha256' }
  if (typeof b.run_id !== 'string' || !RUN_ID_RE.test(b.run_id)) return { badField: 'run_id' }
  if (!isConsumerName(b.consumer)) return { badField: 'consumer' }
  return { id, category: b.category, packageSha256: b.package_sha256, runId: b.run_id, consumer: b.consumer.trim() }
}

function handleConsumeRun(res: RouteContext['res'], rawId: string, body: unknown): void {
  const logId = normalizeApprovalId(rawId)
  const parsed = parseConsumeRun(rawId, body)
  if ('badField' in parsed) {
    logger.warn({ id: logId, reason: 'bad_request', field: parsed.badField }, 'Approval run consume refused')
    json(res, { ok: false, reason: 'bad_request', field: parsed.badField }, 400)
    return
  }
  // The consume path needs only the pinned permission-bot id (not the main bot's).
  const bot = resolvePermissionBot()
  if (!bot.ok) {
    logger.warn({ id: parsed.id, reason: 'permission_bot_unavailable', why: bot.reason }, 'Approval run consume refused')
    json(res, { ok: false, reason: 'permission_bot_unavailable' }, 503)
    return
  }
  const result = consumeOwnerRunApproval({
    id: parsed.id,
    category: parsed.category,
    packageSha256: parsed.packageSha256,
    runId: parsed.runId,
    consumer: parsed.consumer,
    expectedBotId: bot.botId,
    expectedOwnerId: telegramOwnerUserId(),
  })
  if (result.ok && result.approval && result.payload) {
    const a = result.approval
    logger.info({ id: parsed.id, consumer: parsed.consumer, runId: parsed.runId }, 'Approval run consumed')
    json(res, {
      ok: true,
      approval: {
        id: a.id,
        category: a.category,
        status: a.status,
        consumed_at: a.consumed_at,
        consumed_by: a.consumed_by,
        consumed_ref: a.consumed_ref,
        package_sha256: result.payload.package_sha256,
        run_id: result.payload.run_id,
        write_window_start: result.payload.write_window_start,
        write_window_end: result.payload.write_window_end,
      },
    })
    return
  }
  const reason: OwnerRunConsumeRefusal = result.reason ?? 'bad_request'
  logger.warn({ id: parsed.id, consumer: parsed.consumer, reason }, 'Approval run consume refused')
  json(res, { ok: false, reason }, CONSUME_RUN_REFUSAL_HTTP[reason] ?? 400)
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
    // The same alphabet as resolved_by, and the reserved Telegram
    // owner attribution is not a requester name.
    if (!isAttributionText(agent_id.trim())) {
      json(res, { error: 'agent_id may only contain printable ASCII and Hungarian letters' }, 400)
      return true
    }
    if (claimsTelegramOwner(agent_id)) {
      json(res, { error: 'agent_id may not use the reserved owner:telegram: prefix' }, 400)
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
    // Card 9a77b3e5: the permission-bot categories (and the reserved
    // rag_production_ prefix) take a bound, canonical payload; every other
    // category goes through unchanged. The prefix check is case-insensitive so
    // no spelling of the reserved prefix slips through as a plain category.
    let permissionPayload: RagApprovalPayload | null = null
    const categoryName = category.trim()
    if (isPermissionBotCategory(categoryName) || categoryName.toLowerCase().startsWith(RAG_RESERVED_PREFIX)) {
      const refuse = (field: string, error: string): void => json(res, { error, field }, 400)
      if (!isPermissionBotCategory(categoryName)) {
        refuse('category', `${RAG_RESERVED_PREFIX} is a reserved prefix`)
        return true
      }
      // A bare agent id: lowercase letters, digits, - and _ (no attribution look-alikes).
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent_id.trim())) {
        refuse('agent_id', 'agent_id must be a bare agent id for this category')
        return true
      }
      if (owner_approved_message_id !== undefined && owner_approved_message_id !== null) {
        refuse('owner_approved_message_id', 'owner_approved_message_id is not accepted for this category')
        return true
      }
      const valid = validateRagApprovalRequest({
        category: categoryName,
        actionPayload: action_payload,
        contentHash: content_hash,
        nowSec: Math.floor(Date.now() / 1000),
      })
      if (!valid.ok) {
        refuse(valid.field, valid.error)
        return true
      }
      permissionPayload = valid.payload
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
    // A permission-bot request never outlives its write window.
    const timeout_at = permissionPayload
      ? Math.min(computeTimeoutAt(category, timeout_seconds), permissionPayload.write_window_end)
      : computeTimeoutAt(category, timeout_seconds)
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
  const consumeMatch = path.match(/^\/api\/approvals\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    let body: { content_hash?: unknown; consumer?: unknown; message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
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

  // POST /api/approvals/:id/consume-run -- card 9a77b3e5: the single use of a
  // rag_production_d approval by the run it authorises. The e-mail /consume
  // above is untouched.
  const consumeRunMatch = path.match(/^\/api\/approvals\/([^/]+)\/consume-run$/)
  if (consumeRunMatch && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      logger.warn({ id: normalizeApprovalId(consumeRunMatch[1]), reason: 'bad_request', field: 'body' }, 'Approval run consume refused')
      json(res, { ok: false, reason: 'bad_request', field: 'body' }, 400)
      return true
    }
    handleConsumeRun(res, consumeRunMatch[1], body)
    return true
  }

  // POST /api/approvals/:id/permission-bot -- card 9a77b3e5: the owner's
  // press on the permission bot's button, forwarded by the relay over loopback.
  const permissionBotMatch = path.match(/^\/api\/approvals\/([^/]+)\/permission-bot$/)
  if (permissionBotMatch && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      logger.warn({ id: normalizeApprovalId(permissionBotMatch[1]), reason: 'bad_request', field: 'body' }, 'Approval permission-bot decision refused')
      json(res, { ok: false, reason: 'bad_request', field: 'body' }, 400)
      return true
    }
    handlePermissionBotDecision(res, permissionBotMatch[1], body)
    return true
  }

  // POST /api/approvals/:id/telegram -- the owner's approve/reject
  // button, sent by the channel plugin (see handleTelegramDecision). Every
  // refusal has the {ok:false, reason} shape, an unreadable body included.
  const telegramMatch = path.match(/^\/api\/approvals\/([^/]+)\/telegram$/)
  if (telegramMatch && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      logger.warn({ id: APPROVAL_ID_RE.test(telegramMatch[1]) ? telegramMatch[1] : null, reason: 'bad_request', field: 'body' }, 'Approval Telegram decision refused')
      json(res, { ok: false, reason: 'bad_request' }, 400)
      return true
    }
    handleTelegramDecision(res, telegramMatch[1], body)
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
    if (isPermissionBotCategory(approval.category)) {
      json(res, { ...approval, ...permissionBotView(approval) })
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

    // The reserved owner:telegram: attribution is valid only on
    // POST /api/approvals/:id/telegram (see handleTelegramDecision). Here it
    // is refused, in any case and with any whitespace, before anything is
    // read or written: a press sent here (by an older plugin, or by anyone
    // else) is never a decision.
    if (claimsTelegramOwner(body?.resolved_by)) {
      logger.warn({ id: APPROVAL_ID_RE.test(idMatch[1]) ? idMatch[1] : null, reason: 'reserved_attribution' }, 'Approval PATCH refused: owner:telegram: is valid only on the Telegram decision endpoint')
      json(res, { error: 'resolved_by may not use the reserved owner:telegram: prefix' }, 400)
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
    // See ATTRIBUTION_TEXT_RE -- no look-alike of the reserved
    // owner:telegram: attribution can be stored through this branch.
    if (!isAttributionText(resolved_by.trim())) {
      json(res, { error: 'resolved_by may only contain printable ASCII and Hungarian letters' }, 400)
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
