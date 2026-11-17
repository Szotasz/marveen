// PROMPTCSONK923: did the scheduled prompt ARRIVE the way it was typed?
//
// sendPromptToSession streams a prompt into the pane as ~80-char send-keys
// chunks. Anything else that writes the pane between two chunks -- a foreign
// Enter above all -- lands INSIDE the prompt. Measured 2026-09-23 on Claude Code
// 2.1.280 against an isolated probe session, using the real sendPromptToSession:
//
//   - one foreign Enter mid-stream SPLITS the prompt: the head (with the
//     opening <scheduled-task> tag) is submitted as its own message, the tail
//     arrives as a second message with no envelope at all -- exactly the shape
//     a customer reported (text starting mid-attribute, the provenance gate
//     flagging the agent's own task);
//   - a foreign C-u or Escape mid-stream silently drops characters from the
//     middle;
//   - typing into a BUSY pane, or into a TUI still booting, arrived intact
//     (4/4 boot deliveries, busy delivery queued whole).
//
// And the one real truncation on the reference install (2026-09-13 07:58:08Z,
// ledger-live-drain, 870 of 1750 chars, head gone) was the FIRST message of a
// fresh session: the task fired the same second channels.sh restarted it. It
// was not a busy-pane send, so the 'fired_busy' status (AUDITBORITEKVESZ918)
// missed it -- while it flagged the 2026-09-18 kanban-audit run, whose
// transcript holds the full 44448-char prompt, envelope and all.
//
// So pane state at send time is a proxy that is wrong in both directions. The
// only place that knows what the agent received is the session's own
// transcript: Claude Code writes every submitted prompt to its jsonl verbatim.
// This module compares that record with what was typed.
//
// Pure except readUserPromptsSince (file reads). Never throws.

import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type DeliveryVerdict =
  // The prompt that carried the typed text's tail equals the typed text.
  | 'intact'
  // The same, but QUEUED: the prompt was typed into a busy pane, Claude Code
  // queued it and handed it to the agent inside the running turn (a
  // queued_command attachment in the transcript), not as a turn of its own.
  // Measured 2026-09-27 (card c8a6c2cc): 58 of 59 'not-arrived' runs in 24 h
  // were this shape, whole envelope and all -- the reader only knew typed
  // user rows. Kept apart from 'intact': the agent got it while busy with
  // something else, and that is worth knowing when a run misbehaves.
  | 'intact-queued'
  // Only the tail arrived (its head was lost, or went elsewhere).
  | 'head-lost'
  // Only the head arrived.
  | 'tail-lost'
  // Head and tail arrived as SEPARATE prompts: something submitted mid-stream.
  | 'split'
  // Head and tail are in one prompt, but the text between them differs.
  | 'spliced'
  // The TUI wrapped the prompt as pasted content (<pasted_content>): the text
  // is whole, but the model is told pasted text may not be the user's own --
  // the same self-defeating framing that once made agents refuse their own
  // scheduled tasks. Kept distinct because the fix is different.
  | 'paste-wrapped'
  // CLOSING LOOK ONLY (never returned by classifyDelivery): the transcript was
  // readable and nothing of this prompt ever arrived -- the whole prompt was
  // lost (a restart mid-stream, keys eaten by a dialog), it is still parked
  // unsubmitted, or it was queued and never handed over (an 'enqueue' with no
  // queued_command after it). Without it such a run kept delivery NULL, in the same bucket
  // as "never looked" (Marveen's #1506 review).
  | 'not-arrived'
  // CLOSING LOOK ONLY: no transcript directory was readable for this agent, so
  // there was nothing to compare against. Kept apart from 'not-arrived': an
  // instrument gap is not a lost delivery.
  | 'unverifiable'

// Anchor length: long enough that an 80-char chunk boundary or a stray key
// cannot fake a match, short enough to exist in a tiny prompt.
function anchorLen(text: string): number {
  return Math.max(8, Math.min(64, Math.floor(text.length / 4)))
}

const PASTE_WRAP_RX = /<pasted_content\b/

/**
 * One prompt the session recorded: typed as a turn of its own, or queued into a
 * running turn (card c8a6c2cc). A bare string is a typed prompt.
 */
export interface ReceivedPrompt {
  text: string
  queued: boolean
}

/**
 * Classify what arrived against what was typed. `received` is every user
 * prompt the session recorded since the typing started, oldest first.
 *
 * The verdict CLOSES at the first recorded prompt that carries the typed
 * text's tail: that is the moment this delivery was submitted. Anything
 * later belongs to a later delivery -- the same task fires again (the
 * drain runs every 2 minutes), and its clean copy must not mask the damaged one.
 * Measured on the 2026-09-13 case: an "any intact copy wins" rule read that
 * head-lost run as intact because of the 08:00 fire.
 *
 * Returns null when nothing recognisably ours arrived (yet) -- the caller
 * keeps looking; null is "unknown", never "fine".
 */
export function classifyDelivery(sent: string, received: ReadonlyArray<string | ReceivedPrompt>): DeliveryVerdict | null {
  const want = sent.trim()
  if (want.length === 0) return null
  const k = anchorLen(want)
  const head = want.slice(0, k)
  const tail = want.slice(-k)
  let headOnly = false
  for (const item of received) {
    const got = (typeof item === 'string' ? item : item.text).trim()
    const queued = typeof item !== 'string' && item.queued
    const hasHead = got.includes(head)
    const hasTail = got.includes(tail)
    if (!hasTail) {
      if (hasHead) headOnly = true
      continue
    }
    // First prompt carrying our tail: this delivery's submission.
    if (headOnly) return 'split'
    if (got === want) return queued ? 'intact-queued' : 'intact'
    if (!hasHead) return 'head-lost'
    return PASTE_WRAP_RX.test(got) ? 'paste-wrapped' : 'spliced'
  }
  return headOnly ? 'tail-lost' : null
}

// How much of a transcript's end is read per file. A scheduled prompt is at
// most tens of KB; the window only has to reach back to the moment the prompt
// was typed, which the sweep checks within about a minute. A prompt that sat
// queued behind a very chatty turn can fall outside it -- that reads as
// null (unknown), which is the honest answer.
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024

function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    // A mid-file start lands inside a line: drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text
  } finally {
    closeSync(fd)
  }
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  // A user turn that carries tool results is not a typed prompt.
  const parts: string[] = []
  for (const p of content) {
    if (p == null || typeof p !== 'object') continue
    const part = p as { type?: unknown; text?: unknown }
    if (part.type === 'tool_result') return null
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

// A prompt typed into a busy pane is queued by Claude Code and handed to the
// agent inside the running turn. The transcript records that hand-over as an
// attachment row, not a user row (card c8a6c2cc, measured on the reference
// install): {"type":"attachment","timestamp":...,"attachment":{"type":
// "queued_command","commandMode":"prompt","prompt":"<the typed text>"}}. Only
// commandMode 'prompt' is typed input; 'task-notification' rows are Claude
// Code's own. An 'enqueue' queue-operation alone is NOT an arrival: the item
// may never be handed over. A commandMode 'prompt' row also carries channel
// messages (origin kind 'channel', review on #1828), so only origin kind
// 'human' -- typed input, which is what the runner's keystrokes are -- is read
// as a queued prompt. A row without an origin is not counted either: the
// verdict then stays 'not-arrived', the conservative side.
function queuedPromptText(attachment: unknown): string | null {
  if (attachment == null || typeof attachment !== 'object') return null
  const a = attachment as { type?: unknown; commandMode?: unknown; prompt?: unknown; origin?: { kind?: unknown } | null }
  if (a.type !== 'queued_command' || a.commandMode !== 'prompt') return null
  if (a.origin == null || typeof a.origin !== 'object' || a.origin.kind !== 'human') return null
  return typeof a.prompt === 'string' ? a.prompt : null
}

/**
 * Every user prompt recorded in `dirs` at or after `sinceMs`, oldest first:
 * the typed ones, and the ones queued into a running turn (marked `queued`).
 * Only transcripts modified since `sinceMs` are opened. Unreadable files and
 * malformed lines are skipped.
 */
export function readUserPromptsSince(
  dirs: readonly string[],
  sinceMs: number,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): ReceivedPrompt[] {
  const hits: Array<{ ts: number; text: string; queued: boolean }> = []
  // Two config roots can be the same directory: on the reference install the
  // main agent's .channels-config/projects is a symlink to ~/.claude/projects.
  // Read each real directory once, or every prompt would be counted twice.
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      if (!existsSync(dir)) continue
      const real = realpathSync(dir)
      if (seen.has(real)) continue
      seen.add(real)
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const path = join(dir, f)
      let text: string
      try {
        if (statSync(path).mtimeMs < sinceMs) continue
        text = readTail(path, maxBytes)
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        // Cheap pre-filter before JSON.parse on a multi-MB tail.
        if (!line.includes('"user"') && !line.includes('"queued_command"')) continue
        let row: { type?: unknown; timestamp?: unknown; message?: { content?: unknown }; attachment?: unknown }
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if ((row.type !== 'user' && row.type !== 'attachment') || typeof row.timestamp !== 'string') continue
        const ts = Date.parse(row.timestamp)
        if (!Number.isFinite(ts) || ts < sinceMs) continue
        if (row.type === 'user') {
          const t = promptText(row.message?.content)
          if (t != null) hits.push({ ts, text: t, queued: false })
        } else {
          const t = queuedPromptText(row.attachment)
          if (t != null) hits.push({ ts, text: t, queued: true })
        }
      }
    }
  }
  hits.sort((a, b) => a.ts - b.ts)
  return hits.map((h) => ({ text: h.text, queued: h.queued }))
}

// --- Turn evidence (SCHEDHAMISDONE1014) ---------------------------------
//
// A second question about the same transcript, and the reason this lives here:
// "did the injected prompt arrive?" and "did a turn actually RUN?" are read
// from the same jsonl rows, by the same tail reader.
//
// The watchdog used to answer the second question from the transcript
// DIRECTORY's mtime: anything newer than the injection counted as "the turn
// started". That is true for every ordinary case and false for exactly the one
// that matters -- a session that is out of quota answers the prompt in half a
// second with the CLI's own canned message, which is written to the transcript
// like any other reply. Measured on this install, 2026-10-14 07:30:06: the
// morning round was answered with "You've hit your weekly limit", and its
// task_runs row says status=fired, outcome=done, delivery=intact. The same
// shape produced 2851 'done' rows between 2026-10-10 and 2026-10-14 while the
// fleet's model was quota-blocked for three of those days.
//
// The canned reply is distinguishable at the source: Claude Code stamps it
// `message.model === '<synthetic>'` (verified on the 07:30:06 row above). A
// synthetic reply proves the session was AWAKE and did NOT do the work.

/** Claude Code's marker for a reply it generated itself, with no model call. */
export const SYNTHETIC_MODEL = '<synthetic>'

export type TurnEvidence =
  // A real (non-synthetic) assistant turn followed our prompt.
  | 'real'
  // The only reply after our prompt was the CLI's canned message: quota limit,
  // API error. Awake, and refused -- the task's work never ran.
  | 'synthetic'
  // Our prompt was not found in any readable transcript, or nothing followed
  // it yet. Says nothing; the caller must not read it as failure.
  | 'none'

// How much of the typed prompt is used to recognise OUR injection among every
// session writing into the same projects directory. Short enough to survive
// the chunked send, long enough not to match an unrelated line.
const TURN_MARKER_CHARS = 60

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * What the target session's transcript says about the turn `sentText` was
 * supposed to start, looking only at rows at or after `sinceMs`.
 *
 * Anchored on the PROMPT, not on the directory: the assistant rows that count
 * are the ones in the same file as our own prompt, after it. A sibling session
 * writing into the same projects directory can no longer stand in as evidence
 * that OUR task ran.
 *
 * Never throws: an unreadable directory, file or line is skipped, and the
 * result degrades to 'none'.
 */
export function classifyTurnEvidence(
  dirs: readonly string[],
  sinceMs: number,
  sentText: string | null | undefined,
  opts: {
    /**
     * Upper bound of the window, default "now and anything newer". The live
     * sweep never needs it -- rows after the current moment do not exist yet --
     * but a BACKTEST does: replaying an old injection against today's
     * transcript would otherwise see turns that ran hours later and call a
     * quota-blocked round 'real'. Measured while building this: the
     * 2026-10-14 07:30 round classifies as 'real' without a bound and
     * 'synthetic' with one.
     */
    untilMs?: number
    maxBytes?: number
  } = {},
): TurnEvidence {
  const untilMs = opts.untilMs ?? Number.POSITIVE_INFINITY
  const maxBytes = opts.maxBytes ?? TRANSCRIPT_TAIL_BYTES
  if (sentText == null) return 'none'
  const marker = squash(sentText).slice(0, TURN_MARKER_CHARS)
  if (marker.length === 0) return 'none'
  let best: TurnEvidence = 'none'
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      if (!existsSync(dir)) continue
      const real = realpathSync(dir)
      if (seen.has(real)) continue
      seen.add(real)
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const path = join(dir, f)
      let text: string
      try {
        if (statSync(path).mtimeMs < sinceMs) continue
        text = readTail(path, maxBytes)
      } catch {
        continue
      }
      // Where OUR prompt sits in THIS file. Until it is found, the assistant
      // rows in this file belong to someone else's turn.
      let promptAt: number | null = null
      for (const line of text.split('\n')) {
        if (!line.includes('"user"') && !line.includes('"assistant"')) continue
        let row: { type?: unknown; timestamp?: unknown; message?: { content?: unknown; model?: unknown } }
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof row.timestamp !== 'string') continue
        const ts = Date.parse(row.timestamp)
        if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue
        if (row.type === 'user') {
          if (promptAt != null) continue
          const t = promptText(row.message?.content)
          if (t != null && squash(t).includes(marker)) promptAt = ts
          continue
        }
        if (row.type !== 'assistant' || promptAt == null || ts < promptAt) continue
        if (row.message?.model === SYNTHETIC_MODEL) {
          best = 'synthetic'
          continue
        }
        // One real turn is enough, and it outranks anything synthetic that
        // came before it.
        return 'real'
      }
    }
  }
  return best
}
