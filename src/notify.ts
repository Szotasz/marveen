import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'

export async function notifyChannel(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !CHANNEL_CHAT_ID) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    return
  }

  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(text)
  const chunks = provider.splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk, parseMode)
    } catch {
      try {
        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, text.slice(0, 4096))
      } catch { /* last resort, give up */ }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel
