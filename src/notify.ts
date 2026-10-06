import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID, ALERT_CHAT_ID } from './config.js'
import { normalizeChatId, resolveAlertOwnerChat } from './owner-chat.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

// True when operational alerts go to a chat other than the owner's. Callers
// must then leave owner/partner conversation content (e.g. a preview of a
// parked input line) out of the alert text.
export function alertIsRedirected(): boolean {
  return normalizeChatId(ALERT_CHAT_ID) !== null
}

// Operational alert (watchdogs, restarts, stuck sessions). Goes to
// ALERT_CHAT_ID when it is set, otherwise to the owner chat.
export async function notifyChannel(text: string): Promise<void> {
  const alertChat = normalizeChatId(ALERT_CHAT_ID)
  if (alertChat) return sendToChat(alertChat, text, 'alert')
  return notifyOwner(text)
}

// Owner-facing content (heartbeat digest, security events): always the owner
// chat, never rerouted by ALERT_CHAT_ID.
export async function notifyOwner(text: string): Promise<void> {
  // CHATID0 -- resolveAlertOwnerChat, not a truthiness test on the raw .env
  // value. The installer writes ALLOWED_CHAT_ID=0 as its placeholder, and "0"
  // is neither empty nor falsy, so a plain truthiness/normalizeChatId-only
  // guard used to PASS on exactly the installs that had no owner chat: the
  // send went out with chat_id=0, the Bot API answered 400, and the two
  // nested catches below discarded it. Result on such an install: every alert
  // in the fleet is silently dropped, and the "kihagyva" warning that exists
  // to say so never fired.
  //
  // The access.json fallback here is the ALERT rule, not the digest one: only
  // a single paired DM entry counts as the owner, never a group or channel,
  // and with several entries the alert is not sent (a guess would reach a
  // stranger). The reason is logged, so a skipped alert is visible.
  const owner = resolveAlertOwnerChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER)
  if (!CHANNEL_TOKEN || !owner.chatId) {
    const reason = !CHANNEL_TOKEN ? 'nincs token' : `nincs tulajdonos-chat (${owner.reason})`
    logger.warn(`Channel ertesites kihagyva: ${reason}`)
    return
  }
  return sendToChat(owner.chatId, text, 'owner')
}

// NOTIFYSENDLOG930 -- every send leaves one line in the channel log: the
// outcome, the HTTP status of the answer and the id the Bot API gave the new
// message. Before this, the two catches below swallowed every outcome, so
// neither a delivered nor a lost alert could be told from store/dashboard.log.
// The line names the target by its role, never the raw chat id, and carries
// no token and no text: a Bot API error description can quote the text it
// rejected, so on failure only the status is kept.
type SendTarget = 'owner' | 'alert'

/** The HTTP status in a provider send error ("Telegram API 403: ...",
 *  "Discord API 404: ...", "Slack API HTTP 500"), or null when the send never
 *  got an HTTP answer (timeout, network) or the answer carried no code. */
function sendErrorStatus(err: unknown): number | null {
  const m = /(?:Telegram API|Discord API|Slack API HTTP) (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

async function sendToChat(chatId: string, text: string, target: SendTarget): Promise<void> {
  if (!CHANNEL_TOKEN) {
    logger.warn('Channel ertesites kihagyva: nincs token')
    return
  }

  // Marked here at the funnel, NOT at call sites -- a new caller must not be
  // able to leak an unmarked message from a test run.
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  for (const [i, chunk] of chunks.entries()) {
    const where = { provider: CHANNEL_PROVIDER, target, chunk: i + 1, chunks: chunks.length }
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk, parseMode)
      logger.info({ ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null }, 'Channel ertesites elkuldve')
    } catch (err) {
      const firstStatus = sendErrorStatus(err)
      try {
        const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, outbound.slice(0, 4096))
        logger.info(
          { ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null, plainTextRetry: true, firstStatus },
          'Channel ertesites elkuldve',
        )
      } catch (retryErr) {
        // last resort, give up -- but say so
        logger.warn({ ...where, firstStatus, retryStatus: sendErrorStatus(retryErr) }, 'Channel ertesites SIKERTELEN')
      }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel

// Security-event notification (break-glass password reset, security:reset).
// Unlike notifyChannel, a missing channel config is an EXPECTED state here
// (fresh installs, channel-less deployments), so it stays fully silent -- the
// recovery path must never depend on, or be noisy about, Telegram being wired.
export async function notifySecurityEvent(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !resolveAlertOwnerChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER).chatId) return
  try {
    await notifyOwner(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
