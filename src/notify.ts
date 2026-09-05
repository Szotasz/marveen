import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { normalizeChatId } from './owner-chat.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

export async function notifyChannel(text: string): Promise<void> {
  // CHATID0 -- normalizeChatId, not a truthiness test. The installer writes
  // ALLOWED_CHAT_ID=0 as its placeholder, and "0" is neither empty nor falsy,
  // so this guard used to PASS on exactly the installs that had no owner chat:
  // the send went out with chat_id=0, the Bot API answered 400, and the two
  // nested catches below discarded it. Result on such an install: every alert
  // in the fleet is silently dropped, and the "kihagyva" warning that exists to
  // say so never fires. owner-chat.ts already owns this decision -- its comment
  // asks every consumer to reuse it rather than reinvent the hole.
  const chatId = normalizeChatId(CHANNEL_CHAT_ID)
  if (!CHANNEL_TOKEN || !chatId) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
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
  if (!CHANNEL_TOKEN || !normalizeChatId(CHANNEL_CHAT_ID)) return
  try {
    await notifyChannel(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
