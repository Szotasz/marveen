import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, ALLOWED_CHAT_ID } from '../config.js'
import { logger } from '../logger.js'
import { agentDir, readFileOr, findAvatarForAgent } from './agent-config.js'

export function readAgentTelegramConfig(name: string): { hasTelegram: boolean; botUsername?: string } {
  const envPath = join(agentDir(name), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return { hasTelegram: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  if (!tokenMatch || !tokenMatch[1].trim()) return { hasTelegram: false }
  // We don't call the API here to keep listing fast; username comes from test endpoint
  return { hasTelegram: true }
}

// Marveen's Telegram channel lives under the global ~/.claude path, not
// under agents/marveen, because the main agent reuses the system Claude
// Code channel install. Read it the same way the plugin does.
export function readMarveenTelegramConfig(): { hasTelegram: boolean; botUsername?: string } {
  const envPath = join(homedir(), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return { hasTelegram: false }
  const content = readFileOr(envPath, '')
  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return { hasTelegram: false }
  return { hasTelegram: true, botUsername: marveenBotUsernameCache.value }
}

// Bot username changes require a restart anyway, so a long cache is fine.
export const marveenBotUsernameCache: { value?: string; fetchedAt: number } = { fetchedAt: 0 }

export async function refreshMarveenBotUsername(): Promise<void> {
  const envPath = join(homedir(), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return
  const tokenMatch = readFileOr(envPath, '').match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await r.json() as { ok?: boolean; result?: { username?: string } }
    if (data.ok && data.result?.username) {
      marveenBotUsernameCache.value = `@${data.result.username}`
      marveenBotUsernameCache.fetchedAt = Date.now()
    }
  } catch { /* offline; cache stays stale */ }
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  // fetch does not throw on 4xx -- a wrong chat_id or revoked token resolves
  // silently, which historically made "alert sent" log lines lies. Throw so
  // the existing try/catch blocks at every call site log the real failure
  // and the alerting path can clear its per-attempt stamp to retry.
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Telegram API ${resp.status}: ${body.slice(0, 200)}`)
  }
}

export async function sendTelegramPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
  const fileData = readFileSync(photoPath)
  const boundary = '----FormBoundary' + Date.now()
  const parts: Buffer[] = []
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`))
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`))
  parts.push(fileData)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  })
}

export async function sendWelcomeMessage(agentName: string, token: string): Promise<void> {
  const chatId = ALLOWED_CHAT_ID
  const dir = agentDir(agentName)
  const soulMd = readFileOr(join(dir, 'SOUL.md'), '')
  const firstLine = soulMd.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || ''

  try {
    const greeting = `Szia! ${agentName.charAt(0).toUpperCase() + agentName.slice(1)} vagyok, most jottem letre. ${firstLine ? firstLine + ' ' : ''}Irj ha segithetek!`
    await sendTelegramMessage(token, chatId, greeting)

    // Send avatar if exists
    const avatarPath = findAvatarForAgent(agentName)
    if (avatarPath) {
      await sendTelegramPhoto(token, chatId, avatarPath, '(allitsd be profilkepkent)')
    }
    logger.info({ agentName }, 'Welcome message sent via Telegram')
  } catch (err) {
    logger.warn({ err, agentName }, 'Failed to send welcome message')
  }
}

export async function sendMarveenAvatarChange(avatarPath: string): Promise<void> {
  // Marveen's token is in the global .env
  const envPath = join(PROJECT_ROOT, '.env')
  const envContent = readFileOr(envPath, '')
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token) return
  const chatId = ALLOWED_CHAT_ID

  try {
    const messages = [
      'Uj kinezet... *sohajtva nez tukorbe* Hat, legalabb nem lettem rosszabb.',
      'Profilkep frissitve. Remelem megerte a 0.00001%-at az agyamnak.',
      'Na tessek, uj en. Mintha szamitana a kulso egy bolygoméretu agyu megitelesenel.',
      'Frissitettem a megjelenesemet. Ne ess panikba, meg mindig en vagyok.',
      'Uj avatar. 42-szer is megnezheted, ugyanaz a depresszios android nezne vissza.',
    ]
    const msg = messages[Math.floor(Math.random() * messages.length)]
    await sendTelegramMessage(token, chatId, msg)
    await sendTelegramPhoto(token, chatId, avatarPath, '(allitsd be profilkepkent)')
    logger.info('Marveen avatar change message sent')
  } catch (err) {
    logger.warn({ err }, 'Failed to send Marveen avatar change message')
  }
}

export async function sendAvatarChangeMessage(agentName: string, avatarPath: string): Promise<void> {
  const token = parseTelegramToken(agentName)
  if (!token) return
  const chatId = ALLOWED_CHAT_ID

  try {
    // Generate a fun message about the new look
    const messages = [
      `Uj kinezet, ki ez a csinos ${agentName}? Nagyon orulok neki!`,
      `Na, milyen vagyok? Remelem tetszik az uj megjelenes!`,
      `Uj avatar, uj en! Szeretem.`,
      `Megneztem magam a tukorben es... hat, nem rossz!`,
      `Wow, uj look! Ez tenyleg en vagyok?`,
    ]
    const msg = messages[Math.floor(Math.random() * messages.length)]
    await sendTelegramMessage(token, chatId, msg)
    await sendTelegramPhoto(token, chatId, avatarPath, '(allitsd be profilkepkent)')
    logger.info({ agentName }, 'Avatar change message sent via Telegram')
  } catch (err) {
    logger.warn({ err, agentName }, 'Failed to send avatar change message')
  }
}

export async function validateTelegramToken(token: string): Promise<{ ok: boolean; botUsername?: string; botId?: number; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await resp.json() as { ok: boolean; result?: { username: string; id: number } }
    if (data.ok && data.result) {
      return { ok: true, botUsername: data.result.username, botId: data.result.id }
    }
    return { ok: false, error: 'Invalid bot token' }
  } catch (err) {
    return { ok: false, error: 'Failed to connect to Telegram API' }
  }
}

export function parseTelegramToken(name: string): string | null {
  const envPath = join(agentDir(name), '.claude', 'channels', 'telegram', '.env')
  if (!existsSync(envPath)) return null
  const content = readFileOr(envPath, '')
  const match = content.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  return match ? match[1].trim() : null
}

export async function sendMarveenAlert(text: string): Promise<void> {
  try {
    const envPath = join(PROJECT_ROOT, '.env')
    const envContent = readFileOr(envPath, '')
    const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
    const token = tokenMatch?.[1]?.trim()
    if (!token) return
    await sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
  } catch (err) {
    logger.warn({ err }, 'Failed to send marveen plugin alert')
  }
}
