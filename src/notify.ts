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
  if (alertChat) return sendToChat(alertChat, text)
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
  return sendToChat(owner.chatId, text)
}

async function sendToChat(chatId: string, text: string): Promise<void> {
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

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk, parseMode)
    } catch {
      try {
        await provider.sendMessage(CHANNEL_TOKEN, chatId, outbound.slice(0, 4096))
      } catch { /* last resort, give up */ }
    }
  }
}

// Send to a SPECIFIC chat, not the install-wide alert or owner chat (card deeaa175).
//
// Why this exists next to notifyChannel rather than inside it: notifyChannel and
// notifyOwner are addressed by configuration (ALERT_CHAT_ID, the owner chat), and
// the owner chat cannot always be resolved (see the CHATID0 note in notifyOwner).
// For a voice reply the correct address is already in hand: /api/voice/directive
// receives the real, validated `chat` of the person who just spoke. Routing the
// notice there is what makes it a DELIVERY rather than a hope.
//
// Returns whether the send actually happened. Callers are expected to log a
// failure -- the whole point of this path is that a voice message never fails
// silently again, so the notice must not fail silently either.
export async function notifyChat(chatId: string, text: string): Promise<boolean> {
  const id = normalizeChatId(chatId)
  if (!CHANNEL_TOKEN || !id) {
    logger.warn({ chatId }, 'notifyChat kihagyva: token vagy chat ID hianyzik')
    return false
  }
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  try {
    // Plain text on purpose: no parse mode, so a stray character in a future
    // notice cannot make the API reject the whole message.
    await provider.sendMessage(CHANNEL_TOKEN, id, outbound)
    return true
  } catch (err) {
    logger.warn({ err, chatId: id }, 'notifyChat: a csatorna-ertesites nem ment ki')
    return false
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
