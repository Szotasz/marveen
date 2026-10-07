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
 * A failed Slack send always falls back to Telegram, so nothing is lost while
 * the Slack path is new. Exported for tests.
 */
export async function deliverWithSlack(
  kind: 'owner' | 'alert',
  text: string,
  telegram: () => Promise<void>,
  send?: typeof SendSlack,
): Promise<void> {
  const setting = await loadSetting()
  const target = await slackTargetFor(kind, setting)
  if (!target) return telegram()
  const sendFn = send ?? (await import('./slack-notify.js')).sendSlackNotification
  const r = await sendFn(target, markIfTestRun(text), { ownerUserId: setting('SLACK_OWNER_USER_ID') })
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
