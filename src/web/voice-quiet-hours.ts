import { logger } from '../logger.js'
import { getEffectiveSettingValue } from '../settings-store.js'

// -- The owners' quiet period for the voice channel notice (75c3d163 G2) -----
//
// The voice route tells the SENDER on the channel when a voice message could
// not be transcribed or was understood only uncertainly. That notice is a
// server-initiated Telegram message, so an owner's standing quiet period
// (23:00-07:00 Budapest: no Telegram message at all, not even a reply) applies
// to it like to any other. Inside the window the notice is HELD and sent ONCE
// per chat after 07:00, combined.
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
// The held notices live in memory, like the reauth-healer's morning summary:
// a dashboard restart inside the window drops them. The agent is told at the
// time that the notice is held (voice.ts), so a dropped one is not a silent loss.
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

/** Milliseconds from nowMs to the first whole minute that is no longer quiet (0 outside the window). */
export function msUntilVoiceQuietEnd(nowMs: number): number {
  if (!isVoiceQuietTime(nowMs)) return 0
  // The window is at most 8 hours long (9 across the autumn clock change); a minute walk is cheap and needs no
  // offset arithmetic of its own.
  for (let t = Math.ceil(nowMs / 60_000) * 60_000; t <= nowMs + 10 * 3_600_000; t += 60_000) {
    if (!isVoiceQuietTime(t)) return t - nowMs
  }
  throw new Error('voice quiet window did not end within 10 hours')
}

export interface HeldVoiceNotice {
  chatId: string
  text: string
  heldAt: number
}

export type ChatSender = (chatId: string, text: string) => Promise<boolean>

const held = new Map<string, HeldVoiceNotice[]>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function holdVoiceNotice(notice: HeldVoiceNotice, store: Map<string, HeldVoiceNotice[]> = held): void {
  const list = store.get(notice.chatId) ?? []
  list.push(notice)
  store.set(notice.chatId, list)
}

/** The one morning message for a chat: the held notice texts, in the order they arose. */
export function buildMorningVoiceNotice(items: readonly HeldVoiceNotice[]): string {
  const head = `Az éjszakai csendes időszakban (${VOICE_QUIET_START_HOUR}:00-0${VOICE_QUIET_END_HOUR}:00) küldött`
  if (items.length === 1) return `${head} hangüzenetedről: ${items[0].text}`
  return [`${head} ${items.length} hangüzenetedről:`, ...items.map((i) => `- ${i.text}`)].join('\n')
}

/** After the window: send every held notice, ONE message per chat, and forget them. No-op while still quiet. */
export async function flushHeldVoiceNotices(
  nowMs: number,
  send: ChatSender,
  store: Map<string, HeldVoiceNotice[]> = held,
): Promise<number> {
  if (isVoiceQuietTime(nowMs)) return 0
  let sent = 0
  for (const [chatId, items] of [...store.entries()]) {
    store.delete(chatId)
    if (await send(chatId, buildMorningVoiceNotice(items))) {
      sent += 1
    } else {
      // The morning message's OWN failure must be visible, like the immediate notice's in voice.ts.
      logger.warn({ chatId, count: items.length }, 'voice: a csendes idoszak utani osszesitett csatorna-ertesites NEM ment ki')
    }
  }
  return sent
}

/** One timer for the end of the window; it re-arms itself if it fires while still quiet. */
export function scheduleHeldVoiceFlush(nowMs: number, send: ChatSender): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const now = Date.now()
    if (isVoiceQuietTime(now)) {
      scheduleHeldVoiceFlush(now, send)
      return
    }
    flushHeldVoiceNotices(now, send).catch((err) =>
      logger.warn({ err }, 'voice: a halasztott csatorna-ertesitesek kuldese hibara futott'))
  }, msUntilVoiceQuietEnd(nowMs) + 5_000)
  flushTimer.unref?.()
}
