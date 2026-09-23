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

// Anchor length: long enough that an 80-char chunk boundary or a stray key
// cannot fake a match, short enough to exist in a tiny prompt.
function anchorLen(text: string): number {
  return Math.max(8, Math.min(64, Math.floor(text.length / 4)))
}

const PASTE_WRAP_RX = /<pasted_content\b/

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
export function classifyDelivery(sent: string, received: readonly string[]): DeliveryVerdict | null {
  const want = sent.trim()
  if (want.length === 0) return null
  const k = anchorLen(want)
  const head = want.slice(0, k)
  const tail = want.slice(-k)
  let headOnly = false
  for (const raw of received) {
    const got = raw.trim()
    const hasHead = got.includes(head)
    const hasTail = got.includes(tail)
    if (!hasTail) {
      if (hasHead) headOnly = true
      continue
    }
    // First prompt carrying our tail: this delivery's submission.
    if (headOnly) return 'split'
    if (got === want) return 'intact'
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

/**
 * Every typed user prompt recorded in `dirs` at or after `sinceMs`, oldest
 * first. Only transcripts modified since `sinceMs` are opened. Unreadable
 * files and malformed lines are skipped.
 */
export function readUserPromptsSince(
  dirs: readonly string[],
  sinceMs: number,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): string[] {
  const hits: Array<{ ts: number; text: string }> = []
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
        if (!line.includes('"user"')) continue
        let row: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row.type !== 'user' || typeof row.timestamp !== 'string') continue
        const ts = Date.parse(row.timestamp)
        if (!Number.isFinite(ts) || ts < sinceMs) continue
        const t = promptText(row.message?.content)
        if (t != null) hits.push({ ts, text: t })
      }
    }
  }
  hits.sort((a, b) => a.ts - b.ts)
  return hits.map((h) => h.text)
}
