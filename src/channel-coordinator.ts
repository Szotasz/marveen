// marveen-channel-coordinator: standalone Telegram inbound poller.
//
// WHY THIS EXISTS
// The Telegram channel plugin runs getUpdates INSIDE the Marveen Claude Code
// TUI process. When that TUI freezes on a wedged tool-call, inbound polling
// freezes with it -- the user's messages pile up server-side and Marveen looks
// "deaf". This process decouples inbound ingest from the TUI: it long-polls
// getUpdates, writes each update to store/claudeclaw.db (incoming_events), and
// hands it off to Marveen via the existing agent_messages queue + message-
// router. If the TUI freezes, ingest keeps running; the message just waits in
// the queue and is delivered when the TUI recovers -- no message is lost.
//
// The plugin stays loaded in OUTBOUND-ONLY mode (TELEGRAM_OUTBOUND_ONLY=1) so
// Marveen's reply/react/edit tools still work. Because only this coordinator
// polls getUpdates, there is no 409 Conflict over the bot token.
//
// Lifecycle: launchd (com.marveen.channel-coordinator) with KeepAlive. On
// SIGTERM it drains the current batch, persists the offset, and exits cleanly
// so the next start does not collide with a half-finished poll.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { logger } from './logger.js'
import { PROJECT_ROOT } from './config.js'
import { getUpdates, mapUpdate, TelegramApiError } from './channel-coordinator/telegram-client.js'
import {
  initIngestDb,
  insertIncomingEvent,
  createHandoffMessage,
  markEventDelivered,
  getEventsNeedingHandoff,
  getOffset,
  setOffset,
  closeIngestDb,
  type InsertResult,
} from './channel-coordinator/ingest.js'

const SOURCE = 'telegram'
const LONGPOLL_TIMEOUT_SEC = 30
const POLL_LIMIT = 100

// The coordinator keeps its OWN state dir, separate from the plugin's
// ~/.claude/channels/telegram. Sharing it would let the plugin's orphan-PID
// watchdog SIGTERM our process (it kills "stale" pids in its bot.pid).
const STATE_DIR = process.env['COORDINATOR_STATE_DIR'] ?? join(homedir(), '.claude', 'channels', 'telegram-coordinator')
const PID_FILE = join(STATE_DIR, 'coordinator.pid')

// Backoff tuning (transient errors: 5xx, network, abort).
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 60_000
// 409: another poller holds the token. Fixed short backoff, but if it persists
// (window threshold), escalate to a degraded alert instead of tight-looping.
const CONFLICT_BACKOFF_MS = 4000
const CONFLICT_WINDOW_MS = 5 * 60 * 1000
const CONFLICT_WINDOW_THRESHOLD = 5

let stopping = false
let conflictTimes: number[] = []
let degradedAlerted = false

// ---- token --------------------------------------------------------------

// Read the bot token from the coordinator's own STATE_DIR/.env (chmod 0600),
// falling back to the process env for local dev. NEVER log the token.
function readToken(): string {
  const fromEnv = process.env['TELEGRAM_BOT_TOKEN']
  if (fromEnv) return fromEnv
  const envPath = join(STATE_DIR, '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() === 'TELEGRAM_BOT_TOKEN') {
        let v = trimmed.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        return v
      }
    }
  } catch { /* no .env -- fall through to error */ }
  throw new Error(`TELEGRAM_BOT_TOKEN not found (checked env + ${envPath})`)
}

// ---- single-instance lock ------------------------------------------------

// Two pollers on one token = guaranteed 409. Refuse to start if another live
// coordinator already holds the pid file. Stale pid (process gone) is reclaimed.
function acquireSingleInstanceLock(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(PID_FILE)) {
    const prev = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
      let alive = false
      try { process.kill(prev, 0); alive = true } catch { alive = false }
      if (alive) {
        logger.error({ prev }, 'channel-coordinator: another live instance holds the pid lock, exiting')
        process.exit(1)
      }
      logger.warn({ stalePid: prev }, 'channel-coordinator: reclaiming stale pid file')
    }
  }
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch { /* best effort */ }
}

// ---- alerting ------------------------------------------------------------

// Best-effort Telegram alert to the owner via the existing notify.sh (which
// uses the project's own token+chat). Used for fatal (401) and degraded (409
// storm) states so a silent inbound outage does not go unnoticed.
function sendAlert(message: string): void {
  const script = join(PROJECT_ROOT, 'scripts', 'notify.sh')
  execFile('/bin/bash', [script, message], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err }, 'channel-coordinator: notify.sh alert failed')
  })
}

// ---- handoff content -----------------------------------------------------

// Neutralize any <channel ...> / </channel> the user typed, so their text can
// never break out of the channel frame we wrap it in below. (The outer
// <untrusted> wrapper added by the message-router already scrubs untrusted/
// trusted-peer tags, but not <channel>.)
export function neutralizeChannelTags(text: string): string {
  return text.replace(/<\s*\/?\s*channel\b[^>]*>/gi, '[stripped-tag]')
}

// Mirror the native plugin's <channel ...> block so Marveen's existing inbound
// handling (reply with chat_id) works with zero behavior change. The message-
// router wraps this whole string as <untrusted source="agent:telegram-
// coordinator">, which is correct: it is raw external user input.
export function buildHandoffContent(ev: {
  kind: string
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  content: string
  tg_date: number | null
}): string {
  const ts = ev.tg_date ? new Date(ev.tg_date * 1000).toISOString() : ''
  const attrs = [
    `source="telegram"`,
    ev.chat_id != null ? `chat_id="${ev.chat_id}"` : '',
    ev.message_id != null ? `message_id="${ev.message_id}"` : '',
    ev.username ? `user="${neutralizeChannelTags(ev.username).replace(/"/g, '')}"` : '',
    ev.user_id != null ? `user_id="${ev.user_id}"` : '',
    ts ? `ts="${ts}"` : '',
    ev.kind !== 'message' ? `kind="${ev.kind}"` : '',
  ].filter(Boolean).join(' ')
  const body = neutralizeChannelTags(ev.content || '(empty message)')
  return `<channel ${attrs}>\n${body}\n</channel>`
}

// ---- backoff -------------------------------------------------------------

// Exponential backoff with full jitter, capped. Math.random is fine here --
// this is a long-lived Node process, not a (replayable) workflow script.
export function transientBackoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(Math.random() * ceiling)
}

// Pure sliding-window evaluation: given the prior conflict timestamps and now,
// return the pruned window and whether it crossed the storm threshold. Kept
// pure so the 409-window behavior is unit-testable without wall-clock state.
export function evalConflictWindow(
  prev: number[],
  now: number,
  windowMs = CONFLICT_WINDOW_MS,
  threshold = CONFLICT_WINDOW_THRESHOLD,
): { times: number[]; storm: boolean } {
  const times = prev.filter((t) => now - t < windowMs)
  times.push(now)
  return { times, storm: times.length >= threshold }
}

function recordConflict(): boolean {
  const { times, storm } = evalConflictWindow(conflictTimes, Date.now())
  conflictTimes = times
  return storm
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- batch processing ----------------------------------------------------

// Process one getUpdates batch. For each update: normalize, dedup-insert, and
// (if newly inserted) hand off to Marveen. Returns the highest update_id seen
// so the caller can advance the offset AFTER the whole batch is durable.
function processBatch(updates: { update_id: number }[]): number | null {
  let maxUpdateId: number | null = null
  for (const raw of updates) {
    maxUpdateId = maxUpdateId == null ? raw.update_id : Math.max(maxUpdateId, raw.update_id)
    const ev = mapUpdate(raw as Parameters<typeof mapUpdate>[0])
    if (!ev) continue // unhandled update kind: offset still advances past it

    let ins: InsertResult
    try {
      ins = insertIncomingEvent(SOURCE, ev)
    } catch (err) {
      logger.error({ err, update_id: ev.update_id }, 'channel-coordinator: insertIncomingEvent failed')
      continue
    }
    if (!ins.inserted || ins.eventId == null) continue // dedup: already handed off

    try {
      const agentMessageId = createHandoffMessage(buildHandoffContent(ev))
      markEventDelivered(ins.eventId, agentMessageId)
      logger.info({ update_id: ev.update_id, chat_id: ev.chat_id, kind: ev.kind, agentMessageId }, 'channel-coordinator: handed off to main agent')
    } catch (err) {
      logger.error({ err, eventId: ins.eventId }, 'channel-coordinator: handoff failed; event left pending for replay')
    }
  }
  return maxUpdateId
}

// ---- reconcile (no-message-loss replay) ----------------------------------

// Re-hand-off events the message-router abandoned (agent_message failed after
// its 1h retry window) or that were never handed off (crash between insert and
// handoff). This is the invariant the whole decoupling exists for: a frozen
// main agent DELAYS a message, never LOSES it. Runs once per poll iteration
// (~30s cadence), which is ample against a 1h abandon window. Idempotent:
// in-flight handoffs are excluded by getEventsNeedingHandoff, and a re-handoff
// creates a fresh agent_message rather than duplicating the source event.
function reconcilePending(): void {
  let events
  try {
    events = getEventsNeedingHandoff(SOURCE)
  } catch (err) {
    logger.error({ err }, 'channel-coordinator: reconcile query failed')
    return
  }
  for (const ev of events) {
    try {
      const agentMessageId = createHandoffMessage(buildHandoffContent({
        kind: ev.kind,
        chat_id: ev.chat_id,
        user_id: ev.user_id,
        username: ev.username,
        message_id: ev.message_id,
        content: ev.content ?? '',
        tg_date: ev.tg_date,
      }))
      markEventDelivered(ev.id, agentMessageId)
      logger.warn({ update_id: ev.update_id, eventId: ev.id, agentMessageId }, 'channel-coordinator: re-queued abandoned/stranded inbound message')
    } catch (err) {
      logger.error({ err, eventId: ev.id }, 'channel-coordinator: reconcile re-handoff failed; will retry next cycle')
    }
  }
}

// ---- main loop -----------------------------------------------------------

async function pollLoop(token: string): Promise<void> {
  let transientAttempt = 0
  while (!stopping) {
    reconcilePending() // replay abandoned/stranded events before the next poll
    const offset = getOffset(SOURCE) + 1 // getUpdates offset = last confirmed + 1
    let updates: { update_id: number }[]
    try {
      updates = await getUpdates(token, offset, LONGPOLL_TIMEOUT_SEC, POLL_LIMIT)
      transientAttempt = 0
      if (conflictTimes.length) { conflictTimes = []; degradedAlerted = false }
    } catch (err) {
      if (stopping) break
      if (!(err instanceof TelegramApiError)) {
        logger.error({ err }, 'channel-coordinator: unexpected poll error')
        await sleep(transientBackoffMs(Math.min(++transientAttempt, 6)))
        continue
      }
      switch (err.kind) {
        case 'fatal':
          logger.error({ msg: err.message }, 'channel-coordinator: fatal error, exiting')
          sendAlert(`Marveen channel-coordinator FATAL: ${err.message}. Inbound Telegram leallt amig nem javitod.`)
          // give notify.sh a beat to fire before launchd-less exit
          await sleep(1500)
          process.exit(1)
          break
        case 'rate_limit': {
          const wait = (err.retryAfterSec ?? 5) * 1000
          logger.warn({ waitMs: wait }, 'channel-coordinator: 429 rate limit, waiting retry_after')
          await sleep(wait)
          break
        }
        case 'conflict': {
          const storm = recordConflict()
          if (storm && !degradedAlerted) {
            degradedAlerted = true
            logger.error('channel-coordinator: 409 conflict storm -- another poller holds the token')
            sendAlert('Marveen channel-coordinator: tartos 409 Conflict -- masik poller fogja a tokent (plugin nem outbound-only? stray bun?). Inbound akadozhat.')
          }
          await sleep(CONFLICT_BACKOFF_MS)
          break
        }
        case 'transient':
        default:
          await sleep(transientBackoffMs(Math.min(++transientAttempt, 6)))
          break
      }
      continue
    }

    if (updates.length === 0) continue // long-poll timed out with no updates
    const maxUpdateId = processBatch(updates)
    // Persist offset ONLY after the batch is durable (at-least-once ordering).
    if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)
  }
}

// ---- bootstrap -----------------------------------------------------------

function installSignalHandlers(): void {
  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    logger.info({ sig }, 'channel-coordinator: shutting down, draining current poll')
    // The poll loop checks `stopping` after its current iteration. Give the
    // in-flight long-poll up to a few seconds to settle, then force-exit.
    setTimeout(() => {
      releaseLock()
      closeIngestDb()
      process.exit(0)
    }, 3000)
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

async function main(): Promise<void> {
  const token = readToken()
  acquireSingleInstanceLock()
  initIngestDb()
  installSignalHandlers()
  logger.info({ stateDir: STATE_DIR }, 'channel-coordinator: started, polling getUpdates')
  await pollLoop(token)
  releaseLock()
  closeIngestDb()
}

// Entry-point guard: only run the poller when executed directly (launchd /
// `node dist/channel-coordinator.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error({ err }, 'channel-coordinator: crashed')
    releaseLock()
    process.exit(1)
  })
}
