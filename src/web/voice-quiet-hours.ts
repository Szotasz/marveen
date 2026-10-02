import { MAIN_AGENT_ID } from '../config.js'
import { findAgentMemoryByKeywords, saveAgentMemory, updateMemory } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'

// -- The owners' quiet period for the voice channel notice (75c3d163 G2) -----
//
// The voice route tells the SENDER on the channel when a voice message could
// not be transcribed or was understood only uncertainly. That notice is a
// server-initiated Telegram message, so an owner's standing quiet period
// (23:00-07:00 Budapest: no Telegram message at all, not even a reply) applies
// to it like to any other. Inside the
// window the notice is NOT sent on the channel at all, not even after 07:00: it
// goes into the main agent's morning batch row, and the owner's morning batch
// carries it as one line (75c3d163 (a): after the quiet
// period ONE message).
//
// The rule is per RECIPIENT: it holds only the chats
// listed in the VOICE_NOTICE_QUIET_CHATS setting; everyone else is notified at
// once, as before. No person's chat id is written in code: the list is install
// configuration, and its default is empty.
//
// The zone is EXPLICIT (Europe/Budapest), not the install zone: APP_TZ follows
// SCHEDULER_TZ or the host zone, which is UTC on the fleet host, and the
// reauth-healer's 23-06 install-zone window would leave 23:00-01:00 Budapest
// open. Intl handles the CET/CEST switch.
//
// The row is a HOT memory of the main agent, ONE per chat and morning, written
// when the notice arises: a dashboard restart inside the window loses nothing
// (M-G2a). The code sends nothing at 07:00; the main agent's morning
// batch reads the rows (its prompt step, added when this is live) and closes them.
export const VOICE_QUIET_TZ = 'Europe/Budapest'
export const VOICE_QUIET_START_HOUR = 23 // inclusive
export const VOICE_QUIET_END_HOUR = 7 // exclusive

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: VOICE_QUIET_TZ, hour: '2-digit', hourCycle: 'h23' })

/** True inside 23:00-07:00 Budapest wall-clock time. */
export function isVoiceQuietTime(nowMs: number): boolean {
  const hour = parseInt(hourFmt.format(new Date(nowMs)), 10)
  return hour >= VOICE_QUIET_START_HOUR || hour < VOICE_QUIET_END_HOUR
}

/** The chats whose voice notice keeps the window: the VOICE_NOTICE_QUIET_CHATS setting, numeric ids only. */
export function voiceQuietChats(raw: string | number = getEffectiveSettingValue('VOICE_NOTICE_QUIET_CHATS')): Set<string> {
  return new Set(String(raw).split(',').map((s) => s.trim()).filter((s) => /^-?\d+$/.test(s)))
}

/** True when this chat's notice has to wait: the chat is on the quiet list AND it is 23:00-07:00 Budapest. */
export function voiceNoticeHeldFor(chatId: string, nowMs: number, quietChats: Set<string> = voiceQuietChats()): boolean {
  return quietChats.has(String(chatId).trim()) && isVoiceQuietTime(nowMs)
}

export interface HeldVoiceNotice {
  chatId: string
  text: string
  heldAt: number
}

/** The one line the morning batch carries for a chat: the night's notices in the order they arose. */
export function buildMorningVoiceNotice(items: readonly HeldVoiceNotice[]): string {
  const head = `Az éjszakai csendes időszakban (${VOICE_QUIET_START_HOUR}:00-0${VOICE_QUIET_END_HOUR}:00) küldött`
  if (items.length === 1) return `${head} hangüzenetedről: ${items[0].text}`
  return `${head} ${items.length} hangüzenetedről: ${items.map((i) => i.text).join(' ')}`
}

// -- 75c3d163 (a): the morning batch row -----------------------------------
export const MORNING_BATCH_VOICE_KEYWORD = 'reggeli-koteg-hang'

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: VOICE_QUIET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The morning a notice belongs to, as a Budapest date (YYYY-MM-DD): from 23:00 the next day's, until 07:00 that day's. */
export function voiceNoticeMorning(nowMs: number): string {
  const hour = parseInt(hourFmt.format(new Date(nowMs)), 10)
  // two hours past 23:xx is always the next calendar day in Budapest, on the clock-change nights too
  return dayFmt.format(new Date(hour >= VOICE_QUIET_START_HOUR ? nowMs + 2 * 3_600_000 : nowMs))
}

/** The row's key, ONE row per chat and morning; matched exactly, so the writer finds its own row again. */
export function morningBatchVoiceKeywords(chatId: string, morning: string): string {
  return `${MORNING_BATCH_VOICE_KEYWORD}, chat:${chatId}, reggel:${morning}`
}

const ITEM = '- '

/** The row: a head line for the main agent with the line to carry, then the notices, one per line. */
export function buildMorningBatchVoiceRow(chatId: string, morning: string, items: readonly HeldVoiceNotice[]): string {
  return [
    `REGGELI KOTEG-SOR (hangjelzes, 75c3d163): chat ${chatId}, ${morning} reggel, ${items.length} jelzes. ` +
      `A tulajdonosi reggeli kotegbe EGY sorkent: "${buildMorningVoiceNotice(items)}" ` +
      '(a szerver a chatnek 07:00 utan sem kuld kulon jelzest; a sort a koteg kikuldese utan zard).',
    ...items.map((i) => ITEM + i.text),
  ].join('\n')
}

/** The notices already in a row (its item lines), to append the next one to. */
export function parseMorningBatchVoiceItems(content: string, chatId: string): HeldVoiceNotice[] {
  return content.split('\n').filter((l) => l.startsWith(ITEM)).map((l) => ({ chatId, text: l.slice(ITEM.length), heldAt: 0 }))
}

export interface MorningBatchStore {
  find(agentId: string, keywords: string): { id: number; content: string } | undefined
  insert(agentId: string, content: string, keywords: string): number
  update(id: number, content: string): void
}

/** The real store: the main agent's HOT memory rows (src/db.ts). */
export const memoryMorningBatchStore: MorningBatchStore = {
  find: (agentId, keywords) => findAgentMemoryByKeywords(agentId, 'hot', keywords),
  insert: (agentId, content, keywords) => saveAgentMemory(agentId, content, 'hot', keywords).id,
  update: (id, content) => { updateMemory(id, content, undefined, undefined, undefined, 'voice-quiet-hours') },
}

/**
 * A listed chat's notice that arises in the window goes AT ONCE into the main agent's morning batch row for that chat
 * and morning: inserted the first time, extended afterwards. Nothing is sent on the channel, neither now nor at 07:00.
 * A store failure throws: the caller tells the agent that the notice reached nobody.
 */
export function queueVoiceNoticeForMorningBatch(
  notice: HeldVoiceNotice,
  store: MorningBatchStore = memoryMorningBatchStore,
  agentId: string = MAIN_AGENT_ID,
): { rowId: number; count: number; morning: string } {
  const morning = voiceNoticeMorning(notice.heldAt)
  const keywords = morningBatchVoiceKeywords(notice.chatId, morning)
  const item = { ...notice, text: notice.text.replace(/\s*\n\s*/g, ' ').trim() }
  const existing = store.find(agentId, keywords)
  const items = [...(existing ? parseMorningBatchVoiceItems(existing.content, notice.chatId) : []), item]
  const content = buildMorningBatchVoiceRow(notice.chatId, morning, items)
  if (existing) {
    store.update(existing.id, content)
    return { rowId: existing.id, count: items.length, morning }
  }
  return { rowId: store.insert(agentId, content, keywords), count: items.length, morning }
}
