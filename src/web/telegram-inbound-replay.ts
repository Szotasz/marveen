/**
 * Telegram inbound replay: re-delivers a message a channel sub-agent's session
 * never received because it arrived in the restart window.
 *
 * Measured cause. A channel sub-agent runs the Telegram plugin (bun server.ts)
 * as an MCP server. On every Claude Code start the plugin begins long polling
 * right after `await mcp.connect(stdio)`, which returns when the transport
 * starts, not after the client handshake. Claude Code registers its
 * `notifications/claude/channel` handler only after the handshake (measured over
 * 5109 plugin MCP logs: 0.3 s median, 2 s p99, 94 s max after "Successfully
 * connected") and silently drops a notification that arrives before that. The
 * getUpdates offset is already confirmed by then, so Telegram never redelivers
 * it. On 10 channel agents 7 of 1407 inbound messages were lost this way, all 7
 * inside the window (the plugin wrote its evidence line at 09:42:32.253Z, Claude
 * Code registered at 09:42:32.797Z). Claude Code sends the plugin nothing when it
 * registers, so the plugin cannot wait for it.
 *
 * What we can do from here. The plugin DOES write every gate-approved inbound
 * message to <stateDir>/inbound-evidence.jsonl just before the notification
 * (scripts/patch-telegram-plugin.py, the `evid` patch; reader
 * write-evidence.ts). Once a minute this compares the last 15 minutes of that
 * log with the agent's session transcripts. A message whose channel tag is in no
 * transcript written since it arrived was never seen by the session, and is
 * queued once for the agent, framed like a coordinator hand-off (the same
 * <channel> block the channel-coordinator builds for the main agent).
 *
 * Fail closed everywhere: an unreadable allowlist, a missing transcript dir or a
 * transcript that has not been written since the message ("blind") never causes
 * a replay. Message text is never logged.
 */

import { readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { isSettingOn } from '../setting-flag.js'
import { channelStateDir } from '../channel-provider.js'
import { buildHandoffContent } from '../channel-coordinator.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { createAgentMessage, hasAgentMessageContaining } from '../db.js'
import { agentDir, listAgentNames, readAgentRunAsUser } from './agent-config.js'
import { isAgentRunning, resolveAgentProvider } from './agent-process.js'
import { transcriptDirsFor as intakeTranscriptDirsFor } from './channel-intake-monitor.js'
import { EVIDENCE_FILE } from './write-evidence.js'

// Entries older than the lookback are not replayed (a stale message answered
// minutes late is worse than none); entries younger than the grace are left
// alone so a session that is merely slow to write its transcript is not
// second-guessed.
export const REPLAY_LOOKBACK_MS = 15 * 60 * 1000
export const REPLAY_GRACE_MS = 45 * 1000

const CHECK_INTERVAL_MS = 60 * 1000
const INITIAL_DELAY_MS = 90 * 1000
// File mtimes and the plugin's Date.now() come from different writers; a
// transcript touched this much before the evidence line may still hold the turn.
const MTIME_SLACK_MS = 2000
// How far back the queue is searched for an earlier replay of the same message.
const REPLAY_DEDUP_WINDOW_S = 24 * 3600

export interface EvidenceEntry {
  chatId: string
  messageId: string
  text: string
  /** Epoch ms, the plugin's Date.now() when it handed the message to Claude Code. */
  at: number
}

export type TranscriptStatus = 'seen' | 'missing' | 'blind'

export type ReplayOutcome = {
  agent: string
  chatId: string
  messageId: string
  result: 'replayed' | 'seen' | 'blind' | 'already-replayed' | 'chat-not-allowed'
}

export interface ReplayDeps {
  now: () => number
  enabled: () => boolean
  listAgents: () => string[]
  isTelegramAgent: (name: string) => boolean
  isRunning: (name: string) => boolean
  runsAsOtherUser: (name: string) => boolean
  stateDirFor: (name: string) => string
  transcriptDirsFor: (name: string) => string[]
  alreadyReplayed: (agent: string, e: EvidenceEntry) => boolean
  enqueue: (agent: string, content: string) => number
}

function idString(v: unknown, pattern: RegExp): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v)
  return pattern.test(s) ? s : null
}

/**
 * One JSON object per line; blank and invalid lines are skipped. The plugin
 * currently writes each message twice, so a (chat, message) pair is kept once,
 * with its EARLIEST `at`. Sorted by `at`, oldest first.
 */
export function parseEvidenceLines(raw: string): EvidenceEntry[] {
  const byKey = new Map<string, EvidenceEntry>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: unknown
    try { rec = JSON.parse(trimmed) } catch { continue }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue
    const r = rec as Record<string, unknown>
    const chatId = idString(r['chat_id'], /^-?\d{1,20}$/)
    const messageId = idString(r['message_id'], /^\d{1,12}$/)
    const text = r['text']
    const at = r['at']
    if (chatId === null || messageId === null) continue
    if (typeof text !== 'string') continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    const key = `${chatId}:${messageId}`
    const prev = byKey.get(key)
    if (!prev || at < prev.at) byKey.set(key, { chatId, messageId, text, at })
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at)
}

function readFileOrEmpty(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

/** The plugin's log, rotated file first, then the current one; duplicates across the two are merged. */
export function readEvidence(stateDir: string): EvidenceEntry[] {
  const raw = readFileOrEmpty(join(stateDir, `${EVIDENCE_FILE}.1`)) + '\n' + readFileOrEmpty(join(stateDir, EVIDENCE_FILE))
  return parseEvidenceLines(raw)
}

/**
 * The chats the plugin's own gate lets through: every allowFrom entry and every
 * group key of <stateDir>/access.json. null when the file is missing, unreadable
 * or not a JSON object, in which case the caller skips the agent.
 */
export function allowedChatIds(stateDir: string): Set<string> | null {
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf-8')) } catch { return null }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const access = parsed as Record<string, unknown>
  const out = new Set<string>()
  const allowFrom = access['allowFrom']
  if (Array.isArray(allowFrom)) for (const x of allowFrom) out.add(String(x))
  const groups = access['groups']
  if (groups !== null && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const k of Object.keys(groups)) out.add(k)
  }
  return out
}

/**
 * The substring a message's channel tag leaves INSIDE a transcript JSONL line,
 * where the quotes are JSON-escaped. The closing quote after the message id
 * keeps 4 from matching 42 or 421. Both the plugin's tag and a replayed
 * coordinator block contain it.
 */
export function transcriptKey(chatId: string, messageId: string): string {
  return `chat_id=\\"${chatId}\\" message_id=\\"${messageId}\\"`
}

/**
 * Was each message seen by the session? Keyed by `${chatId}:${messageId}`.
 * Only transcripts written at or after the message can hold it; when there are
 * none the answer is 'blind' (we are not looking where the session writes, or it
 * has written nothing since), never 'missing'. A relevant file that cannot be
 * read also makes the answer 'blind' unless another file shows the tag.
 * Async I/O only: this runs on the dashboard's event loop.
 */
export async function scanTranscripts(dirs: string[], entries: EvidenceEntry[]): Promise<Map<string, TranscriptStatus>> {
  const result = new Map<string, TranscriptStatus>()
  if (entries.length === 0) return result

  const files: { path: string; mtimeMs: number }[] = []
  for (const dir of dirs) {
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs })
      } catch { /* vanished between readdir and stat */ }
    }
  }

  // null = the read failed; cached so each file is read at most once per call.
  // Kept as raw bytes: the needle is ASCII, and decoding a live transcript
  // (tens of MB) to a string would block the event loop for hundreds of ms.
  const contents = new Map<string, Buffer | null>()
  async function contentOf(path: string): Promise<Buffer | null> {
    if (contents.has(path)) return contents.get(path) ?? null
    let text: Buffer | null
    try { text = await readFile(path) } catch { text = null }
    contents.set(path, text)
    return text
  }

  for (const e of entries) {
    const key = `${e.chatId}:${e.messageId}`
    const relevant = files.filter(f => f.mtimeMs >= e.at - MTIME_SLACK_MS)
    if (relevant.length === 0) { result.set(key, 'blind'); continue }
    const needle = transcriptKey(e.chatId, e.messageId)
    let seen = false
    let unreadable = false
    for (const f of relevant) {
      const text = await contentOf(f.path)
      if (text === null) { unreadable = true; continue }
      if (text.includes(needle)) { seen = true; break }
    }
    result.set(key, seen ? 'seen' : unreadable ? 'blind' : 'missing')
  }
  return result
}

/**
 * The block queued for the agent: exactly what the channel-coordinator hands the
 * main agent (buildHandoffContent), so the receiving session answers it like a
 * native message. The text is neutralized there, no second <channel> tag can be
 * formed from it.
 */
export function buildReplayContent(e: EvidenceEntry): string {
  return buildHandoffContent({
    kind: 'message',
    chat_id: Number(e.chatId),
    user_id: null,
    username: null,
    message_id: Number(e.messageId),
    content: e.text,
    tg_date: Math.floor(e.at / 1000),
  }, false)
}

// `${agent}|${chatId}|${messageId}` -> the evidence `at`: messages already
// decided this process lifetime, so a tick re-reads no transcript for them.
const settled = new Map<string, number>()

/** Test seam: forget which messages were already decided. */
export function resetReplayState(): void {
  settled.clear()
}

function resolveDeps(over?: Partial<ReplayDeps>): ReplayDeps {
  const d: ReplayDeps = {
    now: () => Date.now(),
    enabled: () => isSettingOn('TELEGRAM_INBOUND_REPLAY_ENABLED'),
    listAgents: () => listAgentNames(),
    // resolveAgentProvider, not the raw per-agent field: an agent without a
    // channelProvider in its agent-config.json runs on the install's provider.
    isTelegramAgent: name => resolveAgentProvider(name) === 'telegram',
    isRunning: name => isAgentRunning(name),
    runsAsOtherUser: name => readAgentRunAsUser(name) != null,
    stateDirFor: name => channelStateDir('telegram', agentDir(name)),
    transcriptDirsFor: name => intakeTranscriptDirsFor(name, PROJECT_ROOT),
    alreadyReplayed: (agent, e) => hasAgentMessageContaining(
      COORDINATOR_AGENT_ID, agent, `chat_id="${e.chatId}" message_id="${e.messageId}"`,
      Math.floor(d.now() / 1000) - REPLAY_DEDUP_WINDOW_S,
    ),
    enqueue: (agent, content) => createAgentMessage(COORDINATOR_AGENT_ID, agent, content, 'telegram inbound replay (restart window)').id,
    ...over,
  }
  return d
}

/** One tick: the outcome for every message that was decided or looked at this time. */
export async function replayMissedInbound(deps?: Partial<ReplayDeps>): Promise<ReplayOutcome[]> {
  const d = resolveDeps(deps)
  if (!d.enabled()) return []
  const now = d.now()
  for (const [k, at] of settled) {
    if (now - at > REPLAY_LOOKBACK_MS + 60_000) settled.delete(k)
  }

  const outcomes: ReplayOutcome[] = []
  for (const agent of d.listAgents()) {
    // The main agent's Telegram goes through the channel-coordinator, which has its own replay.
    if (agent === MAIN_AGENT_ID) continue
    try {
      if (!d.isTelegramAgent(agent) || !d.isRunning(agent)) continue
      // An agent under its own OS user can write its state dir; a symlinked
      // evidence log or access.json would make us replay another agent's
      // messages to it. Not covered until the reads check the file owner.
      if (d.runsAsOtherUser(agent)) continue
      const stateDir = d.stateDirFor(agent)
      const fresh = readEvidence(stateDir).filter(e =>
        now - e.at <= REPLAY_LOOKBACK_MS
        && now - e.at >= REPLAY_GRACE_MS
        && !settled.has(`${agent}|${e.chatId}|${e.messageId}`))
      if (fresh.length === 0) continue

      const allowed = allowedChatIds(stateDir)
      if (allowed === null) {
        logger.debug({ agent }, 'telegram-inbound-replay: access.json unreadable, agent skipped')
        continue
      }
      const settle = (e: EvidenceEntry, result: ReplayOutcome['result']): void => {
        settled.set(`${agent}|${e.chatId}|${e.messageId}`, e.at)
        outcomes.push({ agent, chatId: e.chatId, messageId: e.messageId, result })
      }
      const toScan: EvidenceEntry[] = []
      for (const e of fresh) {
        if (allowed.has(e.chatId)) toScan.push(e)
        else settle(e, 'chat-not-allowed')
      }
      if (toScan.length === 0) continue

      const status = await scanTranscripts(d.transcriptDirsFor(agent), toScan)
      for (const e of toScan) {
        const s = status.get(`${e.chatId}:${e.messageId}`) ?? 'blind'
        if (s === 'seen') { settle(e, 'seen'); continue }
        if (s === 'blind') {
          // Not settled: re-checked next tick, when the session may have written something.
          outcomes.push({ agent, chatId: e.chatId, messageId: e.messageId, result: 'blind' })
          continue
        }
        if (d.alreadyReplayed(agent, e)) { settle(e, 'already-replayed'); continue }
        d.enqueue(agent, buildReplayContent(e))
        settle(e, 'replayed')
        // Never the message text.
        logger.warn(
          { agent, chatId: e.chatId, messageId: e.messageId, ageMs: now - e.at },
          'telegram-inbound-replay: re-delivered a Telegram message the session never received (restart window)',
        )
      }
    } catch (err) {
      logger.debug({ err, agent }, 'telegram-inbound-replay: agent check error')
    }
  }
  return outcomes
}

let running = false

export function startTelegramInboundReplay(): NodeJS.Timeout {
  const tick = (): void => {
    // A slow tick (big transcripts) must not overlap the next one.
    if (running) return
    running = true
    void replayMissedInbound()
      .catch(err => logger.debug({ err }, 'telegram-inbound-replay: tick failed'))
      .finally(() => { running = false })
  }

  // First tick after the boot burst; the 90s offset also keeps it off the 45s/100s ticks of the channel monitors.
  setTimeout(tick, INITIAL_DELAY_MS)
  return setInterval(tick, CHECK_INTERVAL_MS)
}
