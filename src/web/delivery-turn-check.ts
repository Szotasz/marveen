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
 *   - CODEXEVID d72ba2bd: for an agent whose tmux pane runs OpenAI Codex, the
 *     Codex rollout JSONL is read as a SECOND evidence source (measured
 *     2026-11-15: 239 false WARNs across the 8 codex-motor agents whose
 *     Claude transcript never moves). Only 'seen' from codex can change an
 *     outcome; no codex evidence leaves every verdict exactly as before.
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
import { codexSessionDirsFor, codexRolloutFiles } from './codex-transcript-root.js'

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
// A busy agent writes MBs of transcript within one grace period (measured
// 2026-10-15: designer, 6.1 and 4.4 MiB between the prompt row and the +60s
// mark; both prompts fell out of a fixed 4 MiB tail and raised false alerts).
// The tail therefore grows until it reaches back past the send, capped here.
export const TAIL_PASSES = [TAIL_BYTES, TAIL_BYTES * 8, TAIL_BYTES * 16]

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

/**
 * CODEXEVID d72ba2bd: PURE. What the CODEX rollout lines say about one
 * delivered message -- the same question classifyTranscriptLines asks the
 * Claude transcript, asked of the Codex rollout JSONL of an agent whose tmux
 * pane runs OpenAI Codex. Measured 2026-11-15 on this install: 239 false
 * "delivered without transcript evidence" WARNs across the 8 codex-motor
 * agents, because their Claude transcript never moves; the rollout row
 * (top-level timestamp, payload.type 'message', payload.role 'user', the
 * envelope tag inside an input_text part) is the evidence that was missing.
 * Same CLOCK_SLACK_MS floor, same anchored msg_id tag, 'seen' or 'absent'
 * only: a hook block is a Claude-Code concept with no codex counterpart.
 */
export function classifyCodexRolloutLines(lines: Iterable<string>, msgId: number, sinceMs: number): TurnEvidence {
  const rx = tagRx(msgId)
  const needle = `msg_id:${msgId}`
  const floor = sinceMs - CLOCK_SLACK_MS
  for (const line of lines) {
    if (!line.includes(needle)) continue
    let row: { timestamp?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown } }
    try { row = JSON.parse(line) } catch { continue }
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(ts) || ts < floor) continue
    const payload = row.payload
    if (payload == null || typeof payload !== 'object') continue
    if (payload.type !== 'message' || payload.role !== 'user') continue
    const t = codexTextOf(payload.content)
    if (t != null && rx.test(t)) return 'seen'
  }
  return 'absent'
}

// Codex content parts: an array of typed parts whose text fields join into
// the delivered prompt ('input_text' is the measured shape; plain string
// content is accepted defensively -- the prefilter above already matched the
// tag inside the line, so this only decides whether it sat in real prompt
// text rather than an assistant echo).
function codexTextOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const p of content) {
    if (p == null || typeof p !== 'object') continue
    const part = p as { type?: unknown; text?: unknown }
    if ((part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('\n') : null
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

const TS_RX = /"timestamp":"([^"]+)"/

/** PURE. True when the first timestamped line of `text` is older than `floorMs`. */
export function reachesBefore(text: string, floorMs: number): boolean {
  for (const line of text.split('\n', 50)) {
    const m = TS_RX.exec(line)
    if (!m) continue
    const ts = Date.parse(m[1])
    if (Number.isFinite(ts)) return ts < floorMs
  }
  return false
}

/**
 * The tail of `path` reaching back past `floorMs`: the smallest of TAIL_PASSES
 * (or the whole file) whose first line is older than the send.
 */
async function readTailSince(path: string, floorMs: number, passes: readonly number[]): Promise<string> {
  let text = ''
  for (const bytes of passes) {
    text = await readTail(path, bytes)
    if (reachesBefore(text, floorMs)) return text
    const size = (await stat(path)).size
    if (size <= bytes) return text // whole file read
  }
  return text
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
  passes: readonly number[] = TAIL_PASSES,
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
      for (const l of (await readTailSince(path, sinceMs - CLOCK_SLACK_MS, passes)).split('\n')) lines.push(l)
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

/**
 * CODEXEVID d72ba2bd: the same evidence, from the Codex rollout JSONL under
 * the recipient's CODEX_HOME (sessions/YYYY/MM/DD layout, walked by
 * codexRolloutFiles). Only rollout files modified since the send are opened,
 * and each is read with the same growing-tail discipline as the Claude
 * transcript. Null (unknown) when nothing readable was a candidate, so an
 * unreadable or empty sessions tree stays silent exactly like an unreadable
 * Claude transcript dir -- the check must not cry wolf where it cannot see.
 */
export async function readCodexTurnEvidence(
  dirs: readonly string[],
  msgIds: readonly number[],
  sinceMs: number,
  passes: readonly number[] = TAIL_PASSES,
): Promise<Map<number, TurnEvidence> | null> {
  const floorMtime = sinceMs - CLOCK_SLACK_MS
  let files: Array<{ path: string; mtimeMs: number }>
  try {
    files = await codexRolloutFiles(dirs)
  } catch {
    return null
  }
  const candidates = files.filter((f) => f.mtimeMs > floorMtime)
  if (candidates.length === 0) return null
  const lines: string[] = []
  let read = 0
  for (const f of candidates) {
    try {
      for (const l of (await readTailSince(f.path, floorMtime, passes)).split('\n')) lines.push(l)
      read++
    } catch {
      // One unreadable rollout does not blind the rest; if ALL were
      // unreadable, read stays 0 and the caller gets null (unknown).
    }
  }
  if (read === 0) return null
  const out = new Map<number, TurnEvidence>()
  for (const id of msgIds) out.set(id, classifyCodexRolloutLines(lines, id, sinceMs))
  return out
}

/**
 * PURE. A 'seen' from either source wins; otherwise the Claude verdict (if
 * any) is kept verbatim, and an id NEITHER side could see is left unset.
 * R1-D72B-1451 blocker fix (A7): a readable rollout that lacks the tag must
 * not turn an unknown into an 'absent' -- that would alert where today's
 * check stays silent. The codex scan is rescue-only: it can confirm, never
 * accuse. Unset ids are read as unknown by the caller (no alert, no confirm).
 */
function mergeTurnEvidence(
  claude: Map<number, TurnEvidence> | null,
  codex: Map<number, TurnEvidence>,
  msgIds: readonly number[],
): Map<number, TurnEvidence> {
  const out = new Map<number, TurnEvidence>()
  for (const id of msgIds) {
    const c = claude?.get(id)
    // R2-D72B-1530 blocker fix: a hook block is final PER ID. In a mixed
    // request (one id hook-blocked, another absent) the scan legitimately
    // runs for the absent id -- a rollout 'seen' must still not mask the
    // blocked id's verdict.
    if (c === 'blocked-by-hook') {
      out.set(id, c)
      continue
    }
    if (codex.get(id) === 'seen' || c === 'seen') out.set(id, 'seen')
    else if (c !== undefined) out.set(id, c)
  }
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
  /**
   * CODEXEVID d72ba2bd: codex rollout roots for the recipient ([] when the
   * pane runs Claude Code or nothing resolves). Optional so pre-existing
   * callers/tests that pass today's deps keep today's behaviour verbatim.
   */
  codexSessionDirs?: (agent: string) => Promise<string[]>
  readCodexEvidence?: typeof readCodexTurnEvidence
}

const defaultDeps: TurnCheckDeps = {
  transcriptDir: (agent) => projectsDirFor(agentDir(agent), configDirFor(agent)),
  readEvidence: readTurnEvidence,
  notify: (text) => { createAgentMessage('system', MAIN_AGENT_ID, text) },
  now: () => Date.now(),
  codexSessionDirs: (agent) => codexSessionDirsFor(agent),
  readCodexEvidence: readCodexTurnEvidence,
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
  let evidence = await deps.readEvidence(dir, req.msgIds, req.sentAtMs)
  // CODEXEVID d72ba2bd: a codex-motor agent's Claude transcript never moves
  // (measured 2026-11-15: 239 false WARNs across the 8 codex agents), so an
  // 'absent' (or an unknown dir) ALSO asks the recipient's Codex rollouts.
  // Only a 'seen' from codex can rescue a miss; nothing weakens a verdict:
  // no resolvable dirs, or nothing readable there, leaves `evidence` exactly
  // as the Claude scan produced it.
  // R1-D72B-1451 blocker fix (A5): the scan runs ONLY for an 'absent' verdict
  // or an unknown transcript dir. 'blocked-by-hook' is a definitive verdict
  // (a hook blocked THIS prompt); codex evidence must not be able to mask it.
  const claudeAbsent = evidence == null || req.msgIds.some((id) => evidence?.get(id) === 'absent')
  if (claudeAbsent && deps.codexSessionDirs != null && deps.readCodexEvidence != null) {
    let dirs: string[] = []
    try {
      dirs = await deps.codexSessionDirs(req.toAgent)
    } catch {
      dirs = [] // a failed lookup is no evidence, same as an unresolved one
    }
    if (dirs.length > 0) {
      let codex: Map<number, TurnEvidence> | null = null
      try {
        codex = await deps.readCodexEvidence(dirs, req.msgIds, req.sentAtMs)
      } catch {
        codex = null
      }
      if (codex != null) {
        logger.debug({ to: req.toAgent, ids: req.msgIds, dirs }, 'delivery-turn-check: codex rollout evidence merged')
        evidence = mergeTurnEvidence(evidence, codex, req.msgIds)
      }
    }
  }
  if (evidence == null) {
    logger.debug({ to: req.toAgent, ids: req.msgIds, dir }, 'delivery-turn-check: transcript not readable (unknown), no alert')
    return 'unknown'
  }
  const misses: Array<{ id: number; evidence: Exclude<TurnEvidence, 'seen'> }> = []
  let blindIds = 0
  for (const id of req.msgIds) {
    const e = evidence.get(id)
    if (e === undefined) {
      // Neither source could see this id (unknown transcript dir, no codex
      // 'seen'): today's unknown semantics -- contributes no alert (A7).
      blindIds++
      continue
    }
    if (e !== 'seen') misses.push({ id, evidence: e })
  }
  if (misses.length === 0) {
    if (blindIds > 0) {
      logger.debug({ to: req.toAgent, ids: req.msgIds }, 'delivery-turn-check: no verdict for some ids (unknown), no alert')
      return 'unknown'
    }
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
