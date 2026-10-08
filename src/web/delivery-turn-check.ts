/**
 * ROUTERSAWTURN824: after the router marks a tmux delivery 'delivered', look in
 * the recipient's transcript for proof that the prompt reached Claude Code,
 * and tell the main agent when it did not. DETECTION ONLY: nothing is
 * re-sent and the row's status is not changed.
 *
 * WHY DETECTION AND NOT RE-QUEUE, measured 2026-10-08 (router log 09-17..10-08
 * against every recipient transcript, 5038 non-test tmux deliveries): 4995
 * landed as a user prompt, 41 as a queued command (typed into a busy pane,
 * enqueued and handed to the model mid-turn), and 2 were really lost -- both
 * on one agent on one evening, blocked by a crashing UserPromptSubmit hook.
 * A re-send would have been blocked by the same hook, so a re-queue would only
 * have added the duplicate-work risk. What was missing is that NOBODY KNEW:
 * the row said 'delivered'.
 *
 * Evidence latency, same measurement: the transcript entry is written ~0.3s
 * BEFORE the router's "delivered" log line at the median, +0.3s at p99, +8.1s
 * at the max. The 60s default grace is therefore generous on purpose: an alert
 * here must mean "really nothing arrived", never "arrived a bit late".
 *
 * Contract with the router (it must hold, the router does not wait on this):
 *   - scheduleDeliveryTurnCheck() returns at once; the check runs on an
 *     unref'd timer with async fs, and never throws into its caller.
 *   - an unreadable transcript (remote host, missing directory, no transcript
 *     file, permission error) is 'unknown': a debug line, NEVER an alert. The
 *     check must not cry wolf on an install where it cannot see.
 *   - alerts are rate-limited per recipient and name the msg id, the
 *     recipient and the reason -- never the message content.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { readEnvFile } from '../env.js'
import { createAgentMessage } from '../db.js'
import { agentDir } from './agent-config.js'
import { configDirFor } from './main-transcript-root.js'
import { projectsDirFor } from './active-model.js'

export type TurnEvidence = 'seen' | 'blocked-by-hook' | 'absent'

export const DEFAULT_GRACE_SEC = 60
export const DEFAULT_ALERT_WINDOW_MIN = 30
// The transcript entry can be stamped slightly before the router's own clock
// reads (two processes; the DB's delivered_at is whole seconds): measured down
// to -1.2s against delivered_at. Entries older than this before the send
// started are another message.
export const CLOCK_SLACK_MS = 5_000
// Same budget as delivery-integrity's tail read: a prompt is at most tens of
// KB, and the window only has to reach back one grace period.
export const TAIL_BYTES = 4 * 1024 * 1024

const BLOCKED_PREFIX = 'UserPromptSubmit operation blocked by hook'

// The router's envelope writes `, msg_id:<N>]` (or `, msg_id:<N>, self-tagged
// origin...`). Anchoring on the closing character keeps msg_id:12 from
// matching msg_id:123.
function tagRx(msgId: number): RegExp {
  return new RegExp(`msg_id:${msgId}(?=[\\],])`)
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const p of content) {
    if (p == null || typeof p !== 'object') continue
    const part = p as { type?: unknown; text?: unknown }
    // A user row carrying tool results is not a typed prompt.
    if (part.type === 'tool_result') return null
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * PURE. What the transcript lines say about one delivered message.
 *   seen            -- a user prompt or a queued_command attachment carries
 *                      the message's envelope tag. A bare queue ENQUEUE is
 *                      deliberately not evidence: measured 2026-10-08 (21
 *                      days, 43 enqueues) every one was consumed as a
 *                      queued_command within 8.5s, so counting it changes no
 *                      verdict, while a prompt removed from the queue
 *                      unprocessed (Esc) would read as arrived and silence
 *                      the alert;
 *   blocked-by-hook -- the only trace is a "UserPromptSubmit operation blocked
 *                      by hook" system row carrying the tag;
 *   absent          -- no row after the send carries the tag.
 * Rows stamped before `sinceMs - CLOCK_SLACK_MS` are ignored.
 */
export function classifyTranscriptLines(lines: Iterable<string>, msgId: number, sinceMs: number): TurnEvidence {
  const rx = tagRx(msgId)
  const needle = `msg_id:${msgId}`
  const floor = sinceMs - CLOCK_SLACK_MS
  let blocked = false
  for (const line of lines) {
    if (!line.includes(needle)) continue
    let row: {
      type?: unknown; subtype?: unknown; timestamp?: unknown; content?: unknown
      message?: { content?: unknown }; attachment?: { type?: unknown; prompt?: unknown }
    }
    try { row = JSON.parse(line) } catch { continue }
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(ts) || ts < floor) continue
    if (row.type === 'user') {
      const t = textOf(row.message?.content)
      if (t != null && rx.test(t)) return 'seen'
    } else if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
      if (typeof row.attachment.prompt === 'string' && rx.test(row.attachment.prompt)) return 'seen'
    } else if (row.type === 'system' && typeof row.content === 'string' &&
      row.content.startsWith(BLOCKED_PREFIX) && rx.test(row.content)) {
      blocked = true
    }
  }
  return blocked ? 'blocked-by-hook' : 'absent'
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text
  } finally {
    await fh.close()
  }
}

/**
 * Evidence for each id from the transcripts in `dir`, or null when the
 * directory cannot be read or holds no transcript at all (= unknown).
 * Only files modified since the send are opened.
 */
export async function readTurnEvidence(
  dir: string,
  msgIds: readonly number[],
  sinceMs: number,
  maxBytes: number = TAIL_BYTES,
): Promise<Map<number, TurnEvidence> | null> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  if (files.length === 0) return null
  const lines: string[] = []
  let unreadable = 0
  let candidates = 0
  for (const f of files) {
    const path = join(dir, f)
    try {
      if ((await stat(path)).mtimeMs < sinceMs - CLOCK_SLACK_MS) continue
      candidates++
      for (const l of (await readTail(path, maxBytes)).split('\n')) lines.push(l)
    } catch {
      unreadable++
    }
  }
  // Every transcript that could hold the answer failed to read: we cannot see.
  if (candidates > 0 && unreadable === candidates) return null
  const out = new Map<number, TurnEvidence>()
  for (const id of msgIds) out.set(id, classifyTranscriptLines(lines, id, sinceMs))
  return out
}

/** PURE. One alert per recipient per window. */
export function alertAllowed(lastAlertAtMs: number | undefined, nowMs: number, windowMs: number): boolean {
  return lastAlertAtMs === undefined || nowMs - lastAlertAtMs >= windowMs
}

/** PURE. The alert text: ids, recipient and reason only, never content. */
export function formatUnconfirmedAlert(
  toAgent: string,
  graceSec: number,
  misses: ReadonlyArray<{ id: number; evidence: Exclude<TurnEvidence, 'seen'> }>,
): string {
  const items = misses
    .map((m) => `msg_id ${m.id} (${m.evidence === 'blocked-by-hook' ? 'blocked by a UserPromptSubmit hook' : 'no trace'})`)
    .join(', ')
  return `[delivery-unconfirmed] The router marked inter-agent message(s) to '${toAgent}' as delivered, ` +
    `but the recipient's transcript shows no prompt for them ${graceSec}s later: ${items}. ` +
    `Nothing was re-sent and the rows were not changed. Check the agent's pane; the content is in the queue row ` +
    `(GET /api/messages/<id>). Further alerts for '${toAgent}' are held back for a while.`
}

function setting(key: string): string | undefined {
  // process.env first (tests, operator override), then the install .env: the
  // dashboard runs under launchd and the .env does not reach process.env
  // (same reason as batch-inject's rolloutFlag).
  const v = process.env[key]
  if (v !== undefined && v.trim() !== '') return v
  return readEnvFile([key])[key]
}

/** Grace in seconds; 0 turns the check off. Garbage falls back to the default. */
export function graceSecFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_GRACE_SEC
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRACE_SEC
  return Math.floor(n)
}

export function alertWindowMsFrom(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw.trim())
  const min = Number.isFinite(n) && n > 0 ? n : DEFAULT_ALERT_WINDOW_MIN
  return min * 60_000
}

export interface TurnCheckRequest {
  toAgent: string
  msgIds: readonly number[]
  /** Date.now() taken just before the keystrokes were sent. */
  sentAtMs: number
  /** Remote host of the recipient, null for local. */
  host: string | null
}

export interface TurnCheckDeps {
  transcriptDir: (agent: string) => string
  readEvidence: typeof readTurnEvidence
  notify: (text: string) => void
  now: () => number
}

const defaultDeps: TurnCheckDeps = {
  transcriptDir: (agent) => projectsDirFor(agentDir(agent), configDirFor(agent)),
  readEvidence: readTurnEvidence,
  notify: (text) => { createAgentMessage('system', MAIN_AGENT_ID, text) },
  now: () => Date.now(),
}

const lastAlertAt = new Map<string, number>()

/** Test hook: forget the per-recipient rate-limit state. */
export function resetTurnCheckState(): void {
  lastAlertAt.clear()
}

export type TurnCheckOutcome = 'confirmed' | 'unknown' | 'alerted' | 'suppressed'

/** The timer body. Exported so the behaviour can be tested without a timer. */
export async function runDeliveryTurnCheck(
  req: TurnCheckRequest,
  graceSec: number,
  alertWindowMs: number,
  deps: TurnCheckDeps = defaultDeps,
): Promise<TurnCheckOutcome> {
  if (req.host != null) {
    logger.debug({ to: req.toAgent, ids: req.msgIds }, 'delivery-turn-check: remote recipient, transcript not readable here (unknown)')
    return 'unknown'
  }
  const dir = deps.transcriptDir(req.toAgent)
  const evidence = await deps.readEvidence(dir, req.msgIds, req.sentAtMs)
  if (evidence == null) {
    logger.debug({ to: req.toAgent, ids: req.msgIds, dir }, 'delivery-turn-check: transcript not readable (unknown), no alert')
    return 'unknown'
  }
  const misses: Array<{ id: number; evidence: Exclude<TurnEvidence, 'seen'> }> = []
  for (const id of req.msgIds) {
    const e = evidence.get(id) ?? 'absent'
    if (e !== 'seen') misses.push({ id, evidence: e })
  }
  if (misses.length === 0) {
    logger.debug({ to: req.toAgent, ids: req.msgIds }, 'delivery-turn-check: prompt seen in transcript')
    return 'confirmed'
  }
  const now = deps.now()
  if (!alertAllowed(lastAlertAt.get(req.toAgent), now, alertWindowMs)) {
    logger.warn({ to: req.toAgent, misses }, 'delivery-turn-check: delivered without transcript evidence (alert held back by the per-recipient window)')
    return 'suppressed'
  }
  lastAlertAt.set(req.toAgent, now)
  logger.warn({ to: req.toAgent, misses }, 'delivery-turn-check: delivered without transcript evidence, alerting the main agent')
  deps.notify(formatUnconfirmedAlert(req.toAgent, graceSec, misses))
  return 'alerted'
}

/**
 * Called by the router right after a tmux delivery is marked delivered.
 * Returns at once; never throws.
 */
export function scheduleDeliveryTurnCheck(req: TurnCheckRequest): void {
  try {
    // The main agent pulls its queue (no tmux delivery), and the check would
    // alert the main agent about itself.
    if (req.toAgent === MAIN_AGENT_ID || req.msgIds.length === 0) return
    const graceSec = graceSecFrom(setting('DELIVERY_TURN_CHECK_GRACE_SEC'))
    if (graceSec === 0) return
    const windowMs = alertWindowMsFrom(setting('DELIVERY_TURN_ALERT_WINDOW_MIN'))
    const timer = setTimeout(() => {
      runDeliveryTurnCheck(req, graceSec, windowMs).catch((err) => {
        logger.warn({ err, to: req.toAgent, ids: req.msgIds }, 'delivery-turn-check failed (ignored)')
      })
    }, graceSec * 1000)
    timer.unref?.()
  } catch (err) {
    logger.warn({ err, to: req.toAgent }, 'delivery-turn-check: could not schedule (ignored, delivery unaffected)')
  }
}
