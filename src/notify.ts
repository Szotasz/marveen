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

/** What a channel send did, for callers that must react to a miss. */
export interface ChannelSendResult {
  sent: boolean
  /** Why nothing (or not everything) went out. Absent when `sent` is true. */
  reason?: 'no-token' | 'no-owner-chat' | 'send-failed' | 'partial'
}

/**
 * Owner-facing send that REPORTS whether it went out, for the one caller that
 * cannot treat a miss as a delivery -- an approval request nobody sees is not
 * a gate. It resolves the owner chat like telegramOwner() below and sends on
 * the configured channel provider. Unlike notifyOwner() below it does NOT go
 * through deliverWithSlack, so a NOTIFY_SLACK_TARGET is not honoured here:
 * the result has to describe the one send it made.
 */
export async function sendOwnerMessage(text: string): Promise<ChannelSendResult> {
  const owner = resolveAlertOwnerChat(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER)
  if (!CHANNEL_TOKEN || !owner.chatId) {
    const reason = !CHANNEL_TOKEN ? 'nincs token' : `nincs tulajdonos-chat (${owner.reason})`
    logger.warn(`Channel ertesites kihagyva: ${reason}`)
    if (CHANNEL_TOKEN) signalOwnerChatMissing(text, owner.reason ?? 'ismeretlen ok')
    return { sent: false, reason: !CHANNEL_TOKEN ? 'no-token' : 'no-owner-chat' }
  }
  return sendToChat(owner.chatId, text, 'owner')
}

// Card 68cb6715: what a caller may say about an alert, for its delivery log
// line (see logAlertDelivery). Never the text, never a chat id.
export interface AlertMeta {
  /** The agent the alert is about, when there is one. */
  agent?: string | null
  /** Which case raised it, e.g. 'permission-prompt'. */
  kind: string
}

type AlertRecipient = 'owner' | 'alert-chat'
type AlertOutcome = 'sent' | 'partial' | 'failed' | 'skipped'

// True when operational alerts go to a chat other than the owner's. Callers
// must then leave owner/partner conversation content (e.g. a preview of a
// parked input line) out of the alert text.
export function alertIsRedirected(): boolean {
  return normalizeChatId(ALERT_CHAT_ID) !== null
}

// Operational alert (watchdogs, restarts, stuck sessions). Goes to
// ALERT_CHAT_ID when it is set, otherwise to the owner chat.
export async function notifyChannel(text: string, meta?: AlertMeta): Promise<void> {
  return deliverWithSlack('alert', text, () => {
    const alertChat = normalizeChatId(ALERT_CHAT_ID)
    // sendToChat reports now, this caller does not care: drop the result so the
    // callback keeps its Promise<void> shape (slack-notify wiring contract).
    if (alertChat) return sendToChat(alertChat, text, 'alert', meta, 'alert-chat').then(() => {})
    return telegramOwner(text, meta)
  })
}

// Card 3ed09d25 (71263d15): a message with no resolvable owner chat is not dropped in
// silence. The log line fires every time; the main agent's inbox hears about it once
// per window, through a sink the dashboard registers at start. notify.ts does not
// reach into the database itself: processes that never open it import this module
// too, and there the log line is the signal. Which chat counts as the owner is the
// alert rule below (resolveAlertOwnerChat); this only makes its refusal heard.
type OwnerChatMissingSink = (text: string) => void
let ownerChatMissingSink: OwnerChatMissingSink | null = null
let lastOwnerChatMissingSignalAt = 0
const OWNER_CHAT_MISSING_SIGNAL_MS = 60 * 60 * 1000

export function setOwnerChatMissingSink(sink: OwnerChatMissingSink | null): void {
  ownerChatMissingSink = sink
  lastOwnerChatMissingSignalAt = 0
}

function signalOwnerChatMissing(text: string, reason: string): void {
  const now = Date.now()
  if (!ownerChatMissingSink || now - lastOwnerChatMissingSignalAt < OWNER_CHAT_MISSING_SIGNAL_MS) return
  lastOwnerChatMissingSignalAt = now
  const preview = text.length > 200 ? `${text.slice(0, 200)} [... +${text.length - 200} karakter]` : text
  try {
    ownerChatMissingSink(
      `[notify-undelivered] Egy riasztás nem ment ki: a tulajdonosi chat nem oldható fel (${reason}). ` +
      'Óránként legfeljebb egy ilyen jelzés jön, a többi csak a naplóba kerül. ' +
      `A kihagyott riasztás eleje: ${preview}`,
    )
  } catch (err) {
    logger.warn({ err }, 'owner-chat-missing signal could not be delivered')
  }
}

// Owner-facing content (heartbeat digest, security events): always the owner
// chat, never rerouted by ALERT_CHAT_ID.
export async function notifyOwner(text: string, meta?: AlertMeta): Promise<void> {
  return deliverWithSlack('owner', text, () => telegramOwner(text, meta))
}

async function telegramOwner(text: string, meta?: AlertMeta): Promise<void> {
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
  // The skipped send gets its delivery line here, ahead of the branch below,
  // which stays as it is (card 3ed09d25 extends that branch).
  if (!CHANNEL_TOKEN || !owner.chatId) logAlertDelivery(meta, 'owner', 'skipped')
  if (!CHANNEL_TOKEN || !owner.chatId) {
    const reason = !CHANNEL_TOKEN ? 'nincs token' : `nincs tulajdonos-chat (${owner.reason})`
    logger.warn(`Channel ertesites kihagyva: ${reason}`)
    // No token means no channel on this install: the log line is enough. A token
    // with no owner chat is the 2026-09-16 shape, and that one must reach someone.
    if (CHANNEL_TOKEN) signalOwnerChatMissing(text, owner.reason ?? 'ismeretlen ok')
    return
  }
  await sendToChat(owner.chatId, text, 'owner', meta, 'owner')
}

// PR1655 review, ask 2: this used to return void and swallow every provider
// exception, so a caller could not tell a delivered notification from a dead
// one. It reports now; every existing caller ignores the value, so nothing
// else changes shape.
// NOTIFYSENDLOG930 -- every send leaves one line in the channel log: the
// outcome, the HTTP status of the answer and the id the Bot API gave the new
// message. Before this, the catches below swallowed every outcome, so neither
// a delivered nor a lost alert could be told from store/dashboard.log. The
// line names the target by its role, never the raw chat id, and carries no
// token and no text: a Bot API error description can quote the text it
// rejected, so on failure only the status is kept.
type SendTarget = 'owner' | 'alert'

/** The HTTP status in a provider send error ("Telegram API 403: ...",
 *  "Discord API 404: ...", "Slack API HTTP 500"), or null when the send never
 *  got an HTTP answer (timeout, network) or the answer carried no code. */
function sendErrorStatus(err: unknown): number | null {
  const m = /(?:Telegram API|Discord API|Slack API HTTP) (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

async function sendToChat(chatId: string, text: string, target: SendTarget, meta?: AlertMeta, recipient: AlertRecipient = 'owner'): Promise<ChannelSendResult> {
  if (!CHANNEL_TOKEN) {
    logger.warn('Channel ertesites kihagyva: nincs token')
    logAlertDelivery(meta, recipient, 'skipped')
    return { sent: false, reason: 'no-token' }
  }

  // Marked here at the funnel, NOT at call sites -- a new caller must not be
  // able to leak an unmarked message from a test run.
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  let delivered = 0
  let lastError: unknown
  const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const where = { provider: CHANNEL_PROVIDER, target, chunk: i + 1, chunks: chunks.length }
    try {
      const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk, parseMode)
      delivered++
      logger.info({ ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null }, 'Channel ertesites elkuldve')
    } catch (err) {
      lastError = err
      const firstStatus = sendErrorStatus(err)
      // #1878 (9): the fallback is THIS chunk without formatting. It used to be
      // outbound.slice(0, 4096), so a failure on chunk N sent the start of the
      // whole message again and chunk N was never delivered.
      try {
        const receipt = await provider.sendMessage(CHANNEL_TOKEN, chatId, parseMode === 'HTML' ? telegramHtmlToPlain(chunk) : chunk)
        delivered++
        logger.info(
          { ...where, status: receipt?.status ?? null, messageId: receipt?.messageId ?? null, plainTextRetry: true, firstStatus },
          'Channel ertesites elkuldve',
        )
      } catch (err2) {
        lastError = err2
        // Last resort failed too: say so -- the role, the chunk index and the
        // statuses only, never the text or the Bot API's error words.
        logger.warn({ ...where, firstStatus, retryStatus: sendErrorStatus(err2) }, 'Channel ertesites SIKERTELEN')
      }
    }
  }
  const failedChunks = chunks.length - delivered
  const outcome: AlertOutcome = failedChunks === 0 ? 'sent' : delivered > 0 ? 'partial' : 'failed'
  logAlertDelivery(meta, recipient, outcome, chunks.length, failedChunks)
  if (delivered === 0) {
    // With one chunk the SIKERTELEN line above already says everything; the
    // summary is for a multi-chunk send. Status only, like the chunk line.
    if (chunks.length > 1) {
      logger.warn({ provider: CHANNEL_PROVIDER, target, chunks: chunks.length, status: sendErrorStatus(lastError) }, 'channel send failed on every chunk')
    }
    return { sent: false, reason: 'send-failed' }
  }
  if (delivered < chunks.length) {
    logger.warn({ provider: CHANNEL_PROVIDER, target, delivered, chunks: chunks.length, status: sendErrorStatus(lastError) },
      'channel send only partially delivered')
    return { sent: false, reason: 'partial' }
  }
  return { sent: true }
}

// Card 68cb6715: every alert send leaves one line -- sent, partly sent, failed
// or skipped -- so "which alerts did the owner get last night" is measurable
// afterwards (2026-09-26: about 30 evening alerts reported, none of them in the
// log). Who and which case come from the caller's meta when it gives one; the
// recipient is a role, never a chat id, and the text never enters the line.
// It is a record, so it is info whatever the outcome: every outcome other than
// 'sent' already has its own warn line on its path (skipped, failed, partial),
// and a second warn for the same send would only double the noise.
function logAlertDelivery(
  meta: AlertMeta | undefined,
  recipient: AlertRecipient,
  outcome: AlertOutcome,
  chunks = 0,
  failedChunks = 0,
): void {
  logger.info({ agent: meta?.agent ?? null, kind: meta?.kind ?? null, recipient, outcome, chunks, failedChunks }, 'alert delivery')
}

// The plain-text form of a chunk formatForTelegram produced: its own tags
// dropped (only those, so a literal "<5 perc>" in the text survives) and the
// three entities its escapeHtml writes turned back into characters.
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<\/?(?:b|i|s|code|pre)>|<code class="language-[^"]*">|<a href="[^"]*">|<\/a>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
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
