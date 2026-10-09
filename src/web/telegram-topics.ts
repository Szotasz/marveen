// Named Telegram topics of the owner's private chat with the main bot
// (TELEGRAM_TOPICS_ENABLED). A topic is addressed by its message_thread_id,
// a number only the Bot API hands out, so the owner names a topic once with
// `/topic new <name>` (builtin-commands.ts) and everything else, e.g. a
// scheduled task's `telegramTopic`, refers to it by that name.
//
// store/telegram-topics.json: { "chatId": "<owner chat>", "topics": { "<name>": <thread id> } }
// A thread id belongs to one chat of one bot. The file therefore names the
// chat it was written for, and a lookup for any other chat finds nothing:
// after the owner chat changes, the old ids are dropped on the next write
// instead of being sent into a chat they do not exist in.
// A topic deleted by hand in Telegram leaves its row here; `/topic remove`
// drops it, or a scheduled task keeps sending into a topic that is gone.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { isSettingOn } from '../setting-flag.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const TELEGRAM_TOPICS_FILE = join(STORE_DIR, 'telegram-topics.json')

/** Telegram's own limit for a topic name. */
export const TOPIC_NAME_MAX = 128

export interface TelegramTopics {
  chatId: string
  topics: Record<string, number>
}

export function telegramTopicsEnabled(): boolean {
  return isSettingOn('TELEGRAM_TOPICS_ENABLED')
}

function isThreadId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/** Collapsed whitespace, trimmed; null when empty or longer than Telegram allows. */
export function normalizeTopicName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim()
  return name.length > 0 && name.length <= TOPIC_NAME_MAX ? name : null
}

/** The stored topics, or null when the file is missing or unreadable. Malformed entries are skipped. */
export function readTelegramTopics(path = TELEGRAM_TOPICS_FILE): TelegramTopics | null {
  if (!existsSync(path)) return null
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf-8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const { chatId, topics } = raw as { chatId?: unknown; topics?: unknown }
  if (typeof chatId !== 'string' || !chatId) return null
  const out: Record<string, number> = {}
  if (topics && typeof topics === 'object') {
    for (const [name, id] of Object.entries(topics as Record<string, unknown>)) {
      if (normalizeTopicName(name) === name && isThreadId(id)) out[name] = id
    }
  }
  return { chatId, topics: out }
}

/** The stored name matching `name` case-insensitively, with its id. */
export function findTelegramTopic(
  name: string, chatId: string, path = TELEGRAM_TOPICS_FILE,
): { name: string; threadId: number } | null {
  const wanted = normalizeTopicName(name)?.toLowerCase()
  const stored = readTelegramTopics(path)
  if (!wanted || !stored || stored.chatId !== chatId) return null
  for (const [n, id] of Object.entries(stored.topics)) {
    if (n.toLowerCase() === wanted) return { name: n, threadId: id }
  }
  return null
}

/** Forget a topic (the local row only); returns what was removed, or null when there was nothing. */
export function removeTelegramTopic(
  chatId: string, name: string, path = TELEGRAM_TOPICS_FILE,
): { name: string; threadId: number } | null {
  const found = findTelegramTopic(name, chatId, path)
  const stored = readTelegramTopics(path)
  if (!found || !stored) return null
  const topics = { ...stored.topics }
  delete topics[found.name]
  atomicWriteFileSync(path, JSON.stringify({ chatId, topics }, null, 2) + '\n', { mode: 0o600 })
  return found
}

/** Record a topic. Topics stored for a different chat are dropped (see the header). */
export function saveTelegramTopic(chatId: string, name: string, threadId: number, path = TELEGRAM_TOPICS_FILE): void {
  const normalized = normalizeTopicName(name)
  if (!normalized) throw new Error('invalid topic name')
  if (!isThreadId(threadId)) throw new Error('invalid topic thread id')
  const stored = readTelegramTopics(path)
  const topics = stored && stored.chatId === chatId ? { ...stored.topics } : {}
  topics[normalized] = threadId
  atomicWriteFileSync(path, JSON.stringify({ chatId, topics }, null, 2) + '\n', { mode: 0o600 })
}
