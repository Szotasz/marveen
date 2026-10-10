import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID, ALERT_CHAT_ID } from './config.js'
import { normalizeChatId, resolveAlertOwnerChat } from './owner-chat.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'
import type { sendSlackNotification as SendSlack } from './slack-notify.js'

// SLACKATALLAS1006: the Slack side of this funnel. 'owner' = owner-facing
// content, 'alert' = operational alerts (falls back to the owner target).
// Read per send, so a Settings change applies without a restart. Loaded
// lazily: this module is imported almost everywhere, and a load failure of
// the settings layer must degrade to "no Slack target" (the Telegram path),
// never take every notification down with it.
type SettingFn = (key: string) => string
async function loadSetting(): Promise<SettingFn> {
  try {
    const { getEffectiveSettingValue } = await import('./settings-store.js')
    return (key) => { try { return String(getEffectiveSettingValue(key) ?? '').trim() } catch { return '' } }
  } catch {
    return () => ''
  }
}
export async function slackTargetFor(kind: 'owner' | 'alert', setting?: SettingFn): Promise<string> {
  const get = setting ?? await loadSetting()
  const owner = get('NOTIFY_SLACK_TARGET')
  return kind === 'alert' ? (get('NOTIFY_SLACK_ALERT_TARGET') || owner) : owner
}

/**
 * Slack first (when a target is set), then Telegram unless NOTIFY_TELEGRAM=0.
 * A failed Slack send falls back to Telegram, so nothing is lost while the
 * Slack path is new -- unless NOTIFY_TELEGRAM_FALLBACK=0: then Telegram never
 * gets the message, and the miss is an error line instead (an owner who moved
 * to Slack does not want alerts on the channel they left). Exported for tests.
 */
export async function deliverWithSlack(
  kind: 'owner' | 'alert',
  text: string,
  telegram: () => Promise<void>,
  send?: typeof SendSlack,
): Promise<void> {
  const setting = await loadSetting()
  const noFallback = setting('NOTIFY_TELEGRAM_FALLBACK') === '0'
  const target = await slackTargetFor(kind, setting)
  if (!target) {
    if (noFallback) {
      logger.error({ kind }, 'Ertesites ELVESZETT: nincs Slack-cel, a Telegram-tartalek ki van kapcsolva (NOTIFY_TELEGRAM_FALLBACK=0)')
      return
    }
    return telegram()
  }
  let sendFn: typeof SendSlack
  try {
    sendFn = send ?? (await import('./slack-notify.js')).sendSlackNotification
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A half-finished build must not cost the notification: Telegram instead,
    // unless the owner switched the Telegram fallback off.
    if (noFallback) {
      logger.error({ err: msg }, 'Ertesites ELVESZETT: a Slack modul nem toltheto be, a Telegram-tartalek ki van kapcsolva (NOTIFY_TELEGRAM_FALLBACK=0)')
      return
    }
    logger.warn({ err: msg }, 'Slack modul nem toltheto be; Telegram tartalek')
    return telegram()
  }
  const r = await sendFn(target, markIfTestRun(text), { ownerUserId: setting('SLACK_OWNER_USER_ID') })
  if (!r.ok && noFallback) {
    logger.error({ target, error: r.error }, 'Ertesites ELVESZETT: a Slack-kuldes bukott, a Telegram-tartalek ki van kapcsolva (NOTIFY_TELEGRAM_FALLBACK=0)')
    return
  }
  if (!r.ok) logger.warn({ target, error: r.error }, 'Slack ertesites nem ment ki; Telegram tartalek')
  if (!r.ok || setting('NOTIFY_TELEGRAM') !== '0') await telegram()
}

// True when operational alerts go to a chat other than the owner's. Callers
// must then leave owner/partner conversation content (e.g. a preview of a
// parked input line) out of the alert text.
export function alertIsRedirected(): boolean {
  return normalizeChatId(ALERT_CHAT_ID) !== null
}

// Operational alert (watchdogs, restarts, stuck sessions). Goes to
// ALERT_CHAT_ID when it is set, otherwise to the owner chat.
export async function notifyChannel(text: string): Promise<void> {
  return deliverWithSlack('alert', text, () => {
    const alertChat = normalizeChatId(ALERT_CHAT_ID)
    if (alertChat) return sendToChat(alertChat, text)
    return telegramOwner(text)
  })
}

// Owner-facing content (heartbeat digest, security events): always the owner
// chat, never rerouted by ALERT_CHAT_ID.
export async function notifyOwner(text: string): Promise<void> {
  return deliverWithSlack('owner', text, () => telegramOwner(text))
}

async function telegramOwner(text: string): Promise<void> {
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
  // Silent when NEITHER channel is configured; a Slack-only install still gets it.
  const hasTelegram = !!CHANNEL_TOKEN && !!resolveAlertOwnerChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER).chatId
  if (!hasTelegram && !(await slackTargetFor('owner'))) return
  try {
    await notifyOwner(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
