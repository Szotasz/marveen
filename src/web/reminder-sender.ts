// fb79dc1f: the reminder sender. Every minute the dashboard itself sends the
// reminders whose moment has come, straight on the Telegram Bot API with the
// bot of the reminder's agent (the channel the recipient talks to), so neither
// a busy nor a stopped agent session, nor the key wall, makes a reminder late.
//
// One tick: (1) a claim left behind by a crash becomes 'failed' (send_uncertain)
// and is never sent again; (2) the recipient windows are read FAIL-CLOSED (a
// broken config sends nothing and alerts the main agent); (3) each due reminder
// is checked against its window once more (the config may have changed since
// it was planned) and moved if the moment is not allowed; (4) it is claimed
// ('pending' -> 'sending', at most once), sent, and marked 'sent' with the
// Telegram message id, or 'failed' with the error and an alert to the main
// agent. The reminder's agent gets a copy in its inbox either way.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { channelStateDir, readChannelToken } from '../channel-provider.js'
import {
  claimReminder, claimReminderDigest, createAgentMessage, deferReminder, dueReminders, failStaleReminderClaims,
  markReminderFailed, markReminderSent, reminderDigestRows, type Reminder,
} from '../db.js'
import { logger } from '../logger.js'
import { allowedAt, EMPTY_WINDOWS, localParts, nextAllowedMs, parseReminderWindows, zonedToUtcMs, type ReminderWindowsConfig } from '../reminder-window.js'
import { agentDir } from './agent-config.js'
import { parseTelegramToken, sendTelegramMessage } from './telegram.js'

export const REMINDER_WINDOWS_FILE = 'reminder-windows.json'
export const REMINDER_TICK_MS = 60_000
export const REMINDER_INITIAL_DELAY_MS = 75_000 // free slot (taken: 5/10/20/25/30/35/40/45/50/55/65/70/90/100s)
/** A claim older than this never finished (a crash between the claim and the result). */
export const REMINDER_CLAIM_STALE_SEC = 10 * 60
export const REMINDER_BATCH = 20
/** The broken-config alert repeats at most this often. */
export const REMINDER_CONFIG_ALERT_EVERY_MS = 60 * 60_000
/** fb79dc1f (d): the daily check goes to the main agent from this Budapest hour on (07:00 Europe/Budapest: 05:00Z in summer
 *  time, 06:00Z in winter); the hour and the day are both read in Europe/Budapest, like the quiet hours and the weekend rule. */
export const REMINDER_DIGEST_LOCAL_HOUR = 7

export type WindowsLoad = { ok: true; config: ReminderWindowsConfig } | { ok: false; error: string }

/**
 * The install's recipient windows (store/reminder-windows.json). No file: no
 * windows (every reminder goes at its moment). A file that does not parse:
 * an error, never "no windows" (fail-closed). REMINDER_WINDOWS_FILE_PATH points
 * elsewhere (tests).
 */
export function loadReminderWindows(path: string = process.env['REMINDER_WINDOWS_FILE_PATH'] || join(PROJECT_ROOT, 'store', REMINDER_WINDOWS_FILE)): WindowsLoad {
  if (!existsSync(path)) return { ok: true, config: EMPTY_WINDOWS }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { ok: false, error: `unreadable: ${(err as Error).message}`.slice(0, 200) }
  }
  const p = parseReminderWindows(raw)
  return p.ok ? { ok: true, config: p.config } : { ok: false, error: p.error }
}

export interface ReminderSenderDeps {
  nowMs: () => number
  windows: () => WindowsLoad
  /** Sends the text on the agent's bot; resolves to the Telegram message id. Throws on any failure. */
  send: (agentId: string, chatId: string, text: string) => Promise<number | null>
  alertMain: (text: string) => void
  copyToAgent: (agentId: string, text: string) => void
  /** The daily check's message to the main agent (its inbox); not an alert. */
  digestMain: (text: string) => void
}

export interface ReminderTickResult { sent: number; failed: number; deferred: number; stale: number; configError: boolean; digest: boolean }

const BP = 'Europe/Budapest'
function bpTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString('hu-HU', { timeZone: BP })
}

function short(r: Reminder): string {
  return r.id.slice(0, 8)
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 300)
}

let lastConfigAlertMs = 0
/** Tests: forget the broken-config alert's last time. */
export function _resetReminderSenderForTest(): void {
  lastConfigAlertMs = 0
}

export async function reminderTick(deps: ReminderSenderDeps): Promise<ReminderTickResult> {
  const out: ReminderTickResult = { sent: 0, failed: 0, deferred: 0, stale: 0, configError: false, digest: false }
  const nowMs = deps.nowMs()
  const nowSec = Math.floor(nowMs / 1000)

  for (const r of failStaleReminderClaims(nowSec - REMINDER_CLAIM_STALE_SEC)) {
    out.stale++
    const msg = `[EMLÉKEZTETŐ BIZONYTALAN] ${short(r)}: a küldése félbeszakadt (a foglalás ${bpTime(r.claimed_at ?? nowSec)} óta nem zárult le), `
      + `ezért 'failed' lett, és NEM megy ki újra magától: lehet, hogy kiment. Címzett chat ${r.recipient_chat_id}, ügynök ${r.agent_id}. `
      + `Ha biztosan nem ment ki: PATCH /api/reminders/${r.id} {"status":"pending"}.`
    deps.alertMain(msg)
    if (r.agent_id !== MAIN_AGENT_ID) deps.copyToAgent(r.agent_id, msg)
  }

  const w = deps.windows()
  if (!w.ok) {
    out.configError = true
    if (nowMs - lastConfigAlertMs >= REMINDER_CONFIG_ALERT_EVERY_MS) {
      lastConfigAlertMs = nowMs
      deps.alertMain(`[EMLÉKEZTETŐ-KONFIG HIBA] A store/${REMINDER_WINDOWS_FILE} nem olvasható (${w.error}): amíg nincs javítva, emlékeztető NEM megy ki.`)
    }
    logger.warn({ error: w.error }, 'reminder-sender: the windows config is invalid, nothing sent')
    out.digest = dailyDigest(deps, nowMs)
    return out
  }

  for (const r of dueReminders(nowSec, REMINDER_BATCH)) {
    const win = w.config.recipients[r.recipient_chat_id]
    const allowWeekend = r.allow_weekend === 1
    if (!allowedAt(nowMs, win, allowWeekend)) {
      const next = Math.floor(nextAllowedMs(nowMs, win, allowWeekend) / 1000)
      if (deferReminder(r.id, next)) out.deferred++
      continue
    }
    if (!claimReminder(r.id, nowSec)) continue
    try {
      const messageId = await deps.send(r.agent_id, r.recipient_chat_id, r.text)
      markReminderSent(r.id, Math.floor(deps.nowMs() / 1000), messageId)
      out.sent++
      logger.info({ id: r.id, agent_id: r.agent_id, messageId }, 'reminder-sender: sent')
      deps.copyToAgent(r.agent_id, `[EMLÉKEZTETŐ KIMENT] ${short(r)}: ${bpTime(nowSec)}-kor a ${r.recipient_chat_id} chatbe `
        + `(Telegram message_id ${messageId ?? 'nincs'}; kérte: ${r.requester}). A szöveg:\n${r.text}`)
    } catch (err) {
      const e = errorText(err)
      markReminderFailed(r.id, e)
      out.failed++
      logger.warn({ id: r.id, agent_id: r.agent_id, err: e }, 'reminder-sender: send failed')
      const msg = `[EMLÉKEZTETŐ HIBA] ${short(r)} nem ment ki: ${e}. Címzett chat ${r.recipient_chat_id}, ügynök ${r.agent_id}, `
        + `esedékes ${bpTime(r.due_at)}; kérte: ${r.requester}. A sor 'failed'; újra: PATCH /api/reminders/${r.id} {"status":"pending"}.`
      deps.alertMain(msg)
      if (r.agent_id !== MAIN_AGENT_ID) deps.copyToAgent(r.agent_id, msg)
    }
  }
  out.digest = dailyDigest(deps, nowMs)
  return out
}

/**
 * fb79dc1f (d): once a day from REMINDER_DIGEST_LOCAL_HOUR o'clock Budapest, the main agent gets the reminders that go TODAY (Budapest
 * day, by send moment) and the ones that did NOT go (due yesterday and failed or cancelled, or still waiting past
 * their moment). The day is claimed in the DB first, so a restart does not send it twice; an empty day sends nothing.
 * The gate is the Budapest hour of that Budapest day: a UTC-hour gate with the Budapest day let the check out at Budapest
 * midnight (22:00Z in summer, 23:00Z in winter) and claimed the day before the morning.
 */
export function dailyDigest(deps: ReminderSenderDeps, nowMs: number): boolean {
  const p = localParts(nowMs, BP)
  if (p.h < REMINDER_DIGEST_LOCAL_HOUR) return false
  const day = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  const startMs = zonedToUtcMs(p.y, p.mo, p.d, 0, 0, BP)
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1))
  const prev = new Date(Date.UTC(p.y, p.mo - 1, p.d - 1))
  const endMs = zonedToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, BP)
  const yStartMs = zonedToUtcMs(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 0, 0, BP)
  if (!claimReminderDigest(day)) return false
  const { today, missed } = reminderDigestRows(Math.floor(startMs / 1000), Math.floor(endMs / 1000), Math.floor(yStartMs / 1000), Math.floor(startMs / 1000))
  if (today.length === 0 && missed.length === 0) {
    logger.info({ day }, 'reminder-sender: daily check, nothing to report')
    return false
  }
  const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('hu-HU', { timeZone: BP, hour: '2-digit', minute: '2-digit' })
  const cut = (t: string) => (t.length > 100 ? `${t.slice(0, 100)}...` : t).replace(/\s+/g, ' ')
  const lines = [`[EMLÉKEZTETŐK, NAPI ELLENŐRZÉS] ${day} (Budapest)`]
  lines.push(`MA KIMEGY (${today.length}):`)
  for (const r of today) lines.push(`- ${hhmm(r.send_after)} -> chat ${r.recipient_chat_id} (${r.agent_id}): ${cut(r.text)}`)
  lines.push(`NEM MENT KI (${missed.length}):`)
  for (const r of missed) {
    const why = r.status === 'failed' ? `hiba: ${r.error ?? '?'}` : r.status === 'cancelled' ? 'visszavonva' : `vár, ${bpTime(r.send_after)} óta esedékes`
    lines.push(`- ${short(r)} (${r.status}) esedékes ${bpTime(r.due_at)}, chat ${r.recipient_chat_id} (${r.agent_id}): ${why}`)
  }
  lines.push('Részletek: GET /api/reminders?status=failed (vagy ?recipient=<chat id>).')
  deps.digestMain(lines.join('\n'))
  return true
}

/** The agent's own Telegram bot token: the main agent's from the install .env or its channel dir, a sub-agent's from its channel .env. */
export function reminderBotToken(agentId: string): string | null {
  if (agentId === MAIN_AGENT_ID) {
    return readChannelToken('telegram', join(PROJECT_ROOT, '.env')) || readChannelToken('telegram', join(channelStateDir('telegram'), '.env'))
  }
  return readChannelToken('telegram', join(channelStateDir('telegram', agentDir(agentId)), '.env')) || parseTelegramToken(agentId)
}

function postSystemMessage(to: string, text: string): void {
  try {
    createAgentMessage('system', to, text)
  } catch (err) {
    logger.warn({ err, to }, 'reminder-sender: inbox message failed')
  }
}

/** The live send: the agent's own bot, the Bot API's sendMessage; the Telegram message id back. */
export async function liveReminderSend(agentId: string, chatId: string, text: string): Promise<number | null> {
  const token = reminderBotToken(agentId)
  if (!token) throw new Error(`no_bot_token: the ${agentId} agent has no Telegram bot token`)
  return sendTelegramMessage(token, chatId, text)
}

const liveDeps: ReminderSenderDeps = {
  nowMs: () => Date.now(),
  windows: () => loadReminderWindows(),
  send: liveReminderSend,
  alertMain: (text) => postSystemMessage(MAIN_AGENT_ID, text),
  copyToAgent: (agentId, text) => postSystemMessage(agentId, text),
  digestMain: (text) => postSystemMessage(MAIN_AGENT_ID, text),
}

export function startReminderSender(deps: ReminderSenderDeps = liveDeps): NodeJS.Timeout {
  let running = false
  const tick = () => {
    if (running) return
    running = true
    reminderTick(deps)
      .catch(err => logger.warn({ err }, 'reminder-sender: tick failed'))
      .finally(() => { running = false })
  }
  setTimeout(tick, REMINDER_INITIAL_DELAY_MS).unref?.()
  const t = setInterval(tick, REMINDER_TICK_MS)
  t.unref?.()
  return t
}
