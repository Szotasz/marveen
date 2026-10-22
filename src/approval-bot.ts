// The approval bot (kanban 80d0e3c6): the owner approves or rejects a request with Telegram inline
// buttons, and the press is received by the dashboard SERVER, not by an agent.
//
// Why a separate bot: the main bot's getUpdates belongs to the channels plugin (Telegram allows one poller
// per token), so a press on a button the main bot sent reaches the plugin process. Nothing that process could
// hand on to the server -- a file, a POST with a credential read from disk -- is out of reach of an agent
// running as the same OS user. A bot that only this server polls gets the press from Telegram over TLS,
// inside this process, with `from.id` set by Telegram.
//
// What a press must pass (all of it, handleCallback):
//   1. from.id is on the main channel's allowFrom, the chat is that same private chat (chat.id === from.id),
//      and it is the chat this server sent the question to;
//   2. it is the very message this server sent for that approval (message_id on record): a message an agent
//      sends with the same bot token carries buttons that do nothing;
//   3. the callback data's HMAC matches;
//   4. the approval is still pending and not timed out;
//   5. approving takes two presses: the first rewrites the message from the DATABASE and asks again, so an
//      edit an agent made to the text (anyone with the bot token can edit the bot's messages) is replaced
//      by the real action right before the decision; the confirm counts only within CONFIRM_WINDOW_SEC.
// Rejecting is one press: it gains nobody anything.
//
// Off by default (APPROVAL_BOT_ENABLED). The bot token is the owner's: store/.approval-bot-token.
// What the code cannot do -- keep the bot token away from an agent that reads files -- is narrowed by
// keeping api.telegram.org off every sub-agent egress list (sandboxed agents cannot reach it at all).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_TZ, STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { isSettingOn } from './setting-flag.js'
import { channelStateDir } from './channel-provider.js'
import { resolveOwnerChatId } from './owner-chat.js'
import {
  getApproval, resolveApproval, recordApprovalBotMessage, getApprovalBotMessage, setApprovalBotConfirmAt,
  type Approval,
} from './db.js'
import { getUpdates, TelegramApiError, type RawUpdate } from './channel-coordinator/telegram-client.js'

export const APPROVAL_BOT_SETTING = 'APPROVAL_BOT_ENABLED'
export const TOKEN_FILE = '.approval-bot-token'
export const KEY_FILE = '.approval-bot-key'
export const CONFIRM_WINDOW_SEC = 5 * 60
export const RESOLVED_BY = 'telegram_button'

export type Op = 'a' | 'c' | 'x' | 'r'
export interface InlineButton { text: string; callback_data: string }
export interface BotApi {
  sendMessage(chatId: string, text: string, keyboard: InlineButton[][]): Promise<number | null>
  editMessageText(chatId: string, messageId: number, text: string, keyboard: InlineButton[][] | null): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>
}
export interface ApprovalBot {
  token: string
  key: Buffer
  api: BotApi
  ownerChat: () => string | null
  allowFrom: () => string[]
  now: () => number
}
export type CallbackQuery = NonNullable<RawUpdate['callback_query']>

// ---- callback data: <op>.<id22>.<mac16>, 41 bytes (Telegram allows 64)
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function compactId(uuid: string): string | null {
  return UUID_RX.test(uuid) ? Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url') : null
}

export function expandId(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return null
  const h = Buffer.from(s, 'base64url').toString('hex')
  if (h.length !== 32) return null
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function mac(key: Buffer, op: Op, approvalId: string, chatId: string): string {
  return createHmac('sha256', key).update(`${op}|${approvalId}|${chatId}`).digest().subarray(0, 12).toString('base64url')
}

export function callbackData(key: Buffer, op: Op, approvalId: string, chatId: string): string {
  const id = compactId(approvalId)
  if (!id) throw new Error(`approval id is not a UUID: ${approvalId}`)
  return `${op}.${id}.${mac(key, op, approvalId, chatId)}`
}

export function parseCallbackData(key: Buffer, data: string, chatId: string): { op: Op; approvalId: string } | null {
  const m = /^([acxr])\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})$/.exec(data)
  if (!m) return null
  const op = m[1] as Op
  const approvalId = expandId(m[2])
  if (!approvalId) return null
  const want = Buffer.from(mac(key, op, approvalId, chatId))
  const got = Buffer.from(m[3])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return { op, approvalId }
}

// ---- texts (owner-facing: proper accents, no dashes)
function expiresText(a: Approval): string {
  return a.timeout_at ? new Date(a.timeout_at * 1000).toLocaleString('hu-HU', { timeZone: APP_TZ }) : 'nincs'
}

export function promptText(a: Approval): string {
  return [
    `[JÓVÁHAGYÁS KELL] ${a.agent_id} | ${a.category}`,
    a.action_description,
    `Lejárat: ${expiresText(a)}`,
    `Döntés: a gombokkal itt, vagy Dashboard -> Jóváhagyások (id: ${a.id})`,
  ].join('\n')
}

export function confirmText(a: Approval): string {
  return [
    `[MEGERŐSÍTÉS] ${a.agent_id} | ${a.category}`,
    a.action_description,
    `Lejárat: ${expiresText(a)}`,
    `Ez a szöveg most frissült az adatbázisból. Biztosan jóváhagyod? (${Math.round(CONFIRM_WINDOW_SEC / 60)} percen belül)`,
  ].join('\n')
}

const STATUS_LABEL: Record<Approval['status'], string> = {
  pending: 'FÜGGŐBEN', approved: 'JÓVÁHAGYVA', rejected: 'ELUTASÍTVA', timeout: 'LEJÁRT',
}

export function resultText(a: Approval): string {
  const how = a.resolved_by === RESOLVED_BY ? 'gombbal' : `itt: ${a.resolved_by ?? 'ismeretlen'}`
  return [`[${STATUS_LABEL[a.status]}] ${a.agent_id} | ${a.category}`, a.action_description, `Döntés: ${how} (id: ${a.id})`].join('\n')
}

function firstKeyboard(bot: ApprovalBot, approvalId: string, chatId: string): InlineButton[][] {
  return [[
    { text: 'Jóváhagyom', callback_data: callbackData(bot.key, 'a', approvalId, chatId) },
    { text: 'Elutasítom', callback_data: callbackData(bot.key, 'r', approvalId, chatId) },
  ]]
}

function confirmKeyboard(bot: ApprovalBot, approvalId: string, chatId: string): InlineButton[][] {
  return [[
    { text: 'Megerősítem', callback_data: callbackData(bot.key, 'c', approvalId, chatId) },
    { text: 'Mégse', callback_data: callbackData(bot.key, 'x', approvalId, chatId) },
  ]]
}

// ---- sending the question
/** Send the question through the approval bot. True when it went out (and is on record). */
export async function sendApprovalPrompt(bot: ApprovalBot, a: Approval): Promise<boolean> {
  const chatId = bot.ownerChat()
  if (!chatId || !compactId(a.id)) return false
  const messageId = await bot.api.sendMessage(chatId, promptText(a), firstKeyboard(bot, a.id, chatId))
  if (messageId == null) return false
  recordApprovalBotMessage(a.id, chatId, messageId, bot.now())
  return true
}

// ---- a press
export type CallbackOutcome =
  | 'confirm-asked' | 'approved' | 'rejected' | 'cancelled' | 'already-decided'
  | 'bad-data' | 'not-owner' | 'wrong-chat' | 'not-our-message' | 'unknown-approval' | 'expired'
  | 'confirm-without-step-one' | 'confirm-too-late'

const REFUSAL_ANSWER = 'Ez a gomb nem érvényes.'

export async function handleCallback(bot: ApprovalBot, cq: CallbackQuery): Promise<CallbackOutcome> {
  const outcome = await decide(bot, cq)
  logger.info({ callbackQueryId: cq.id, from: cq.from?.id, chat: cq.message?.chat.id, message: cq.message?.message_id, outcome },
    'approval bot: button press')
  return outcome
}

async function decide(bot: ApprovalBot, cq: CallbackQuery): Promise<CallbackOutcome> {
  const answer = (text: string) => bot.api.answerCallbackQuery(cq.id, text).catch(() => {})
  const fromId = cq.from?.id != null ? String(cq.from.id) : null
  const chatId = cq.message?.chat.id != null ? String(cq.message.chat.id) : null
  const messageId = cq.message?.message_id ?? null

  // 1. the owner, in the owner's own private chat
  if (!fromId || !bot.allowFrom().includes(fromId)) { await answer('Nincs jogosultságod.'); return 'not-owner' }
  if (!chatId || chatId !== fromId || messageId == null) { await answer(REFUSAL_ANSWER); return 'wrong-chat' }
  // 3. data intact
  const parsed = parseCallbackData(bot.key, String(cq.data ?? ''), chatId)
  if (!parsed) { await answer(REFUSAL_ANSWER); return 'bad-data' }
  // 2. on the message this server sent, to this chat
  const sent = getApprovalBotMessage(parsed.approvalId)
  if (!sent || sent.chat_id !== chatId) { await answer(REFUSAL_ANSWER); return 'wrong-chat' }
  if (sent.message_id !== messageId) { await answer(REFUSAL_ANSWER); return 'not-our-message' }
  // 4. still open
  const a = getApproval(parsed.approvalId)
  if (!a) { await answer(REFUSAL_ANSWER); return 'unknown-approval' }
  const now = bot.now()
  if (a.status !== 'pending') {
    await answer(`Ez a kérés már el van döntve: ${STATUS_LABEL[a.status]}.`)
    await bot.api.editMessageText(chatId, messageId, resultText(a), null).catch(() => {})
    return 'already-decided'
  }
  if (a.timeout_at != null && a.timeout_at <= now) {
    await answer('Ez a kérés lejárt.')
    return 'expired'
  }

  if (parsed.op === 'a') {
    setApprovalBotConfirmAt(a.id, now)
    await bot.api.editMessageText(chatId, messageId, confirmText(a), confirmKeyboard(bot, a.id, chatId))
    await answer('Erősítsd meg a frissített szöveg alapján.')
    return 'confirm-asked'
  }
  if (parsed.op === 'x') {
    setApprovalBotConfirmAt(a.id, null)
    await bot.api.editMessageText(chatId, messageId, promptText(a), firstKeyboard(bot, a.id, chatId))
    await answer('Visszavonva, a kérés függőben marad.')
    return 'cancelled'
  }
  if (parsed.op === 'c') {
    // 5. only right after step 1
    if (sent.confirm_at == null) { await answer(REFUSAL_ANSWER); return 'confirm-without-step-one' }
    if (now - sent.confirm_at > CONFIRM_WINDOW_SEC) {
      setApprovalBotConfirmAt(a.id, null)
      await bot.api.editMessageText(chatId, messageId, promptText(a), firstKeyboard(bot, a.id, chatId)).catch(() => {})
      await answer('A megerősítés lejárt, kezdd újra.')
      return 'confirm-too-late'
    }
  }
  const status = parsed.op === 'c' ? 'approved' : 'rejected'
  if (!resolveApproval(a.id, status, RESOLVED_BY)) {
    const now2 = getApproval(a.id) ?? a
    await answer(`Ez a kérés már el van döntve: ${STATUS_LABEL[now2.status]}.`)
    return 'already-decided'
  }
  const done = getApproval(a.id) ?? a
  await bot.api.editMessageText(chatId, messageId, resultText(done), null).catch(() => {})
  await answer(status === 'approved' ? 'Jóváhagyva.' : 'Elutasítva.')
  logger.info({ approvalId: a.id, status, callbackQueryId: cq.id }, 'approval resolved by the owner\'s button press')
  return status
}

// ---- the Bot API, for real
export function telegramBotApi(token: string, fetchImpl: typeof fetch = fetch): BotApi {
  const call = async (method: string, body: unknown): Promise<any> => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null) as { ok?: boolean; result?: any; description?: string } | null
    if (!res.ok || !json?.ok) throw new Error(`${method}: ${json?.description ?? `HTTP ${res.status}`}`)
    return json.result
  }
  return {
    async sendMessage(chatId, text, keyboard) {
      const r = await call('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } })
      return typeof r?.message_id === 'number' ? r.message_id : null
    },
    async editMessageText(chatId, messageId, text, keyboard) {
      await call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) })
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
    },
  }
}

// ---- configuration
export function readAllowFrom(read: (p: string) => string = (p) => readFileSync(p, 'utf-8')): string[] {
  try {
    const raw = JSON.parse(read(join(channelStateDir('telegram'), 'access.json'))) as { allowFrom?: unknown }
    return Array.isArray(raw.allowFrom) ? raw.allowFrom.map((x) => String(x).trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const k = readFileSync(path)
    if (k.length >= 32) return k
  }
  const k = randomBytes(32)
  writeFileSync(path, k, { mode: 0o600 })
  return k
}

let active: ApprovalBot | null | undefined

/** The configured bot, or null when the switch is off or there is no token. Read once per process. */
export function activeApprovalBot(storeDir = STORE_DIR): ApprovalBot | null {
  if (active !== undefined) return active
  active = null
  if (!isSettingOn(APPROVAL_BOT_SETTING)) return active
  let token = ''
  try { token = readFileSync(join(storeDir, TOKEN_FILE), 'utf-8').trim() } catch { /* absent */ }
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    logger.warn({ file: join(storeDir, TOKEN_FILE) }, 'approval bot is switched on, but its token file is missing or malformed: approvals stay on the dashboard')
    return active
  }
  active = {
    token,
    key: loadOrCreateKey(join(storeDir, KEY_FILE)),
    api: telegramBotApi(token),
    ownerChat: () => resolveOwnerChatId(),
    allowFrom: () => readAllowFrom(),
    now: () => Math.floor(Date.now() / 1000),
  }
  return active
}

/** Tests only. */
export function setActiveApprovalBotForTest(bot: ApprovalBot | null | undefined): void { active = bot }

// ---- the poller: this server is the bot's only getUpdates consumer
export function startApprovalBotPoller(
  bot: ApprovalBot | null = activeApprovalBot(),
  poll: typeof getUpdates = getUpdates,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): { stop: () => void; done: Promise<void> } | null {
  if (!bot) return null
  let running = true
  let offset = 0
  const done = (async () => {
    logger.info('approval bot poller started')
    while (running) {
      try {
        const updates = await poll(bot.token, offset, 30, 100)
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          if (u.callback_query) await handleCallback(bot, u.callback_query).catch((err) => logger.warn({ err }, 'approval bot: press handling failed'))
        }
      } catch (err) {
        if (err instanceof TelegramApiError && err.kind === 'fatal') {
          logger.error({ err: err.message }, 'approval bot poller stopped: the token is not accepted; approvals stay on the dashboard')
          return
        }
        const wait = err instanceof TelegramApiError && err.kind === 'rate_limit' && err.retryAfterSec ? err.retryAfterSec * 1000
          : err instanceof TelegramApiError && err.kind === 'conflict' ? 30_000 : 5_000
        logger.warn({ err: err instanceof Error ? err.message : String(err), waitMs: wait }, 'approval bot poll failed, retrying')
        if (running) await sleep(wait)
      }
    }
  })()
  return { stop: () => { running = false }, done }
}
