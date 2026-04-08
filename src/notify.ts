import https from 'node:https'
import { TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from './config.js'
import { formatForTelegram, splitMessage } from './format.js'
import { logger } from './logger.js'

export async function notifyTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !ALLOWED_CHAT_ID) {
    logger.warn('Telegram ertesites kihagyva: token vagy chat ID hianyzik')
    return
  }

  const formatted = formatForTelegram(text)
  const chunks = splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      await sendMessage(ALLOWED_CHAT_ID, chunk, 'HTML')
    } catch {
      // Fallback: plain text without HTML parse mode
      await sendMessage(ALLOWED_CHAT_ID, text.slice(0, 4096)).catch(() => {})
    }
  }
}

function sendMessage(chatId: string, text: string, parseMode?: string): Promise<void> {
  const payload: Record<string, string> = { chat_id: chatId, text }
  if (parseMode) payload.parse_mode = parseMode

  const body = JSON.stringify(payload)

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
        } else {
          logger.error({ status: res.statusCode }, 'Telegram kuldes hiba')
          reject(new Error(`Telegram API hiba: ${res.statusCode}`))
        }
      }
    )
    req.on('error', (err) => {
      logger.error({ err }, 'Telegram kuldes hiba')
      reject(err)
    })
    req.write(body)
    req.end()
  })
}
